begin;

alter table public.companies
  add column customer_code text unique,
  add column source_customer_code text unique,
  add column trade_name text,
  add column tax_id text,
  add column accounting_code text,
  add column town text,
  add column postal_code text,
  add column province text,
  add column archived_at timestamptz,
  add constraint tarraco_archived_customer_inactive check (archived_at is null or not active),
  add constraint tarraco_customer_code_nonempty check (customer_code is null or btrim(customer_code) <> '');

-- Order and catalogue policies already use the company UUID from this helper.
-- An existing session loses company data access as soon as its customer is blocked.
create or replace function public.my_company_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.company_id
  from public.profiles p
  join public.companies c on c.id = p.company_id
  where p.id = (select auth.uid()) and p.role = 'customer'
    and c.active and not c.registration_pending and c.archived_at is null
$$;

-- Admin UI reads linked account state without disclosing credentials or relying on
-- the existence of a contact email.
create function public.tarraco_customer_accounts()
returns table (company_id uuid)
language sql stable security invoker
set search_path = ''
as $$
  select distinct p.company_id
  from public.profiles p
  where (select public.is_admin()) and p.role = 'customer' and p.company_id is not null
$$;

revoke all on function public.tarraco_customer_accounts() from public, anon;
grant execute on function public.tarraco_customer_accounts() to authenticated;

commit;
