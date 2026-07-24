-- Los comprobantes que llegan al buzón se conservan aun cuando no sea
-- posible asociarlos sin ambigüedad. Sólo una coincidencia fuerte actualiza
-- la cuenta por pagar; nunca cambia por sí sola su estado de pago.
alter table public.received_documents
  add column if not exists payment_proof_path text,
  add column if not exists payment_proof_name text,
  add column if not exists payment_proof_mime_type text,
  add column if not exists payment_proof_size bigint,
  add constraint received_documents_payment_proof_check check (
    (payment_proof_path is null and payment_proof_name is null and payment_proof_mime_type is null and payment_proof_size is null)
    or (
      payment_proof_path is not null
      and length(btrim(payment_proof_name)) between 1 and 300
      and payment_proof_mime_type in ('application/pdf', 'image/jpeg', 'image/png')
      and payment_proof_size between 1 and 52428800
    )
  );

create unique index if not exists received_documents_payment_proof_path_key
  on public.received_documents (payment_proof_path)
  where payment_proof_path is not null;

create table public.mail_payment_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  received_document_id uuid references public.received_documents(id) on delete set null,
  message_id text not null,
  attachment_sha256 text not null,
  attachment_name text not null,
  attachment_mime_type text not null check (attachment_mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  attachment_size bigint not null check (attachment_size between 1 and 52428800),
  storage_path text not null,
  email_subject text,
  received_at timestamptz,
  match_status text not null check (match_status in ('matched', 'review_required')),
  match_reason text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, attachment_sha256)
);

create index mail_payment_receipts_review_idx
  on public.mail_payment_receipts (organization_id, match_status, received_at desc);

alter table public.mail_payment_receipts enable row level security;

create policy "finance and audit read mail payment receipts"
on public.mail_payment_receipts for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = mail_payment_receipts.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));

grant select on public.mail_payment_receipts to authenticated;
