begin;

alter table public.orders add column tarraco_received_at timestamptz;
alter table public.tarraco_telegram_outbox add column order_snapshot jsonb;
alter table public.tarraco_telegram_outbox
  drop constraint tarraco_telegram_outbox_kind_check,
  add constraint tarraco_telegram_outbox_kind_check
    check (kind in ('chat', 'registration', 'registration_authorized', 'order_received_request', 'order_updated'));

-- Reuse the existing status and delivery date. Historical rows are left as recorded.
create function tarraco_private.ship_today_orders(p_now timestamptz) returns integer
language plpgsql set search_path = '' as $$
declare
  madrid_now timestamp := p_now at time zone 'Europe/Madrid';
  shipped_count integer;
begin
  if madrid_now::time < time '08:00' or madrid_now::time >= time '09:00' then
    return 0;
  end if;
  update public.orders
  set status = 'shipped', updated_at = p_now
  where requested_date = madrid_now::date
    and status in ('pending', 'confirmed', 'preparing', 'ready_for_pickup');
  get diagnostics shipped_count = row_count;
  return shipped_count;
end;
$$;
revoke all on function tarraco_private.ship_today_orders(timestamptz) from public, anon, authenticated;

-- pg_cron schedules in UTC on this project. Only one invocation matches 08:00 Madrid.
select cron.schedule('tarraco-enviar-pedidos-0800', '0 6,7 * * *',
  $job$select tarraco_private.ship_today_orders(statement_timestamp())$job$);

create function public.tarraco_confirm_order_reception(p_order uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare result text;
begin
  update public.orders set status = 'preparing',
    tarraco_received_at = coalesce(tarraco_received_at, statement_timestamp()),
    updated_at = statement_timestamp()
  where id = p_order and status in ('pending', 'confirmed', 'preparing')
    and tarraco_received_at is null
  returning status into result;
  if found then return result; end if;
  select status into result from public.orders where id = p_order;
  return result;
end;
$$;
revoke all on function public.tarraco_confirm_order_reception(uuid) from public, anon, authenticated;
grant execute on function public.tarraco_confirm_order_reception(uuid) to service_role;

create function tarraco_private.guard_customer_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user <> 'authenticated' or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.requested_date is null then raise exception 'Selecciona la fecha de entrega.'; end if;
    if new.requested_date < (statement_timestamp() at time zone 'Europe/Madrid')::date then
      raise exception 'Selecciona una fecha de entrega válida.';
    end if;
    if new.tarraco_received_at is not null then raise exception 'Confirmación reservada a TARRACO.'; end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status','fulfilment','requested_date','customer_notes','updated_at','customer_changes_at','changes_confirmed_at'])
     is distinct from
     (to_jsonb(old) - array['status','fulfilment','requested_date','customer_notes','updated_at','customer_changes_at','changes_confirmed_at'])
     or (new.status is distinct from old.status
         and not (new.status = 'cancelled' and old.status in ('pending','confirmed','preparing','ready_for_pickup'))
         and not (old.status = 'shipped' and new.status = 'delivered')) then
    raise exception 'Acción reservada a TARRACO.';
  end if;
  if old.status = 'shipped' and (new.fulfilment, new.requested_date, new.customer_notes, new.customer_changes_at, new.changes_confirmed_at)
     is distinct from (old.fulfilment, old.requested_date, old.customer_notes, old.customer_changes_at, old.changes_confirmed_at) then
    raise exception 'El pedido ya no admite modificaciones.';
  end if;
  if new.requested_date is distinct from old.requested_date and
     (new.requested_date is null or new.requested_date < (statement_timestamp() at time zone 'Europe/Madrid')::date) then
    raise exception 'Selecciona una fecha de entrega válida.';
  end if;
  return new;
end;
$$;
create trigger tarraco_guard_customer_order before insert or update on public.orders
for each row execute function tarraco_private.guard_customer_order();

alter policy orders_customer_update_own_pending on public.orders
  using (company_id = public.my_company_id() and created_by = (select auth.uid())
    and status in ('pending','confirmed','preparing','ready_for_pickup')
    and exists (select 1 from public.companies c where c.id = company_id and c.active))
  with check (company_id = public.my_company_id() and created_by = (select auth.uid())
    and status in ('pending','confirmed','preparing','ready_for_pickup','cancelled'));

-- One shared predicate keeps the legacy creation route and editor RLS in sync.
create function public.tarraco_can_edit_order(p_order uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.orders o join public.companies c on c.id = o.company_id
    where o.id = p_order and o.created_by = (select auth.uid())
      and o.company_id = public.my_company_id() and c.active
      and o.status in ('pending','confirmed','preparing','ready_for_pickup')
  )
$$;
revoke all on function public.tarraco_can_edit_order(uuid) from public, anon;
grant execute on function public.tarraco_can_edit_order(uuid) to authenticated;
alter policy order_items_customer_create_own_pending on public.order_items to authenticated
  with check (public.tarraco_can_edit_order(order_id));
alter policy order_items_customer_insert_own_pending on public.order_items
  with check (public.tarraco_can_edit_order(order_id));
alter policy order_items_customer_update_own_pending on public.order_items
  using (public.tarraco_can_edit_order(order_id))
  with check (public.tarraco_can_edit_order(order_id));
alter policy order_items_customer_delete_own_pending on public.order_items
  using (public.tarraco_can_edit_order(order_id));

create function tarraco_private.queue_order_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.tarraco_telegram_outbox(kind, entity_id) values ('order_received_request', new.id);
  elsif new.customer_changes_at is not null and new.customer_changes_at is distinct from old.customer_changes_at then
    insert into public.tarraco_telegram_outbox(kind, entity_id, order_snapshot)
    select 'order_updated', gen_random_uuid(), jsonb_build_object(
      'id', new.id, 'company_id', new.company_id, 'created_at', new.created_at,
      'status', new.status, 'requested_date', new.requested_date, 'fulfilment', new.fulfilment,
      'customer_notes', new.customer_notes, 'changed_at', new.customer_changes_at,
      'items', coalesce((select jsonb_agg(jsonb_build_object(
        'product_name_snapshot', i.product_name_snapshot, 'unit_snapshot', i.unit_snapshot,
        'quantity', i.quantity, 'preparation_notes', i.preparation_notes
      ) order by i.id) from public.order_items i where i.order_id = new.id), '[]'::jsonb)
    );
  end if;
  return new;
end;
$$;
revoke all on function tarraco_private.queue_order_event() from public, anon, authenticated;
create trigger tarraco_order_event after insert or update of customer_changes_at on public.orders
for each row execute function tarraco_private.queue_order_event();

create function public.tarraco_edit_order(
  p_order uuid, p_expected_change timestamptz, p_fulfilment text, p_date date, p_notes text, p_items jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  target public.orders%rowtype;
  existing public.order_items%rowtype;
  item record;
  saved_id uuid;
  keep uuid[] := '{}';
  price numeric;
  product_name text;
begin
  select * into target from public.orders where id = p_order and created_by = auth.uid() for update;
  if not found or not public.tarraco_can_edit_order(p_order) then
    raise exception using errcode = 'PT409', message = 'El pedido ya no admite modificaciones.';
  end if;
  if target.customer_changes_at is distinct from p_expected_change then
    raise exception using errcode = 'PT409', message = 'El pedido se modificó en otra sesión. Vuelve a abrirlo para ver sus cambios.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'El pedido debe tener al menos un producto.';
  end if;
  for item in select * from jsonb_to_recordset(p_items)
    as x(id uuid, product_id uuid, unit_snapshot text, quantity numeric, preparation_notes text)
  loop
    if item.quantity is null or item.quantity <= 0 or item.quantity::text in ('NaN','Infinity','-Infinity') then
      raise exception 'Revisa la cantidad de cada artículo.';
    end if;
    if item.id is not null then
      select * into existing from public.order_items where id = item.id and order_id = p_order;
      if not found or item.id = any(keep) then raise exception 'Línea de pedido no válida.'; end if;
      if (existing.product_id, existing.unit_snapshot) is not distinct from (item.product_id, item.unit_snapshot)
        and (existing.quantity, existing.preparation_notes) is not distinct from (item.quantity, item.preparation_notes) then
        keep := array_append(keep, item.id);
        continue;
      end if;
    end if;

    -- Existing lines can keep their original product and unit, even if the catalogue changed.
    if item.id is not null and (existing.product_id, existing.unit_snapshot) is not distinct from (item.product_id, item.unit_snapshot) then
      if item.quantity > existing.quantity and not exists (
        select 1 from public.products p where p.id = item.product_id and p.active
          and p.available_for_order is distinct from false
          and item.unit_snapshot = any(coalesce(p.enabled_units, array[p.unit]))
      ) then raise exception 'El artículo o unidad ya no está disponible para aumentar la cantidad.'; end if;
      update public.order_items set quantity = item.quantity, preparation_notes = item.preparation_notes
        where id = item.id and order_id = p_order returning id into saved_id;
    else
      select p.name, coalesce(t.price, case
        when p.offer_price is not null and (p.offer_until is null or p.offer_until >= (statement_timestamp() at time zone 'UTC')::date)
          and coalesce(o.allowed,true) then p.offer_price else p.default_price end, 0)
        into product_name, price
      from public.products p
      left join public.company_prices t on t.product_id = p.id and t.company_id = target.company_id
      left join public.my_targeted_offers() o on o.product_id = p.id
      where p.id = item.product_id and p.active and p.available_for_order is distinct from false
        and item.unit_snapshot = any(coalesce(p.enabled_units, array[p.unit]));
      if not found then raise exception 'El artículo o unidad ya no está disponible.'; end if;
      if item.id is null then
        insert into public.order_items(order_id, product_id, product_name_snapshot, unit_snapshot, quantity, unit_price_snapshot, preparation_notes)
        values (p_order, item.product_id, product_name, item.unit_snapshot, item.quantity, price, item.preparation_notes)
        returning id into saved_id;
      else
        update public.order_items set product_id = item.product_id, product_name_snapshot = product_name,
          unit_snapshot = item.unit_snapshot, quantity = item.quantity, unit_price_snapshot = price, preparation_notes = item.preparation_notes
        where id = item.id and order_id = p_order returning id into saved_id;
      end if;
    end if;
    if saved_id is null then raise exception 'No se pudo guardar una línea del pedido.'; end if;
    keep := array_append(keep, saved_id);
  end loop;

  delete from public.order_items where order_id = p_order and id <> all(keep);
  update public.orders set fulfilment = p_fulfilment, requested_date = p_date, customer_notes = p_notes,
    updated_at = clock_timestamp(), customer_changes_at = clock_timestamp(), changes_confirmed_at = null
  where id = p_order returning id into saved_id;
  if saved_id is null then raise exception 'No se pudo guardar el pedido.'; end if;
  return saved_id;
end;
$$;
revoke all on function public.tarraco_edit_order(uuid,timestamptz,text,date,text,jsonb) from public, anon;
grant execute on function public.tarraco_edit_order(uuid,timestamptz,text,date,text,jsonb) to authenticated;

commit;
