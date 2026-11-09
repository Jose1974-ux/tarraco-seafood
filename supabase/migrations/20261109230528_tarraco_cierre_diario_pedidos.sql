create or replace function public.tarraco_order_window()
returns table(earliest date, after_cutoff boolean, cutoff_time time, min_lead_days integer)
language sql stable security invoker set search_path = '' as $$
  select madrid.local_now::date,
    coalesce(settings.enabled and case
      when settings.cutoff_time < time '06:00' then
        madrid.local_now::time >= settings.cutoff_time and madrid.local_now::time < time '06:00'
      when settings.cutoff_time > time '06:00' then
        madrid.local_now::time >= settings.cutoff_time or madrid.local_now::time < time '06:00'
      else false
    end, false),
    case when settings.enabled then settings.cutoff_time end,
    null::integer
  from (select statement_timestamp() at time zone 'Europe/Madrid' as local_now) madrid
  left join public.order_cutoff_settings settings on settings.id = 1
$$;

create or replace function public.enforce_order_cutoff() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not coalesce(public.is_admin(), false)
    and exists (select 1 from public.tarraco_order_window() where after_cutoff) then
    raise exception using errcode = 'PT423',
      message = 'Fuera de la hora límite. Los pedidos vuelven a abrir a las 06:00 (hora peninsular).';
  end if;
  return new;
end;
$$;

drop trigger orders_enforce_cutoff on public.orders;
create trigger orders_enforce_cutoff before insert on public.orders
for each row execute function public.enforce_order_cutoff();

update public.order_cutoff_settings
set cutoff_time = time '00:30', min_lead_days = 0, updated_at = statement_timestamp()
where id = 1;
