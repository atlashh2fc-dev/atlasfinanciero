create table public.received_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_counterparty_id uuid,
  supplier_name text not null,
  supplier_tax_id text,
  document_number text,
  issue_date date not null,
  document_type text not null,
  net_amount numeric(18, 2) not null default 0,
  vat_amount numeric(18, 2) not null default 0,
  additional_tax_amount numeric(18, 2) not null default 0,
  total_amount numeric(18, 2) not null default 0,
  notes text,
  payment_term_days integer,
  due_date date,
  due_month text,
  payment_status text,
  payment_method text,
  payment_bank text,
  origin_account_or_tax_id text,
  payment_date date,
  source_file_name text not null,
  source_sheet_name text not null,
  source_row integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (supplier_counterparty_id, organization_id)
    references public.counterparties (id, organization_id)
    on delete set null,
  unique (organization_id, source_file_name, source_sheet_name, source_row)
);

create index received_documents_org_issue_date_idx
  on public.received_documents (organization_id, issue_date desc);
create index received_documents_org_supplier_idx
  on public.received_documents (organization_id, supplier_counterparty_id, issue_date desc);
create index received_documents_org_status_idx
  on public.received_documents (organization_id, payment_status, due_date);

create trigger received_documents_set_updated_at before update on public.received_documents
for each row execute function public.set_updated_at();

alter table public.received_documents enable row level security;

create policy "finance and audit read received documents"
on public.received_documents
for select to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = received_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

grant select on public.received_documents to authenticated;
