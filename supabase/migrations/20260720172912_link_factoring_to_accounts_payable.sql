alter table public.issued_documents
  add column factoring_counterparty_id uuid,
  add constraint issued_documents_factoring_counterparty_organization_fkey
    foreign key (factoring_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict;

alter table public.direct_payables
  add column factoring_issued_document_id uuid,
  add constraint direct_payables_factoring_issued_document_organization_fkey
    foreign key (factoring_issued_document_id, organization_id)
    references public.issued_documents (id, organization_id) on delete restrict;

create unique index direct_payables_factoring_issued_document_unique_idx
  on public.direct_payables (factoring_issued_document_id)
  where factoring_issued_document_id is not null;
