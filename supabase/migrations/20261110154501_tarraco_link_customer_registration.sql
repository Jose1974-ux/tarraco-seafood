begin;

-- Depends on the Telegram-only registration migration already applied to TARRACO.
alter table tarraco_private.registration_requests
  add column notice_id uuid unique,
  add column restaurant_name text,
  add column tax_id text,
  add column phone text,
  add column customer_code text,
  add column new_customer boolean not null default false,
  add column candidate_company_id uuid references public.companies(id) on delete set null,
  add column link_state text check (link_state in ('matched', 'review', 'new')),
  add column code_attempts integer not null default 0;

alter table public.tarraco_telegram_outbox
  drop constraint tarraco_telegram_outbox_kind_check,
  add constraint tarraco_telegram_outbox_kind_check check (
    kind in ('chat','registration','registration_authorized','order_received_request','order_updated','registration_link')
  );

create function tarraco_private.registration_key(value text)
returns text language sql immutable strict set search_path = '' as $$
  select regexp_replace(
    translate(upper(value), 'ÁÀÄÉÈËÍÌÏÓÒÖÚÙÜÇÑ', 'AAAEEEIIIOOOUUUCN'),
    '[^A-Z0-9]', '', 'g'
  )
$$;

create function tarraco_private.registration_tax(value text)
returns text language sql immutable strict set search_path = '' as $$
  select regexp_replace(tarraco_private.registration_key(value), '^ES([A-Z0-9]{9})$', '\1')
$$;

create function tarraco_private.registration_phone(value text)
returns text language sql immutable strict set search_path = '' as $$
  select regexp_replace(regexp_replace(value, '[^0-9]', '', 'g'), '^(0034|34)([0-9]{9})$', '\2')
$$;

create function tarraco_private.registration_code(value text)
returns text language sql immutable strict set search_path = '' as $$
  select case when value ~ '^[0-9. ]+$' then regexp_replace(value, '[. ]', '', 'g')
    else upper(btrim(value)) end
$$;

create function tarraco_private.registration_proposal(
  p_name text, p_tax text, p_phone text, p_code text, p_email text, p_new boolean
)
returns table(link_state text, candidate uuid)
language plpgsql stable set search_path = '' as $$
declare
  name_key text := tarraco_private.registration_key(p_name);
  tax_key text := tarraco_private.registration_tax(p_tax);
  phone_key text := tarraco_private.registration_phone(p_phone);
  code_key text := nullif(tarraco_private.registration_code(p_code), '');
  matches uuid[];
begin
  if p_new then
    if code_key is null and not exists (
      select 1 from public.companies c
      where tax_key = tarraco_private.registration_tax(c.tax_id)
        or name_key in (tarraco_private.registration_key(c.name), tarraco_private.registration_key(c.trade_name))
        or phone_key = tarraco_private.registration_phone(c.phone)
    ) then
      return query select 'new'::text, null::uuid;
    else
      return query select 'review'::text, null::uuid;
    end if;
    return;
  end if;

  -- Determine uniqueness across all fiches before excluding blocked or occupied ones.
  select array_agg(c.id) into matches
  from public.companies c
  where tax_key = tarraco_private.registration_tax(c.tax_id)
    and name_key in (tarraco_private.registration_key(c.name), tarraco_private.registration_key(c.trade_name))
    and case when code_key is not null then code_key = tarraco_private.registration_code(c.customer_code)
      else phone_key = tarraco_private.registration_phone(c.phone) end;

  if cardinality(matches) = 1 and exists (
    select 1 from public.companies c
    where c.id = matches[1] and c.customer_code is not null and not c.active
      and c.archived_at is null and not c.registration_pending and c.registration_rejected_at is null
      and (nullif(btrim(c.email), '') is null or lower(btrim(c.email)) = lower(p_email))
      and not exists (select 1 from public.profiles p where p.company_id = c.id)
      and not exists (select 1 from tarraco_private.registration_requests r where r.company_id = c.id)
  ) then
    return query select 'matched'::text, matches[1];
  else
    return query select 'review'::text, null::uuid;
  end if;
end;
$$;

create function tarraco_private.register_link_request()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  tracking text := new.raw_app_meta_data->>'tarraco_link_registration_hash';
  restaurant text := btrim(coalesce(new.raw_user_meta_data->>'restaurant_name', ''));
  fiscal text := btrim(coalesce(new.raw_user_meta_data->>'tax_id', ''));
  telephone text := btrim(coalesce(new.raw_user_meta_data->>'contact_phone', ''));
  code text := nullif(btrim(new.raw_user_meta_data->>'customer_code'), '');
  is_new boolean := new.raw_user_meta_data->>'new_customer' is not distinct from 'true';
  notice uuid := gen_random_uuid();
  proposal record;
begin
  if tracking is null or tracking is not distinct from old.raw_app_meta_data->>'tarraco_link_registration_hash' then
    return new;
  end if;
  if old.raw_app_meta_data ? 'tarraco_link_registration_hash'
    or new.raw_app_meta_data ? 'tarraco_registration_hash'
    or tracking !~ '^[0-9a-f]{64}$'
    or length(restaurant) not between 2 and 120
    or length(tarraco_private.registration_key(restaurant)) < 2
    or length(fiscal) > 20 or length(tarraco_private.registration_tax(fiscal)) not between 6 and 15
    or length(telephone) > 25 or telephone !~ '^[+0-9 .()-]+$'
    or length(tarraco_private.registration_phone(telephone)) not between 7 and 15
    or length(code) > 40 or (is_new and code is not null)
    or new.email is null or new.email_confirmed_at is not null
    or exists (select 1 from public.profiles p where p.id = new.id)
  then raise exception 'Datos de registro inválidos';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(129901, 1);
  if (select count(*) from tarraco_private.registration_requests where created_at > now() - interval '10 minutes') >= 15 then
    raise exception 'Límite temporal de solicitudes de registro';
  end if;
  select * into proposal from tarraco_private.registration_proposal(restaurant, fiscal, telephone, code, new.email, is_new);
  insert into tarraco_private.registration_requests(
    user_id, tracking_hash, notice_id, restaurant_name, tax_id, phone,
    customer_code, new_customer, candidate_company_id, link_state
  ) values (
    new.id, tracking, notice, restaurant, fiscal, telephone,
    code, is_new, proposal.candidate, proposal.link_state
  );
  insert into public.tarraco_telegram_outbox(kind, entity_id) values ('registration_link', notice);
  return new;
end;
$$;

create trigger tarraco_link_registration after update of raw_app_meta_data on auth.users
for each row execute function tarraco_private.register_link_request();

create or replace function public.tarraco_registration_status(p_hash text)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when r.link_state is not null and r.state = 'pending' and r.link_state = 'review'
      then case when r.code_attempts < 3 then 'needs_code' else 'review' end
    when r.link_state is not null and r.state = 'pending' then 'pending'
    when r.state = 'rejected' and r.link_state is not null then 'rejected'
    when c.id is null or (r.state = 'authorized' and not c.active) then 'unavailable'
    else r.state
  end
  from tarraco_private.registration_requests r
  left join public.companies c on c.id = r.company_id
  where r.tracking_hash = p_hash
$$;

create function public.tarraco_registration_add_code(p_hash text, p_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  request tarraco_private.registration_requests%rowtype;
  proposal record;
  email text;
  notice uuid := gen_random_uuid();
begin
  if p_code is null or btrim(p_code) !~ '^[[:alnum:]][[:alnum:]. -]{0,39}$' then
    return public.tarraco_registration_status(p_hash);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(129901, 1);
  select * into request from tarraco_private.registration_requests r
  where r.tracking_hash = p_hash for update;
  if not found or request.state <> 'pending' or request.link_state is distinct from 'review'
    or request.code_attempts >= 3 then
    return public.tarraco_registration_status(p_hash);
  end if;
  select u.email into email from auth.users u where u.id = request.user_id and u.deleted_at is null;
  if not found then return 'unavailable'; end if;
  select * into proposal from tarraco_private.registration_proposal(
    request.restaurant_name, request.tax_id, request.phone, p_code, email, false
  );
  update tarraco_private.registration_requests
  set customer_code = btrim(p_code), code_attempts = code_attempts + 1, new_customer = false,
    candidate_company_id = proposal.candidate, link_state = proposal.link_state,
    notice_id = case when proposal.link_state = 'matched' then notice else request.notice_id end
  where user_id = request.user_id;
  if proposal.link_state = 'matched' then
    insert into public.tarraco_telegram_outbox(kind, entity_id) values ('registration_link', notice);
  end if;
  return public.tarraco_registration_status(p_hash);
end;
$$;

create function public.tarraco_registration_link_notice(p_notice uuid)
returns table(
  name text, tax_id text, phone text, email text, link_state text,
  candidate_name text, candidate_code text, state text
)
language sql stable security definer set search_path = '' as $$
  select r.restaurant_name, r.tax_id, r.phone, u.email, r.link_state,
    coalesce(nullif(c.trade_name,''),c.name), c.customer_code, r.state
  from tarraco_private.registration_requests r
  join auth.users u on u.id = r.user_id and u.deleted_at is null
  left join public.companies c on c.id = coalesce(r.company_id,r.candidate_company_id)
  where r.notice_id = p_notice
$$;

create function public.tarraco_decide_registration_link(p_notice uuid, p_approve boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  request tarraco_private.registration_requests%rowtype;
  company uuid;
  account_email text;
  proposal record;
begin
  if p_approve is null then return null; end if;
  perform pg_catalog.pg_advisory_xact_lock(129901, 1);
  select * into request from tarraco_private.registration_requests r
  where r.notice_id = p_notice for update;
  if not found then return null; end if;
  if request.state <> 'pending' then return request.state; end if;
  if not p_approve then
    update tarraco_private.registration_requests set state = 'rejected' where user_id = request.user_id;
    return 'rejected';
  end if;
  if request.link_state = 'review' then return 'review'; end if;

  if request.candidate_company_id is not null then
    perform 1 from public.companies where id = request.candidate_company_id for update;
  end if;
  select u.email into account_email from auth.users u
    where u.id = request.user_id and u.deleted_at is null and u.email_confirmed_at is null for update;
  if not found then return null; end if;
  select * into proposal from tarraco_private.registration_proposal(
    request.restaurant_name, request.tax_id, request.phone, request.customer_code, account_email, request.new_customer
  );
  if proposal.link_state is distinct from request.link_state
    or proposal.candidate is distinct from request.candidate_company_id then
    update tarraco_private.registration_requests
    set link_state = 'review', candidate_company_id = null where user_id = request.user_id;
    return 'review';
  end if;
  if request.link_state = 'new' then
    insert into public.companies(name, tax_id, phone, email, customer_code, active)
    values (request.restaurant_name, request.tax_id, request.phone, account_email, 'WEB-' || upper(gen_random_uuid()::text), true)
    returning id into company;
  else
    company := request.candidate_company_id;
    update public.companies c set active = true, email = coalesce(nullif(btrim(c.email), ''), account_email)
    where c.id = company;
  end if;
  insert into public.profiles(id, role, company_id, display_name)
    values (request.user_id, 'customer', company, request.restaurant_name);
  update tarraco_private.registration_requests set state = 'authorized', company_id = company
    where user_id = request.user_id;
  update auth.users set email_confirmed_at = now(), confirmation_token = '', recovery_token = '', updated_at = now()
    where id = request.user_id;
  delete from auth.one_time_tokens where user_id = request.user_id;
  return 'authorized';
end;
$$;

create function public.tarraco_pending_registration_links()
returns table(
  id uuid, name text, tax_id text, phone text, email text, created_at timestamptz,
  link_state text, candidate_name text, candidate_code text, candidate_company_id uuid
)
language sql stable security definer set search_path = '' as $$
  select r.notice_id, r.restaurant_name, r.tax_id, r.phone, u.email, r.created_at,
    r.link_state, coalesce(nullif(c.trade_name,''),c.name), c.customer_code, c.id
  from tarraco_private.registration_requests r
  join auth.users u on u.id = r.user_id and u.deleted_at is null
  left join public.companies c on c.id = r.candidate_company_id
  where (select public.is_admin()) and r.notice_id is not null and r.state = 'pending'
  order by r.created_at desc
$$;

revoke all on function tarraco_private.registration_key(text), tarraco_private.registration_tax(text),
  tarraco_private.registration_phone(text), tarraco_private.registration_code(text),
  tarraco_private.registration_proposal(text,text,text,text,text,boolean),
  tarraco_private.register_link_request() from public, anon, authenticated;
revoke all on function public.tarraco_registration_add_code(text,text),
  public.tarraco_registration_link_notice(uuid), public.tarraco_decide_registration_link(uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.tarraco_registration_add_code(text,text),
  public.tarraco_registration_link_notice(uuid), public.tarraco_decide_registration_link(uuid,boolean) to service_role;
revoke all on function public.tarraco_pending_registration_links() from public, anon;
grant execute on function public.tarraco_pending_registration_links() to authenticated;

commit;
