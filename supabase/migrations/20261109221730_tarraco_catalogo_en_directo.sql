create policy tarraco_catalog_read on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'tarraco-catalog'
    and extension = 'broadcast'
    and (select public.my_company_id()) is not null);

create function tarraco_private.notify_catalog_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send('{}'::jsonb, 'changed', 'tarraco-catalog', true);
  return null;
end;
$$;
revoke all on function tarraco_private.notify_catalog_change() from public, anon, authenticated;

create trigger tarraco_catalog_products
after insert or update or delete on public.products
for each statement execute function tarraco_private.notify_catalog_change();

create trigger tarraco_catalog_prices
after insert or update or delete on public.company_prices
for each statement execute function tarraco_private.notify_catalog_change();

create trigger tarraco_catalog_visibility
after insert or update or delete on public.company_hidden_products
for each statement execute function tarraco_private.notify_catalog_change();

create trigger tarraco_catalog_offers
after insert or update or delete on public.product_offer_targets
for each statement execute function tarraco_private.notify_catalog_change();

create or replace function public.tarraco_place_order(
  p_id uuid, p_fulfilment text, p_date date, p_notes text, p_items jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  customer uuid := auth.uid();
  company uuid := public.my_company_id();
  inserted uuid;
  line_count integer;
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
  from jsonb_to_recordset(p_items) as item(product_id uuid, product_name_snapshot text, unit_snapshot text, quantity numeric, unit_price_snapshot numeric, preparation_notes text)
  join public.products product on product.id = item.product_id
  left join public.company_prices tariff on tariff.company_id = company and tariff.product_id = product.id
  left join public.my_targeted_offers() offer on offer.product_id = product.id
  where product.active and product.available_for_order is distinct from false
    and item.unit_snapshot = any(coalesce(product.enabled_units, array[product.unit]))
    and item.unit_price_snapshot = coalesce(tariff.price,
      case when product.offer_price is not null
        and (product.offer_until is null or product.offer_until >= (statement_timestamp() at time zone 'UTC')::date)
        and coalesce(offer.allowed, true)
      then product.offer_price else product.default_price end, 0);
  get diagnostics line_count = row_count;
  if line_count <> jsonb_array_length(p_items) then
    raise exception using errcode = 'PT409', message = 'El catálogo ha cambiado. Revisa el precio y la disponibilidad antes de volver a enviar.';
  end if;
  return inserted;
end;
$$;
