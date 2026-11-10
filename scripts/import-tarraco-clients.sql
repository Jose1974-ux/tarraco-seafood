-- Run through prepare-tarraco-client-import.py after the directory migration.
-- The application has no endpoint for this operation.
lock table public.companies in share row exclusive mode;

create temporary table tarraco_import_stage on commit drop as
select
  r.customer_code,
  nullif(btrim(r.name), '') as name,
  nullif(btrim(r.trade_name), '') as trade_name,
  nullif(btrim(r.tax_id), '') as tax_id,
  nullif(btrim(r.accounting_code), '') as accounting_code,
  nullif(btrim(r.address), '') as address,
  nullif(btrim(r.phone), '') as phone,
  nullif(btrim(r.town), '') as town,
  nullif(btrim(r.postal_code), '') as postal_code,
  nullif(btrim(r.province), '') as province,
  coalesce(r.review, false) as review
from jsonb_to_recordset(current_setting('tarraco.client_import')::jsonb) as r(
  customer_code text, name text, trade_name text, tax_id text,
  accounting_code text, address text, phone text, town text,
  postal_code text, province text, review boolean
);

alter table tarraco_import_stage
  add primary key (customer_code),
  alter column name set not null,
  add check (customer_code ~ '^[0-9]+$');

create or replace function pg_temp.client_name_key(value text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(
    translate(lower(value), 'áàäéèëíìïóòöúùüçñ', 'aaaeeeiiiooouuucn'),
    '[^a-z0-9]', '', 'g'
  )
$$;

create or replace function pg_temp.client_phone_key(value text)
returns text language sql immutable set search_path = '' as $$
  select case when value ~ '^[+0-9 ().-]+$' then
    regexp_replace(regexp_replace(value, '[^0-9]', '', 'g'), '^(0034|34)([0-9]{9})$', '\2')
  end
$$;

create temporary table tarraco_import_plan on commit drop as
select s.*, case
  when exists (select 1 from public.companies c where c.source_customer_code = s.customer_code)
    then 'already_imported'
  when s.review then 'source_duplicate_review'
  when exists (
    select 1 from public.companies c
    where c.source_customer_code is null and (
      c.customer_code = s.customer_code
      or (
        length(pg_temp.client_name_key(c.name)) > 0
        and pg_temp.client_name_key(c.name) in (
          pg_temp.client_name_key(s.name), pg_temp.client_name_key(s.trade_name)
        )
      )
      or (
        length(pg_temp.client_name_key(c.trade_name)) > 0
        and pg_temp.client_name_key(c.trade_name) in (
          pg_temp.client_name_key(s.name), pg_temp.client_name_key(s.trade_name)
        )
      )
      or (
        length(pg_temp.client_phone_key(c.phone)) = 9
        and pg_temp.client_phone_key(c.phone) = pg_temp.client_phone_key(s.phone)
      )
    )
  ) then 'existing_company_review'
  when exists (select 1 from public.companies c where c.customer_code = s.customer_code)
    then 'code_conflict_review'
  else 'new'
end as result
from tarraco_import_stage s;

with imported as (
  insert into public.companies(
    customer_code, source_customer_code, name, trade_name, tax_id, accounting_code,
    address, phone, town, postal_code, province, active
  )
  select customer_code, customer_code, name, trade_name, tax_id, accounting_code,
    address, phone, town, postal_code, province, false
  from tarraco_import_plan where result = 'new'
  returning id
)
select count(*) as inserted_in_transaction from imported;

select result, count(*) as records
from tarraco_import_plan group by result order by result;
