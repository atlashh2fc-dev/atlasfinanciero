alter table public.issued_documents
  add column cost_center_id uuid references public.cost_centers(id) on delete set null;

alter table public.received_documents
  add column cost_center_id uuid references public.cost_centers(id) on delete set null;

create index issued_documents_cost_center_idx
  on public.issued_documents (organization_id, cost_center_id, issue_date desc)
  where cost_center_id is not null;
create index received_documents_cost_center_idx
  on public.received_documents (organization_id, cost_center_id, issue_date desc)
  where cost_center_id is not null;
