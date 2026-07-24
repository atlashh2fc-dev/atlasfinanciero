-- El correo tributario se mantiene como buzón del usuario: los mensajes no DTE
-- no se marcan como leídos. Esta bitácora evita descargarlos y analizarlos una y
-- otra vez en cada ejecución automática.
create table public.sii_mail_processed_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id text not null,
  imap_uid bigint,
  processing_status text not null check (processing_status in ('imported', 'ignored', 'failed')),
  detail text,
  processed_at timestamptz not null default now(),
  unique (organization_id, message_id)
);

create index sii_mail_processed_messages_lookup_idx
  on public.sii_mail_processed_messages (organization_id, processed_at desc);

create table public.sii_mail_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  run_status text not null check (run_status in ('completed', 'failed')),
  dte_scanned integer not null default 0 check (dte_scanned >= 0),
  dte_created integer not null default 0 check (dte_created >= 0),
  dte_updated integer not null default 0 check (dte_updated >= 0),
  dte_skipped integer not null default 0 check (dte_skipped >= 0),
  invoice_files_attached integer not null default 0 check (invoice_files_attached >= 0),
  payment_scanned integer not null default 0 check (payment_scanned >= 0),
  payment_matched integer not null default 0 check (payment_matched >= 0),
  payment_review_required integer not null default 0 check (payment_review_required >= 0),
  error_detail text
);

create index sii_mail_sync_runs_organization_started_idx
  on public.sii_mail_sync_runs (organization_id, started_at desc);

alter table public.sii_mail_processed_messages enable row level security;
alter table public.sii_mail_sync_runs enable row level security;

create policy "finance and audit read sii processed mail"
on public.sii_mail_processed_messages for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_mail_processed_messages.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

create policy "finance and audit read sii sync runs"
on public.sii_mail_sync_runs for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_mail_sync_runs.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

grant select on public.sii_mail_processed_messages, public.sii_mail_sync_runs to authenticated;
