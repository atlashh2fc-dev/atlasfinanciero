-- El digitador necesita una bandeja operativa de facturas y cobros, sin acceso
-- a reportes agregados, y debe poder adjuntar respaldos a registros existentes.

create unique index if not exists issued_document_payments_target_key
  on public.issued_document_payments (id, issued_document_id, organization_id);

create table public.data_entry_supporting_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category text not null check (category in ('invoice', 'collection')),
  issued_document_id uuid not null,
  issued_document_payment_id uuid,
  notes text,
  file_path text not null,
  file_name text not null,
  file_mime_type text not null,
  file_size bigint not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint data_entry_supporting_documents_target_check check (
    (category = 'invoice' and issued_document_payment_id is null)
    or (category = 'collection' and issued_document_payment_id is not null)
  ),
  constraint data_entry_supporting_documents_notes_check
    check (notes is null or char_length(notes) <= 2000),
  constraint data_entry_supporting_documents_file_name_check
    check (char_length(btrim(file_name)) between 1 and 300),
  constraint data_entry_supporting_documents_file_type_check
    check (file_mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  constraint data_entry_supporting_documents_file_size_check
    check (file_size between 1 and 52428800),
  constraint data_entry_supporting_documents_invoice_fk
    foreign key (issued_document_id, organization_id)
    references public.issued_documents (id, organization_id) on delete cascade,
  constraint data_entry_supporting_documents_collection_fk
    foreign key (issued_document_payment_id, issued_document_id, organization_id)
    references public.issued_document_payments (id, issued_document_id, organization_id)
    on delete cascade
);

create unique index data_entry_supporting_documents_file_path_key
  on public.data_entry_supporting_documents (file_path);

create index data_entry_supporting_documents_organization_created_idx
  on public.data_entry_supporting_documents (organization_id, created_at desc);

create index data_entry_supporting_documents_invoice_idx
  on public.data_entry_supporting_documents (issued_document_id, created_at desc);

alter table public.data_entry_supporting_documents enable row level security;

grant select, insert on public.data_entry_supporting_documents to authenticated;

create policy "finance roles read data entry supporting documents"
on public.data_entry_supporting_documents
for select to authenticated using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = data_entry_supporting_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')
  )
);

create policy "data entry users read organization supporting documents"
on public.data_entry_supporting_documents
for select to authenticated using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = data_entry_supporting_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

create policy "data entry users create supporting documents"
on public.data_entry_supporting_documents
for insert to authenticated with check (
  created_by = (select auth.uid())
  and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = data_entry_supporting_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'data-entry-support-files',
  'data-entry-support-files',
  false,
  52428800,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "organization roles read data entry support objects"
on storage.objects
for select to authenticated using (
  bucket_id = 'data-entry-support-files'
  and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations', 'auditor', 'data_entry')
  )
);

create policy "data entry users upload support objects"
on storage.objects
for insert to authenticated with check (
  bucket_id = 'data-entry-support-files'
  and owner_id = (select auth.uid())::text
  and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

create policy "data entry users delete own support objects"
on storage.objects
for delete to authenticated using (
  bucket_id = 'data-entry-support-files'
  and owner_id = (select auth.uid())::text
  and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

-- Proyección de lectura con campos mínimos. Evita exponer las tablas
-- financieras completas o una función SECURITY DEFINER mediante la Data API.
create table public.data_entry_income_references (
  item_kind text not null check (item_kind in ('sale', 'collection')),
  item_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  issued_document_id uuid not null,
  document_number text,
  occurred_on date,
  counterpart text,
  amount numeric,
  status text,
  detail text,
  has_proof boolean not null default false,
  created_at timestamptz not null,
  primary key (item_kind, item_id),
  constraint data_entry_income_references_document_fk
    foreign key (issued_document_id, organization_id)
    references public.issued_documents (id, organization_id) on delete cascade
);

create index data_entry_income_references_organization_created_idx
  on public.data_entry_income_references (organization_id, created_at desc);

alter table public.data_entry_income_references enable row level security;
grant select on public.data_entry_income_references to authenticated;

create policy "data entry users read income references"
on public.data_entry_income_references
for select to authenticated using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = data_entry_income_references.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

insert into public.data_entry_income_references (
  item_kind, item_id, organization_id, issued_document_id, document_number,
  occurred_on, counterpart, amount, status, detail, has_proof, created_at
)
select
  'sale', document.id, document.organization_id, document.id,
  document.document_number, document.issue_date, document.client_name,
  document.total_amount, document.payment_status, document.document_type,
  document.attachment_path is not null, document.created_at
from public.issued_documents document
union all
select
  'collection', payment.id, payment.organization_id, payment.issued_document_id,
  document.document_number, payment.paid_on, document.client_name,
  payment.amount, 'Registrado', coalesce(payment.payment_method, 'Cobro'),
  payment.proof_path is not null, payment.created_at
from public.issued_document_payments payment
join public.issued_documents document on document.id = payment.issued_document_id;

create or replace function public.sync_data_entry_income_reference_from_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.data_entry_income_references reference
    where reference.item_kind = 'sale' and reference.item_id = old.id;
    return old;
  end if;

  insert into public.data_entry_income_references (
    item_kind, item_id, organization_id, issued_document_id, document_number,
    occurred_on, counterpart, amount, status, detail, has_proof, created_at
  ) values (
    'sale', new.id, new.organization_id, new.id, new.document_number,
    new.issue_date, new.client_name, new.total_amount, new.payment_status,
    new.document_type, new.attachment_path is not null, new.created_at
  )
  on conflict (item_kind, item_id) do update set
    organization_id = excluded.organization_id,
    issued_document_id = excluded.issued_document_id,
    document_number = excluded.document_number,
    occurred_on = excluded.occurred_on,
    counterpart = excluded.counterpart,
    amount = excluded.amount,
    status = excluded.status,
    detail = excluded.detail,
    has_proof = excluded.has_proof,
    created_at = excluded.created_at;

  update public.data_entry_income_references reference
  set document_number = new.document_number,
      counterpart = new.client_name
  where reference.item_kind = 'collection'
    and reference.issued_document_id = new.id;
  return new;
end;
$$;

create or replace function public.sync_data_entry_income_reference_from_collection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_row public.issued_documents%rowtype;
begin
  if tg_op = 'DELETE' then
    delete from public.data_entry_income_references reference
    where reference.item_kind = 'collection' and reference.item_id = old.id;
    return old;
  end if;

  select * into document_row
  from public.issued_documents document
  where document.id = new.issued_document_id;

  if not found then raise exception 'Issued document not found for collection reference'; end if;

  insert into public.data_entry_income_references (
    item_kind, item_id, organization_id, issued_document_id, document_number,
    occurred_on, counterpart, amount, status, detail, has_proof, created_at
  ) values (
    'collection', new.id, new.organization_id, new.issued_document_id,
    document_row.document_number, new.paid_on, document_row.client_name,
    new.amount, 'Registrado', coalesce(new.payment_method, 'Cobro'),
    new.proof_path is not null, new.created_at
  )
  on conflict (item_kind, item_id) do update set
    organization_id = excluded.organization_id,
    issued_document_id = excluded.issued_document_id,
    document_number = excluded.document_number,
    occurred_on = excluded.occurred_on,
    counterpart = excluded.counterpart,
    amount = excluded.amount,
    status = excluded.status,
    detail = excluded.detail,
    has_proof = excluded.has_proof,
    created_at = excluded.created_at;
  return new;
end;
$$;

create trigger issued_documents_sync_data_entry_income_reference
after insert or update or delete on public.issued_documents
for each row execute function public.sync_data_entry_income_reference_from_document();

create trigger issued_document_payments_sync_data_entry_income_reference
after insert or update or delete on public.issued_document_payments
for each row execute function public.sync_data_entry_income_reference_from_collection();

revoke all on function public.sync_data_entry_income_reference_from_document() from public, anon, authenticated;
revoke all on function public.sync_data_entry_income_reference_from_collection() from public, anon, authenticated;
