begin;
alter table tarraco_private.registration_requests drop constraint registration_requests_state_check;
alter table tarraco_private.registration_requests add constraint registration_requests_state_check check (state in ('pending','code_pending','authorized','rejected'));
alter table tarraco_private.registration_requests add column if not exists confirmation_attempts integer not null default 0;
create or replace function public.tarraco_registration_status(p_hash text)
returns text language sql stable security definer set search_path = '' as $$
 select case
 when r.state='code_pending' then case when r.confirmation_attempts>=5 then 'review' else 'confirm_code' end
 when r.link_state is not null and r.state='pending' and r.link_state='review' then case when r.code_attempts<3 then 'needs_code' else 'review' end
 when r.link_state is not null and r.state='pending' then 'pending'
 when r.state='rejected' and r.link_state is not null then 'rejected'
 when c.id is null or (r.state='authorized' and not c.active) then 'unavailable'
 else r.state end
 from tarraco_private.registration_requests r
 left join public.companies c on c.id=r.company_id
 where r.tracking_hash=p_hash
$$;
create or replace function public.tarraco_decide_registration_link(p_notice uuid,p_approve boolean)
returns text language plpgsql security definer set search_path='' as $$
declare request tarraco_private.registration_requests%rowtype;
company uuid; account_email text; proposal record;
begin
 if p_approve is null then return null; end if;
 perform pg_catalog.pg_advisory_xact_lock(129901,1);
 select * into request from tarraco_private.registration_requests r where r.notice_id=p_notice for update;
 if not found then return null; end if;
 if request.state<>'pending' then return request.state; end if;
 if not p_approve then
  update tarraco_private.registration_requests set state='rejected' where user_id=request.user_id;
  return 'rejected';
 end if;
 if request.link_state='review' then return 'review'; end if;
 if request.candidate_company_id is not null then
  perform 1 from public.companies where id=request.candidate_company_id for update;
 end if;
 select u.email into account_email from auth.users u where u.id=request.user_id and u.deleted_at is null and u.email_confirmed_at is null for update;
 if not found then return null; end if;
 select * into proposal from tarraco_private.registration_proposal(request.restaurant_name,request.tax_id,request.phone,request.customer_code,account_email,request.new_customer);
 if proposal.link_state is distinct from request.link_state or proposal.candidate is distinct from request.candidate_company_id then
  update tarraco_private.registration_requests set link_state='review',candidate_company_id=null where user_id=request.user_id;
  return 'review';
 end if;
 if request.link_state='matched' then
  update tarraco_private.registration_requests set state='code_pending',company_id=request.candidate_company_id where user_id=request.user_id;
  return 'code_pending';
 end if;
 if request.link_state<>'new' then return 'review'; end if;
 insert into public.companies(name,tax_id,phone,email,customer_code,active)
 values(request.restaurant_name,request.tax_id,request.phone,account_email,'WEB-'||upper(gen_random_uuid()::text),true)
 returning id into company;
 insert into public.profiles(id,role,company_id,display_name) values(request.user_id,'customer',company,request.restaurant_name);
 update tarraco_private.registration_requests set state='authorized',company_id=company where user_id=request.user_id;
 update auth.users set email_confirmed_at=now(),confirmation_token='',recovery_token='',updated_at=now() where id=request.user_id;
 delete from auth.one_time_tokens where user_id=request.user_id;
 return 'authorized';
end; $$;
create or replace function public.tarraco_registration_confirm_code(p_hash text,p_code text)
returns text language plpgsql security definer set search_path='' as $$
declare request tarraco_private.registration_requests%rowtype; company public.companies%rowtype; account_email text;
begin
 perform pg_catalog.pg_advisory_xact_lock(129901,1);
 select * into request from tarraco_private.registration_requests where tracking_hash=p_hash for update;
 if not found then return 'unavailable'; end if;
 if request.state<>'code_pending' then return public.tarraco_registration_status(p_hash); end if;
 if request.confirmation_attempts>=5 then return 'review'; end if;
 select * into company from public.companies where id=request.company_id for update;
 if not found or company.active or company.archived_at is not null or company.customer_code is null
  or exists(select 1 from public.profiles where company_id=company.id)
 then return 'review'; end if;
 if p_code is null or tarraco_private.registration_code(p_code) is distinct from tarraco_private.registration_code(company.customer_code) then
  update tarraco_private.registration_requests set confirmation_attempts=confirmation_attempts+1 where user_id=request.user_id;
  return 'confirm_code';
 end if;
 select email into account_email from auth.users where id=request.user_id and deleted_at is null and email_confirmed_at is null for update;
 if not found then return 'unavailable'; end if;
 update public.companies set active=true,email=coalesce(nullif(btrim(email),''),account_email) where id=company.id;
 insert into public.profiles(id,role,company_id,display_name) values(request.user_id,'customer',company.id,request.restaurant_name);
 update tarraco_private.registration_requests set state='authorized' where user_id=request.user_id;
 update auth.users set email_confirmed_at=now(),confirmation_token='',recovery_token='',updated_at=now() where id=request.user_id;
 delete from auth.one_time_tokens where user_id=request.user_id;
 return 'authorized';
end; $$;
revoke all on function public.tarraco_registration_confirm_code(text,text) from public,anon,authenticated;
grant execute on function public.tarraco_registration_confirm_code(text,text) to service_role;
commit;