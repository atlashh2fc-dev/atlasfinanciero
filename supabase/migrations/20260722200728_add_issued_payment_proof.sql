-- El archivo tributario y el comprobante de cobro son evidencias distintas.
alter table public.issued_documents
  add column if not exists payment_proof_path text,
  add column if not exists payment_proof_name text,
  add column if not exists payment_proof_mime_type text,
  add column if not exists payment_proof_size bigint;

create unique index if not exists issued_documents_payment_proof_path_key
  on public.issued_documents (payment_proof_path)
  where payment_proof_path is not null;
