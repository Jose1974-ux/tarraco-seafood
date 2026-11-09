create table public.tarraco_install_invites (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  company_id uuid not null,
  company_name text not null,
  recipient text not null,
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  status text not null default 'processing'
    check (status in ('processing', 'sent', 'failed', 'unknown')),
  provider_id text,
  detail text,
  unique (campaign_id, recipient)
);

create index tarraco_install_invites_requested_at_idx
  on public.tarraco_install_invites (requested_at desc, id desc);

alter table public.tarraco_install_invites enable row level security;
revoke all on public.tarraco_install_invites from public, anon, authenticated;
grant select, insert, update on public.tarraco_install_invites to service_role;
