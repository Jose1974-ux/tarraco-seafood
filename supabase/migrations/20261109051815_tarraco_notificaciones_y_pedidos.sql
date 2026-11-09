begin;

alter table public.companies add column registration_pending boolean not null default false;
update public.companies c set registration_pending = true
where not c.active and exists (
  select 1 from public.profiles p join auth.users u on u.id = p.id
  where p.company_id = c.id and u.raw_user_meta_data->>'tarraco_self_registration' = 'true'
);
alter table public.companies add constraint companies_pending_inactive check (not registration_pending or not active);

create schema if not exists tarraco_private;
revoke all on schema tarraco_private from public, anon, authenticated;

create table public.tarraco_telegram_outbox (
  kind text not null check (kind in ('chat', 'registration')),
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  sent_at timestamptz,
  last_error text,
  primary key (kind, entity_id)
);
alter table public.tarraco_telegram_outbox enable row level security;
revoke all on public.tarraco_telegram_outbox from public, anon, authenticated;
grant select, update on public.tarraco_telegram_outbox to service_role;
create index tarraco_telegram_outbox_due on public.tarraco_telegram_outbox(next_attempt_at) where sent_at is null;

create function tarraco_private.clear_registration_pending() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.active then new.registration_pending := false; end if;
  return new;
end;
$$;
create trigger clear_registration_pending before update of active on public.companies
for each row execute function tarraco_private.clear_registration_pending();

create or replace function public.handle_customer_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
declare matched_company uuid;
begin
  if new.raw_user_meta_data->>'tarraco_self_registration' = 'true' then return new; end if;
  select id into matched_company from public.companies
  where lower(email) = lower(new.email) and active limit 1;
  if matched_company is not null then
    insert into public.profiles (id, role, company_id, display_name)
    values (new.id, 'customer', matched_company, coalesce(new.raw_user_meta_data->>'display_name', new.email))
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

create function tarraco_private.register_company() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  company_id uuid;
  company_name text := btrim(coalesce(new.raw_user_meta_data->>'company_name',''));
  contact_name text := btrim(coalesce(new.raw_user_meta_data->>'contact_name',''));
  phone text := btrim(coalesce(new.raw_user_meta_data->>'contact_phone',''));
begin
  if new.raw_user_meta_data->>'tarraco_self_registration' is distinct from 'true' then return new; end if;
  if length(company_name) not between 2 and 120 or length(contact_name) not between 2 and 120
    or length(phone) not between 7 and 25 or new.email is null then
    raise exception 'Datos de registro incompletos';
  end if;
  if exists (select 1 from public.companies where lower(email) = lower(new.email)) then
    raise exception 'El correo ya está asociado a una empresa';
  end if;
  insert into public.companies(name, contact_name, email, phone, active, registration_pending)
  values (company_name, contact_name, new.email, phone, false, true) returning id into company_id;
  insert into public.profiles(id, role, company_id, display_name)
  values (new.id, 'customer', company_id, contact_name);
  insert into public.tarraco_telegram_outbox(kind, entity_id) values ('registration', company_id);
  return new;
end;
$$;
drop trigger if exists tarraco_self_registration on auth.users;
create trigger tarraco_self_registration after insert on auth.users
for each row execute function tarraco_private.register_company();

alter table public.company_chat_messages add column sender_is_admin boolean not null default false;
update public.company_chat_messages m set sender_is_admin = true
from public.profiles p where p.id = m.sender_id and p.role = 'admin';
create index tarraco_chat_unread on public.company_chat_messages(sender_is_admin, company_id)
where read_at is null;

create function tarraco_private.prepare_chat() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.sender_is_admin := public.is_admin();
  new.created_at := now();
  new.read_at := null;
  return new;
end;
$$;
create trigger tarraco_prepare_chat before insert on public.company_chat_messages
for each row execute function tarraco_private.prepare_chat();

create function tarraco_private.queue_chat() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.sender_is_admin then
    insert into public.tarraco_telegram_outbox(kind, entity_id) values ('chat', new.id);
  end if;
  return new;
end;
$$;
create trigger tarraco_queue_chat after insert on public.company_chat_messages
for each row execute function tarraco_private.queue_chat();

create function public.tarraco_chat_unread()
returns table(company_id uuid, unread_count bigint)
language sql stable security invoker set search_path = '' as $$
  select m.company_id, count(*) from public.company_chat_messages m
  where m.read_at is null and m.sender_is_admin <> public.is_admin() and m.sender_id <> auth.uid()
  group by m.company_id
$$;
revoke all on function public.tarraco_chat_unread() from public, anon;
grant execute on function public.tarraco_chat_unread() to authenticated;

-- Restrict UPDATE to the receipt column and to messages received by the caller.
revoke update on public.company_chat_messages from public, anon, authenticated;
grant update(read_at) on public.company_chat_messages to authenticated;
create policy tarraco_chat_mark_read on public.company_chat_messages for update to authenticated
using (
  read_at is null and sender_id <> (select auth.uid()) and (
    (not sender_is_admin and (select public.is_admin()))
    or (sender_is_admin and company_id = (select public.my_company_id())
        and exists (select 1 from public.companies c where c.id = company_id and c.active))
  )
)
with check (read_at is not null);

create policy tarraco_active_chat on public.company_chat_messages as restrictive for all to authenticated
using ((select public.is_admin()) or exists (select 1 from public.companies c where c.id = company_id and c.active))
with check ((select public.is_admin()) or exists (select 1 from public.companies c where c.id = company_id and c.active));

create policy tarraco_active_order_insert on public.orders as restrictive for insert to authenticated
with check ((select public.is_admin()) or exists (select 1 from public.companies c where c.id = company_id and c.active));

create function public.tarraco_order_window()
returns table(earliest date, after_cutoff boolean, cutoff_time time, min_lead_days integer)
language sql stable security invoker set search_path = '' as $$
  select n.local_now::date + case when cfg.enabled then cfg.min_lead_days
      + (n.local_now::time >= cfg.cutoff_time)::int else 0 end,
    coalesce(cfg.enabled and n.local_now::time >= cfg.cutoff_time, false),
    case when cfg.enabled then cfg.cutoff_time end,
    case when cfg.enabled then cfg.min_lead_days end
  from (select now() at time zone 'Europe/Madrid' as local_now) n
  left join public.order_cutoff_settings cfg on cfg.id = 1
$$;
revoke all on function public.tarraco_order_window() from public, anon;
grant execute on function public.tarraco_order_window() to authenticated, service_role;

create or replace function public.enforce_order_cutoff() returns trigger
language plpgsql set search_path = '' as $$
declare cutoff record;
begin
  if public.is_admin() then return new; end if;
  if tg_op = 'UPDATE' and new.requested_date is not distinct from old.requested_date then return new; end if;
  select * into cutoff from public.tarraco_order_window();
  if cutoff.cutoff_time is not null and (new.requested_date is null or new.requested_date < cutoff.earliest) then
    raise exception 'Fecha de entrega no disponible. Selecciona una fecha a partir del %', to_char(cutoff.earliest, 'DD/MM/YYYY');
  end if;
  return new;
end;
$$;

create function public.tarraco_place_order(
  p_id uuid, p_fulfilment text, p_date date, p_notes text, p_items jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  customer uuid := auth.uid();
  company uuid := public.my_company_id();
  inserted uuid;
begin
  if customer is null or company is null then raise exception 'Inicia sesión como cliente'; end if;
  if exists (select 1 from public.orders where id = p_id and created_by = customer and company_id = company)
    then return p_id;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Añade al menos un producto';
  end if;
  insert into public.orders(id, company_id, created_by, status, fulfilment, requested_date, customer_notes)
  values (p_id, company, customer, 'pending', p_fulfilment, p_date, p_notes)
  on conflict (id) do nothing returning id into inserted;
  if inserted is null then
    if exists (select 1 from public.orders where id = p_id and created_by = customer and company_id = company)
      then return p_id;
    end if;
    raise exception 'No se pudo asignar la referencia del pedido';
  end if;
  insert into public.order_items(order_id, product_id, product_name_snapshot, unit_snapshot, quantity, unit_price_snapshot, preparation_notes)
  select inserted, item.product_id, item.product_name_snapshot, item.unit_snapshot, item.quantity, item.unit_price_snapshot, item.preparation_notes
  from jsonb_to_recordset(p_items) as item(product_id uuid, product_name_snapshot text, unit_snapshot text, quantity numeric, unit_price_snapshot numeric, preparation_notes text);
  return inserted;
end;
$$;
revoke all on function public.tarraco_place_order(uuid,text,date,text,jsonb) from public, anon;
grant execute on function public.tarraco_place_order(uuid,text,date,text,jsonb) to authenticated;

create function public.tarraco_claim_telegram()
returns setof public.tarraco_telegram_outbox language sql security invoker set search_path = '' as $$
  update public.tarraco_telegram_outbox q
  set attempts = q.attempts + 1, next_attempt_at = now() + interval '3 minutes'
  where (q.kind, q.entity_id) in (
    select kind, entity_id from public.tarraco_telegram_outbox
    where sent_at is null and next_attempt_at <= now()
    order by next_attempt_at limit 10 for update skip locked
  )
  returning q.*
$$;
revoke all on function public.tarraco_claim_telegram() from public, anon, authenticated;
grant execute on function public.tarraco_claim_telegram() to service_role;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'tarraco_telegram_worker');
create function public.tarraco_telegram_worker_authorized(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets
    where name = 'tarraco_telegram_worker' and decrypted_secret = p_secret)
$$;
revoke all on function public.tarraco_telegram_worker_authorized(text) from public, anon, authenticated;
grant execute on function public.tarraco_telegram_worker_authorized(text) to service_role;

commit;
