begin;

alter table public.companies add column registration_rejected_at timestamptz;

create table tarraco_private.registration_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid unique references public.companies(id) on delete set null,
  tracking_hash text unique check (tracking_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'authorized', 'rejected')),
  created_at timestamptz not null default now()
);
create index registration_requests_recent on tarraco_private.registration_requests(created_at);

-- Existing approved accounts are not part of this change. Stop if a legacy pending
-- account already has a session, since an issued JWT can outlive session revocation.
lock table auth.sessions in share row exclusive mode;
do $$
begin
  if exists (
    select 1 from public.companies c
    join public.profiles p on p.company_id = c.id
    join auth.sessions s on s.user_id = p.id
    where c.registration_pending
  ) then
    raise exception 'Revisar primero las sesiones de las solicitudes pendientes anteriores';
  end if;
end;
$$;

insert into tarraco_private.registration_requests(user_id, company_id)
select p.id, c.id
from public.companies c join public.profiles p on p.company_id = c.id and p.role = 'customer'
where c.registration_pending;

-- The old browser signup used user metadata and could initiate an email flow.
drop trigger tarraco_self_registration on auth.users;

create function tarraco_private.reject_legacy_registration() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.raw_user_meta_data->>'tarraco_self_registration' = 'true' then
    raise exception 'Registra tu empresa desde la versión actual del portal';
  end if;
  return new;
end;
$$;
create trigger tarraco_reject_legacy_registration before insert on auth.users
for each row execute function tarraco_private.reject_legacy_registration();

-- Auth adds the server-controlled app metadata during admin.createUser, after INSERT
-- and within the same transaction. The normal user metadata cannot authorize this path.
create or replace function tarraco_private.register_company() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  company_id uuid;
  tracking text := new.raw_app_meta_data->>'tarraco_registration_hash';
  company_name text := btrim(coalesce(new.raw_user_meta_data->>'company_name',''));
  contact_name text := btrim(coalesce(new.raw_user_meta_data->>'contact_name',''));
  phone text := btrim(coalesce(new.raw_user_meta_data->>'contact_phone',''));
begin
  if tracking is null or tracking is not distinct from old.raw_app_meta_data->>'tarraco_registration_hash' then
    return new;
  end if;
  if old.raw_app_meta_data ? 'tarraco_registration_hash' or tracking !~ '^[0-9a-f]{64}$'
    or length(company_name) not between 2 and 120 or length(contact_name) not between 2 and 120
    or length(phone) not between 7 and 25 or new.email is null
    or new.email_confirmed_at is not null then
    raise exception 'Datos de registro inválidos';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(129901, 1);
  if (select count(*) from tarraco_private.registration_requests where created_at > now() - interval '10 minutes') >= 15 then
    raise exception 'Límite temporal de solicitudes de registro';
  end if;
  if exists (select 1 from public.companies where lower(email) = lower(new.email)) then
    raise exception 'El correo ya está asociado a una empresa';
  end if;

  insert into public.companies(name, contact_name, email, phone, active, registration_pending)
  values (company_name, contact_name, new.email, phone, false, true) returning id into company_id;
  insert into public.profiles(id, role, company_id, display_name)
  values (new.id, 'customer', company_id, contact_name);
  insert into tarraco_private.registration_requests(user_id, company_id, tracking_hash)
  values (new.id, company_id, tracking);
  insert into public.tarraco_telegram_outbox(kind, entity_id) values ('registration', company_id);
  return new;
end;
$$;
create trigger tarraco_self_registration after update of raw_app_meta_data on auth.users
for each row execute function tarraco_private.register_company();

create function tarraco_private.guard_company_registration() returns trigger
language plpgsql security definer set search_path = '' as $$
declare decision text;
begin
  select state into decision from tarraco_private.registration_requests where company_id = new.id;
  if decision is not null and (
    (decision <> 'authorized' and new.active)
    or (decision <> 'authorized' and new.email is distinct from old.email)
    or (new.registration_pending <> (decision = 'pending'))
    or ((new.registration_rejected_at is not null) <> (decision = 'rejected'))
  ) then
    raise exception 'Resuelve el registro desde Telegram';
  end if;
  return new;
end;
$$;
create trigger tarraco_guard_company_registration
before update of active, email, registration_pending, registration_rejected_at on public.companies
for each row execute function tarraco_private.guard_company_registration();

create function tarraco_private.guard_registration_credentials() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from tarraco_private.registration_requests
    where user_id = new.id and state <> 'authorized'
  ) and (
    new.email is distinct from old.email
    or new.phone is distinct from old.phone
    or new.email_confirmed_at is distinct from old.email_confirmed_at
    or new.phone_confirmed_at is distinct from old.phone_confirmed_at
    or new.encrypted_password is distinct from old.encrypted_password
  ) then
    raise exception 'El registro requiere autorización en Telegram';
  end if;
  return new;
end;
$$;
create trigger tarraco_guard_registration_credentials
before update of email, phone, email_confirmed_at, phone_confirmed_at, encrypted_password on auth.users
for each row execute function tarraco_private.guard_registration_credentials();

create function tarraco_private.guard_registration_session() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from tarraco_private.registration_requests where user_id = new.user_id and state <> 'authorized'
  ) then
    raise exception 'El registro requiere autorización en Telegram';
  end if;
  return new;
end;
$$;
create trigger tarraco_guard_registration_session before insert on auth.sessions
for each row execute function tarraco_private.guard_registration_session();

create function public.tarraco_registration_status(p_hash text) returns text
language sql stable security definer set search_path = '' as $$
  select case when c.id is null or (r.state = 'authorized' and not c.active) then 'unavailable' else r.state end
  from tarraco_private.registration_requests r
  left join public.companies c on c.id = r.company_id
  where r.tracking_hash = p_hash
$$;

create function public.tarraco_decide_registration(p_company uuid, p_approve boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  request tarraco_private.registration_requests%rowtype;
  decision text := case when p_approve then 'authorized' else 'rejected' end;
begin
  select * into request from tarraco_private.registration_requests
  where company_id = p_company for update;
  if not found or p_approve is null then return null; end if;
  if request.state <> 'pending' then return request.state; end if;

  if p_approve and not exists (
    select 1 from public.profiles where id = request.user_id and company_id = p_company and role = 'customer'
  ) then
    raise exception 'El usuario ya no está vinculado a la empresa';
  end if;

  update tarraco_private.registration_requests set state = decision where user_id = request.user_id;
  update public.companies set active = p_approve, registration_pending = false,
    registration_rejected_at = case when p_approve then null else now() end
  where id = p_company and registration_pending and not active;
  if not found then raise exception 'La solicitud ya no está disponible'; end if;

  if p_approve then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()),
      confirmation_token = '', recovery_token = '', updated_at = now()
    where id = request.user_id and deleted_at is null;
    if not found then raise exception 'El usuario de la solicitud ya no existe'; end if;
    delete from auth.one_time_tokens where user_id = request.user_id;
  end if;
  return decision;
end;
$$;

revoke all on function public.tarraco_registration_status(text) from public, anon, authenticated;
revoke all on function public.tarraco_decide_registration(uuid, boolean) from public, anon, authenticated;
grant execute on function public.tarraco_registration_status(text) to service_role;
grant execute on function public.tarraco_decide_registration(uuid, boolean) to service_role;
revoke all on function tarraco_private.reject_legacy_registration(), tarraco_private.register_company(),
  tarraco_private.guard_company_registration(), tarraco_private.guard_registration_credentials(),
  tarraco_private.guard_registration_session() from public, anon, authenticated;

-- New decisions are communicated through Telegram and the portal.
drop trigger tarraco_queue_registration_approval on public.companies;

commit;
