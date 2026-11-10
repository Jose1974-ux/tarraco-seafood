alter table public.products
  alter column enabled_units set default array['box','kg','bag','dozen','unit','sack']::text[];

update public.products
set enabled_units = array['box','kg','bag','dozen','unit','sack']::text[]
where enabled_units is distinct from array['box','kg','bag','dozen','unit','sack']::text[];
