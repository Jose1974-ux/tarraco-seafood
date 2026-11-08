-- Registro voluntario de empresas. Aplicar tras revisión en Supabase.
-- No modifica las contraseñas ni los perfiles existentes.
create or replace function public.tarraco_register_company()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare new_company_id uuid;
declare company_name text;
declare contact_name text;
declare contact_phone text;
begin
  if new.raw_user_meta_data->>'tarraco_self_registration' is distinct from 'true' then
    return new;
  end if;
  company_name := btrim(coalesce(new.raw_user_meta_data->>'company_name',''));
  contact_name := btrim(coalesce(new.raw_user_meta_data->>'contact_name',''));
  contact_phone := btrim(coalesce(new.raw_user_meta_data->>'contact_phone',''));
  if length(company_name) not between 2 and 120 or length(contact_name) not between 2 and 120
     or length(contact_phone) not between 7 and 25 or new.email is null then
    raise exception 'Datos de registro incompletos';
  end if;
  insert into public.companies(name,contact_name,email,phone,active)
  values (company_name,contact_name,new.email,contact_phone,true)
  returning id into new_company_id;
  insert into public.profiles(id,role,company_id,display_name)
  values(new.id,'customer',new_company_id,contact_name);
  return new;
end;
$$;
revoke all on function public.tarraco_register_company() from public, anon, authenticated;
drop trigger if exists tarraco_self_registration on auth.users;
create trigger tarraco_self_registration after insert on auth.users
for each row execute function public.tarraco_register_company();
