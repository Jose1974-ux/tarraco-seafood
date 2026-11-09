begin;

create table public.tarraco_registration_approval_email (
  company_id uuid primary key references public.companies(id) on delete cascade,
  recipient text not null,
  next_attempt_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,
  last_error text
);
alter table public.tarraco_registration_approval_email enable row level security;
revoke all on public.tarraco_registration_approval_email from public, anon, authenticated;
grant select, update on public.tarraco_registration_approval_email to service_role;
create index tarraco_registration_approval_email_due
  on public.tarraco_registration_approval_email(next_attempt_at) where sent_at is null;

alter table public.tarraco_telegram_outbox
  add column telegram_chat_id bigint,
  add column telegram_message_id bigint,
  drop constraint tarraco_telegram_outbox_kind_check,
  add constraint tarraco_telegram_outbox_kind_check
    check (kind in ('chat', 'registration', 'registration_authorized'));

create function tarraco_private.queue_registration_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(btrim(new.email), '') is not null then
    insert into public.tarraco_registration_approval_email(company_id, recipient)
    values (new.id, btrim(new.email))
    on conflict (company_id) do nothing;
  end if;

  insert into public.tarraco_telegram_outbox(kind, entity_id)
  select 'registration_authorized', new.id
  where exists (
    select 1 from public.tarraco_telegram_outbox
    where kind = 'registration' and entity_id = new.id
  )
  on conflict (kind, entity_id) do nothing;
  return new;
end;
$$;
revoke all on function tarraco_private.queue_registration_approval() from public, anon, authenticated;

create trigger tarraco_queue_registration_approval after update of active on public.companies
for each row when (old.registration_pending and not old.active and new.active and not new.registration_pending)
execute function tarraco_private.queue_registration_approval();

create function public.tarraco_claim_registration_approval_email()
returns setof public.tarraco_registration_approval_email
language sql security invoker set search_path = '' as $$
  update public.tarraco_registration_approval_email q
  set attempts = q.attempts + 1,
      first_attempt_at = coalesce(q.first_attempt_at, now()),
      next_attempt_at = now() + interval '3 minutes'
  where q.company_id in (
    select e.company_id from public.tarraco_registration_approval_email e
    where e.sent_at is null and e.next_attempt_at <= now()
      -- Resend retains idempotency keys for 24 hours. Leave a margin for in-flight requests.
      and (e.first_attempt_at is null or e.first_attempt_at > now() - interval '23 hours')
    order by e.next_attempt_at
    limit 5 for update skip locked
  )
  returning q.*
$$;
revoke all on function public.tarraco_claim_registration_approval_email() from public, anon, authenticated;
grant execute on function public.tarraco_claim_registration_approval_email() to service_role;

commit;
