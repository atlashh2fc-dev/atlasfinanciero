drop policy if exists "finance roles read data entry supporting documents"
  on public.data_entry_supporting_documents;
drop policy if exists "data entry users read organization supporting documents"
  on public.data_entry_supporting_documents;

create policy "organization roles read data entry supporting documents"
on public.data_entry_supporting_documents
for select to authenticated using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = data_entry_supporting_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations', 'auditor', 'data_entry')
  )
);

drop index if exists public.data_entry_supporting_documents_invoice_idx;

create index data_entry_supporting_documents_invoice_organization_idx
  on public.data_entry_supporting_documents
  (issued_document_id, organization_id, created_at desc);

create index data_entry_supporting_documents_collection_target_idx
  on public.data_entry_supporting_documents
  (issued_document_payment_id, issued_document_id, organization_id)
  where issued_document_payment_id is not null;

create index data_entry_supporting_documents_created_by_idx
  on public.data_entry_supporting_documents (created_by)
  where created_by is not null;

create index data_entry_income_references_document_organization_idx
  on public.data_entry_income_references (issued_document_id, organization_id);
