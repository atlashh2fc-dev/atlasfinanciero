-- Índices de claves foráneas para importaciones, auditoría y consultas del ERP.
create index audit_log_organization_created_at_idx on public.audit_log (organization_id, created_at desc);
create index audit_log_actor_id_idx on public.audit_log (actor_id) where actor_id is not null;
create index counterparties_created_by_idx on public.counterparties (created_by) where created_by is not null;
create index forecast_lines_created_by_idx on public.forecast_lines (created_by) where created_by is not null;
create index forecast_lines_workbook_import_organization_idx on public.forecast_lines (workbook_import_id, organization_id) where workbook_import_id is not null;
create index import_batches_organization_id_idx on public.import_batches (organization_id);
create index import_batches_imported_by_idx on public.import_batches (imported_by) where imported_by is not null;
create index issued_documents_counterparty_id_idx on public.issued_documents (counterparty_id) where counterparty_id is not null;
create index issued_documents_created_by_idx on public.issued_documents (created_by) where created_by is not null;
create index issued_documents_import_batch_organization_idx on public.issued_documents (import_batch_id, organization_id) where import_batch_id is not null;
create index workbook_cells_organization_id_idx on public.workbook_cells (organization_id);
create index workbook_cells_import_organization_idx on public.workbook_cells (workbook_import_id, organization_id);
create index workbook_imports_organization_id_idx on public.workbook_imports (organization_id);
create index workbook_imports_imported_by_idx on public.workbook_imports (imported_by) where imported_by is not null;
