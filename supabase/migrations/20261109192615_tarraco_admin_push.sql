begin;

create schema if not exists tarraco_private;
revoke all on schema tarraco_private from public, anon, authenticated;

create table public.tarraco_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  sound boolean not null default true,
  tested_at timestamptz
);

create table public.tarraco_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.tarraco_push_devices(id) on delete cascade,
  kind text not null check (kind in ('pedido','registro','mensaje','reparto','prueba')),
  entity_id uuid not null,
  company_id uuid,
  opened_at timestamptz,
  due_at timestamptz not null default now(),
  round integer not null default 0,
  failures integer not null default 0,
  lease uuid,
  unique (device_id, kind, entity_id)
);

alter table public.tarraco_push_devices enable row level security;
alter table public.tarraco_push_deliveries enable row level security;
revoke all on public.tarraco_push_devices, public.tarraco_push_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.tarraco_push_devices to service_role;
grant select, update on public.tarraco_push_deliveries to service_role;
create index tarraco_push_device_owner on public.tarraco_push_devices(user_id);
create index tarraco_push_device_session on public.tarraco_push_devices(session_id);
create index tarraco_push_due on public.tarraco_push_deliveries(due_at) where opened_at is null;

create table tarraco_private.push_config (
  singleton boolean primary key default true check (singleton),
  public_key text not null,
  url text not null
);
alter table tarraco_private.push_config enable row level security;
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'tarraco_push_worker');

create function public.tarraco_push_configure(p_public text, p_private text, p_url text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  insert into tarraco_private.push_config(public_key, url) values (p_public, p_url)
  on conflict (singleton) do nothing;
  if found then
    perform vault.create_secret(p_private, 'tarraco_push_vapid');
  end if;
  return (select public_key from tarraco_private.push_config);
end;
$$;

create function public.tarraco_push_worker_keys(p_secret text)
returns table(public_key text, private_key text)
language sql stable security definer set search_path = '' as $$
  select c.public_key, k.decrypted_secret
  from tarraco_private.push_config c cross join vault.decrypted_secrets k
  where k.name = 'tarraco_push_vapid' and exists (
    select 1 from vault.decrypted_secrets
    where name = 'tarraco_push_worker' and decrypted_secret = p_secret
  );
$$;

create function public.tarraco_push_admin_session(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.sessions s join public.profiles p on p.id = s.user_id
    where s.id = p_session and s.user_id = p_user and p.role = 'admin'
      and (s.not_after is null or s.not_after > now())
  );
$$;

create function tarraco_private.queue_admin_push()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  event_kind text := tg_argv[0];
  company uuid;
begin
  case event_kind
    when 'pedido' then
      if new.status <> 'pending' then return new; end if;
    when 'registro' then
      if not new.registration_pending then return new; end if;
    when 'mensaje' then
      if new.sender_is_admin then return new; end if;
      company := new.company_id;
    when 'reparto' then
      if nullif(btrim(new.driver_delivery_comment), '') is null or new.driver_delivered_at is null
        or new.driver_delivered_at is not distinct from old.driver_delivered_at then return new; end if;
  end case;
  insert into public.tarraco_push_deliveries(device_id, kind, entity_id, company_id)
  select d.id, event_kind, new.id, company
  from public.tarraco_push_devices d
  join public.profiles p on p.id = d.user_id and p.role = 'admin'
  join auth.sessions s on s.id = d.session_id and s.user_id = d.user_id
  where s.not_after is null or s.not_after > now()
  on conflict (device_id, kind, entity_id) do nothing;
  return new;
end;
$$;

create trigger tarraco_push_order after insert on public.orders
for each row execute function tarraco_private.queue_admin_push('pedido');
create trigger tarraco_push_registration after insert on public.companies
for each row execute function tarraco_private.queue_admin_push('registro');
create trigger tarraco_push_message after insert on public.company_chat_messages
for each row execute function tarraco_private.queue_admin_push('mensaje');
create trigger tarraco_push_delivery after update of driver_delivered_at on public.orders
for each row execute function tarraco_private.queue_admin_push('reparto');

create function public.tarraco_push_test(p_user uuid, p_device uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.tarraco_push_devices
  set tested_at = now()
  where id = p_device and user_id = p_user
    and (tested_at is null or tested_at <= now() - interval '1 minute');
  if not found then return false; end if;
  update public.tarraco_push_deliveries set opened_at = now(), lease = null
  where device_id = p_device and kind = 'prueba' and opened_at is null;
  insert into public.tarraco_push_deliveries(device_id, kind, entity_id, due_at)
  values (p_device, 'prueba', gen_random_uuid(), now() + interval '30 seconds');
  return true;
end;
$$;

create function public.tarraco_push_open(p_delivery uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.tarraco_push_deliveries target
  set opened_at = now(), lease = null
  from public.tarraco_push_deliveries clicked
  join public.tarraco_push_devices source on source.id = clicked.device_id
  join public.tarraco_push_devices other on other.user_id = source.user_id
  where clicked.id = p_delivery and target.device_id = other.id
    and target.kind = clicked.kind and target.entity_id = clicked.entity_id
    and target.opened_at is null;
$$;

create function public.tarraco_push_read(p_user uuid, p_kind text, p_entity uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.tarraco_push_deliveries q
  set opened_at = now(), lease = null
  from public.tarraco_push_devices d
  where d.user_id = p_user and q.device_id = d.id and q.kind = p_kind
    and q.entity_id = p_entity and q.opened_at is null;
$$;

create function public.tarraco_push_claim()
returns table(id uuid, device_id uuid, kind text, entity_id uuid, company_id uuid,
  round integer, failures integer, lease uuid, endpoint text, p256dh text, auth_key text, sound boolean)
language sql security definer set search_path = '' as $$
  with obsolete as (
    update public.tarraco_push_deliveries q set opened_at = now(), lease = null
    from public.tarraco_push_devices d, public.profiles p, auth.sessions s
    where q.opened_at is null and q.device_id = d.id and p.id = d.user_id and s.id = d.session_id
      and (p.role <> 'admin' or s.not_after <= now() or case q.kind
        when 'pedido' then not exists (select 1 from public.orders o where o.id = q.entity_id)
        when 'registro' then not exists (select 1 from public.companies c where c.id = q.entity_id and c.registration_pending)
        when 'mensaje' then not exists (select 1 from public.company_chat_messages m where m.id = q.entity_id and m.read_at is null)
        when 'reparto' then not exists (select 1 from public.orders o where o.id = q.entity_id)
        else false
      end)
  ), due as (
    select q.id
    from public.tarraco_push_deliveries q
    join public.tarraco_push_devices d on d.id = q.device_id
    join public.profiles p on p.id = d.user_id and p.role = 'admin'
    join auth.sessions s on s.id = d.session_id and s.user_id = d.user_id
    where q.opened_at is null and q.due_at <= now()
      and (s.not_after is null or s.not_after > now())
      and case q.kind
        when 'pedido' then exists (select 1 from public.orders o where o.id = q.entity_id)
        when 'registro' then exists (select 1 from public.companies c where c.id = q.entity_id and c.registration_pending)
        when 'mensaje' then exists (select 1 from public.company_chat_messages m where m.id = q.entity_id and m.read_at is null)
        when 'reparto' then exists (select 1 from public.orders o where o.id = q.entity_id)
        else true
      end
    order by q.due_at, q.id limit 12 for update of q skip locked
  ), leased as (
    update public.tarraco_push_deliveries q
    set lease = gen_random_uuid(), due_at = now() + interval '45 seconds'
    from due where q.id = due.id returning q.*
  )
  select q.id, q.device_id, q.kind, q.entity_id, q.company_id,
    q.round, q.failures, q.lease, d.endpoint, d.p256dh, d.auth_key, d.sound
  from leased q join public.tarraco_push_devices d on d.id = q.device_id;
$$;

revoke execute on function
  public.tarraco_push_configure(text,text,text), public.tarraco_push_worker_keys(text),
  public.tarraco_push_admin_session(uuid,uuid), public.tarraco_push_test(uuid,uuid),
  public.tarraco_push_open(uuid), public.tarraco_push_read(uuid,text,uuid), public.tarraco_push_claim()
from public, anon, authenticated;
grant execute on function
  public.tarraco_push_configure(text,text,text), public.tarraco_push_worker_keys(text),
  public.tarraco_push_admin_session(uuid,uuid), public.tarraco_push_test(uuid,uuid),
  public.tarraco_push_open(uuid), public.tarraco_push_read(uuid,text,uuid), public.tarraco_push_claim()
to service_role;
revoke execute on function tarraco_private.queue_admin_push() from public, anon, authenticated;

-- The job is inert until an authenticated administrator initializes push.
select cron.schedule('tarraco-admin-push', '15 seconds', $job$
  select net.http_post(
    url := rtrim(c.url, '/') || '/functions/v1/tarraco-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tarraco-push-worker', k.decrypted_secret),
    body := '{"action":"dispatch"}'::jsonb,
    timeout_milliseconds := 30000
  )
  from tarraco_private.push_config c cross join vault.decrypted_secrets k
  where k.name = 'tarraco_push_worker'
    and exists (select 1 from public.tarraco_push_deliveries where opened_at is null and due_at <= now());
$job$);

commit;
