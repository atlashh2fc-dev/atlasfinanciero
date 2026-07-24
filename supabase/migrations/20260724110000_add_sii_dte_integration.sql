-- La llave privada del certificado nunca se guarda en la base. Sólo se conserva
-- configuración operacional y una bitácora inmutable de las solicitudes al SII.
create table public.sii_integrations (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  taxpayer_rut text not null,
  environment text not null default 'certification' check (environment in ('certification', 'production')),
  inbound_channel text not null default 'email' check (inbound_channel in ('email', 'provider', 'manual')),
  inbound_address text,
  is_enabled boolean not null default false,
  configured_by uuid references auth.users(id) on delete set null,
  configured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sii_integrations_set_updated_at before update on public.sii_integrations
for each row execute function public.set_updated_at();

alter table public.received_documents
  add column if not exists sii_document_type integer,
  add column if not exists sii_folio bigint,
  add column if not exists sii_received_at timestamptz,
  add column if not exists sii_response_deadline timestamptz,
  add column if not exists sii_event_status text,
  add column if not exists sii_last_checked_at timestamptz;

alter table public.received_documents
  add constraint received_documents_sii_type_check
  check (sii_document_type is null or sii_document_type between 1 and 999);

create unique index if not exists received_documents_sii_identity_key
  on public.received_documents (organization_id, supplier_tax_id, sii_document_type, sii_folio)
  where supplier_tax_id is not null and sii_document_type is not null and sii_folio is not null;

create index if not exists received_documents_sii_deadline_idx
  on public.received_documents (organization_id, sii_response_deadline)
  where sii_response_deadline is not null;

create table public.sii_dte_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  received_document_id uuid not null references public.received_documents(id) on delete restrict,
  action text not null check (action in ('CNS', 'ACD', 'ERM', 'RCD', 'RFP', 'RFT')),
  reason text,
  request_status text not null check (request_status in ('pending', 'completed', 'failed')),
  sii_response_code integer,
  sii_response_message text,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint sii_dte_events_reason_for_claim check (
    action not in ('RCD', 'RFP', 'RFT') or length(trim(coalesce(reason, ''))) > 0
  )
);

create index sii_dte_events_document_requested_idx
  on public.sii_dte_events (received_document_id, requested_at desc);

alter table public.sii_integrations enable row level security;
alter table public.sii_dte_events enable row level security;

create policy "finance reads sii integrations"
on public.sii_integrations for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_integrations.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

create policy "administrators manage sii integrations"
on public.sii_integrations for all to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_integrations.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role = 'administrator'
)) with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_integrations.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role = 'administrator'
));

create policy "finance reads sii event history"
on public.sii_dte_events for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_dte_events.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

create policy "finance creates sii event history"
on public.sii_dte_events for insert to authenticated
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_dte_events.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
));

create policy "finance updates sii event history"
on public.sii_dte_events for update to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_dte_events.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
));

grant select, insert, update on public.sii_integrations to authenticated;
grant select, insert, update on public.sii_dte_events to authenticated;
