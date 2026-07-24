alter table public.received_documents
  add column if not exists sii_xml_path text,
  add column if not exists sii_xml_sha256 text,
  add column if not exists sii_mail_message_id text,
  add column if not exists sii_purchase_order_reference text;

create unique index if not exists received_documents_sii_xml_sha256_key
  on public.received_documents (organization_id, sii_xml_sha256)
  where sii_xml_sha256 is not null;

create table public.received_document_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  received_document_id uuid not null references public.received_documents(id) on delete cascade,
  line_number integer not null,
  item_code text,
  description text not null,
  quantity numeric(18, 6),
  unit_name text,
  unit_price numeric(18, 6),
  discount_amount numeric(18, 2) not null default 0,
  surcharge_amount numeric(18, 2) not null default 0,
  line_total numeric(18, 2) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (received_document_id, line_number)
);

create index received_document_lines_document_idx
  on public.received_document_lines (received_document_id, line_number);

alter table public.received_document_lines enable row level security;

create policy "finance and audit read received document lines"
on public.received_document_lines for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = received_document_lines.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

grant select on public.received_document_lines to authenticated;

update storage.buckets
set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'application/xml', 'text/xml']
where id = 'received-document-files';
