-- El registro manual de facturas se completa desde las entidades maestras y
-- conserva el archivo tributario en un bucket privado de la organización.
alter table public.issued_documents
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime_type text,
  add column if not exists attachment_size bigint;

update public.issued_documents
set payment_status = case
  when lower(coalesce(payment_status, '')) like '%pagada al factoring%' then 'Pagada al factoring'
  when lower(coalesce(payment_status, '')) like '%recomprada%' then 'Recomprada al factoring'
  when lower(coalesce(payment_status, '')) like '%factoriz%' then 'Factorizada'
  when lower(coalesce(payment_status, '')) like '%pagad%' then 'Pagada'
  when lower(coalesce(payment_status, '')) like '%anulad%' then 'Anulada'
  when lower(coalesce(payment_status, '')) like '%nota%' then 'Nota de crédito'
  else 'Pendiente'
end
where payment_status is null
   or payment_status not in ('Pendiente', 'Pagada', 'Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito');

alter table public.issued_documents
  alter column payment_status set default 'Pendiente',
  alter column payment_status set not null;

alter table public.issued_documents
  drop constraint if exists issued_documents_payment_status_check,
  add constraint issued_documents_payment_status_check check (payment_status in ('Pendiente', 'Pagada', 'Factorizada', 'Pagada al factoring', 'Recomprada al factoring', 'Anulada', 'Nota de crédito'));

create unique index if not exists issued_documents_attachment_path_key
  on public.issued_documents (attachment_path)
  where attachment_path is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('issued-document-files', 'issued-document-files', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "members read issued document objects" on storage.objects
for select to authenticated using (
  bucket_id = 'issued-document-files' and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
  )
);

create policy "operators upload issued document objects" on storage.objects
for insert to authenticated with check (
  bucket_id = 'issued-document-files' and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);

create policy "operators delete issued document objects" on storage.objects
for delete to authenticated using (
  bucket_id = 'issued-document-files' and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);
