alter table public.products
  add column catalog_group text,
  add column catalog_format text,
  add column catalog_review text,
  add column catalog_section text check (catalog_section in ('seafood', 'cephalopods', 'mixed-fish', 'prepared'));

alter table public.order_items
  add column product_code_snapshot text,
  add column product_format_snapshot text,
  add column price_unit_snapshot text;

-- Capture the reference from the selected product in both order creation and edits.
create function public.tarraco_snapshot_order_article()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  article public.products%rowtype;
begin
  select * into article from public.products where id = new.product_id;
  if not found or (not article.active and not public.is_admin()) then
    raise exception 'La variedad no está disponible para esta empresa';
  end if;

  if article.default_price is null and not exists (
    select 1 from public.company_prices tariff
    where tariff.company_id = public.my_company_id() and tariff.product_id = article.id
      and tariff.price is not null
  ) and not (
    article.offer_price is not null
    and (article.offer_until is null or article.offer_until >= (statement_timestamp() at time zone 'UTC')::date)
    and coalesce((select offer.allowed from public.my_targeted_offers() offer where offer.product_id = article.id), true)
  ) then
    raise exception 'El artículo todavía no tiene precio';
  end if;

  if tg_op = 'UPDATE' and new.product_id = old.product_id then
    new.product_name_snapshot := old.product_name_snapshot;
    new.product_code_snapshot := old.product_code_snapshot;
    new.product_format_snapshot := old.product_format_snapshot;
    new.price_unit_snapshot := old.price_unit_snapshot;
    return new;
  end if;
  new.product_name_snapshot := article.name;
  new.product_code_snapshot := article.product_code;
  new.product_format_snapshot := article.catalog_format;
  new.price_unit_snapshot := article.unit;
  return new;
end;
$$;

create trigger tarraco_snapshot_order_article
before insert or update on public.order_items
for each row execute function public.tarraco_snapshot_order_article();
