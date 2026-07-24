-- Registro de Compras y Ventas (RCV) del SII como fuente maestra de documentos.
-- El correo tributario pasa a ser enriquecedor (XML con líneas de detalle);
-- el descubrimiento de documentos ahora proviene del registro oficial del SII.
-- Cada entrada conserva el payload crudo entregado por el SII (trazabilidad:
-- la fuente manda) y el vínculo hacia el documento operacional resultante.

create table public.sii_rcv_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  trigger_source text not null check (trigger_source in ('cron', 'manual')),
  periods text[] not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  run_status text not null check (run_status in ('completed', 'failed')),
  purchase_entries_fetched integer not null default 0 check (purchase_entries_fetched >= 0),
  sale_entries_fetched integer not null default 0 check (sale_entries_fetched >= 0),
  entries_created integer not null default 0 check (entries_created >= 0),
  entries_updated integer not null default 0 check (entries_updated >= 0),
  purchases_linked integer not null default 0 check (purchases_linked >= 0),
  purchases_created integer not null default 0 check (purchases_created >= 0),
  sales_linked integer not null default 0 check (sales_linked >= 0),
  sales_created integer not null default 0 check (sales_created >= 0),
  discrepancies integer not null default 0 check (discrepancies >= 0),
  error_detail text
);

create index sii_rcv_sync_runs_organization_started_idx
  on public.sii_rcv_sync_runs (organization_id, started_at desc);

create table public.sii_rcv_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  operation text not null check (operation in ('purchase', 'sale')),
  period text not null check (period ~ '^[0-9]{6}$'),
  estado_contab text not null default 'REGISTRO',
  document_type integer not null check (document_type between 1 and 999),
  folio bigint not null check (folio > 0),
  counterpart_tax_id text not null,
  counterpart_name text,
  issue_date date,
  reception_date timestamptz,
  acknowledgment_date timestamptz,
  receptor_event text,
  exempt_amount numeric(18, 2),
  net_amount numeric(18, 2),
  vat_amount numeric(18, 2),
  other_taxes_amount numeric(18, 2),
  total_amount numeric(18, 2),
  source_payload jsonb not null,
  first_seen_run_id uuid references public.sii_rcv_sync_runs(id) on delete set null,
  last_seen_run_id uuid references public.sii_rcv_sync_runs(id) on delete set null,
  received_document_id uuid references public.received_documents(id) on delete set null,
  issued_document_id uuid references public.issued_documents(id) on delete set null,
  match_status text not null default 'unmatched'
    check (match_status in ('linked', 'created', 'unmatched', 'amount_mismatch')),
  match_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, operation, counterpart_tax_id, document_type, folio)
);

create index sii_rcv_entries_org_period_idx
  on public.sii_rcv_entries (organization_id, operation, period);
create index sii_rcv_entries_match_status_idx
  on public.sii_rcv_entries (organization_id, match_status)
  where match_status in ('unmatched', 'amount_mismatch');

create trigger sii_rcv_entries_set_updated_at before update on public.sii_rcv_entries
for each row execute function public.set_updated_at();

-- Identidad SII también en documentos emitidos, para casar el registro de
-- ventas con las facturas emitidas existentes sin depender del texto libre.
alter table public.issued_documents
  add column if not exists sii_document_type integer,
  add column if not exists sii_folio bigint;

alter table public.issued_documents
  add constraint issued_documents_sii_type_check
  check (sii_document_type is null or sii_document_type between 1 and 999);

create unique index if not exists issued_documents_sii_identity_key
  on public.issued_documents (organization_id, sii_document_type, sii_folio)
  where sii_document_type is not null and sii_folio is not null;

alter table public.sii_rcv_sync_runs enable row level security;
alter table public.sii_rcv_entries enable row level security;

create policy "finance and audit read sii rcv sync runs"
on public.sii_rcv_sync_runs for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_rcv_sync_runs.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

create policy "finance and audit read sii rcv entries"
on public.sii_rcv_entries for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sii_rcv_entries.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

grant select on public.sii_rcv_sync_runs, public.sii_rcv_entries to authenticated;
