-- Perfil de captura: puede registrar documentos sin ver información financiera
-- agregada ni documentos de otros usuarios.
alter type public.organization_role add value if not exists 'data_entry';

alter table public.received_documents
  add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();

create index if not exists received_documents_created_by_idx
  on public.received_documents (created_by)
  where created_by is not null;

-- Documentos emitidos: el digitador sólo puede crear y consultar los suyos.
drop policy if exists "members read issued documents" on public.issued_documents;
drop policy if exists "authorized roles create issued documents" on public.issued_documents;

create policy "authorized roles read issued documents" on public.issued_documents
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')
  )
);

create policy "data entry users read own issued documents" on public.issued_documents
for select to authenticated using (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

create policy "authorized roles create issued documents" on public.issued_documents
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations')
  )
);

create policy "data entry users create own issued documents" on public.issued_documents
for insert to authenticated with check (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

-- Documentos recibidos: captura inicial, sin edición, pago ni aprobación.
create policy "data entry users read own received documents" on public.received_documents
for select to authenticated using (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = received_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

create policy "data entry users create own received documents" on public.received_documents
for insert to authenticated with check (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = received_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

grant insert on public.received_documents to authenticated;

-- Adjuntos privados: sólo se pueden abrir o eliminar por el digitador que los
-- subió; el resto de los roles mantiene su acceso actual por organización.
drop policy if exists "members read issued document objects" on storage.objects;
drop policy if exists "operators upload issued document objects" on storage.objects;
drop policy if exists "operators delete issued document objects" on storage.objects;

create policy "authorized roles read issued document objects" on storage.objects
for select to authenticated using (
  bucket_id = 'issued-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')
  )
);

create policy "data entry users read own issued document objects" on storage.objects
for select to authenticated using (
  bucket_id = 'issued-document-files'
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

create policy "authorized roles upload issued document objects" on storage.objects
for insert to authenticated with check (
  bucket_id = 'issued-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations', 'data_entry')
  )
);

create policy "authorized roles delete issued document objects" on storage.objects
for delete to authenticated using (
  bucket_id = 'issued-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'operations')
  )
);

create policy "data entry users delete own issued document objects" on storage.objects
for delete to authenticated using (
  bucket_id = 'issued-document-files'
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

drop policy if exists "expense readers read received document objects" on storage.objects;
drop policy if exists "finance uploads received document objects" on storage.objects;
drop policy if exists "finance deletes received document objects" on storage.objects;

create policy "authorized roles read received document objects" on storage.objects
for select to authenticated using (
  bucket_id = 'received-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'auditor')
  )
);

create policy "data entry users read own received document objects" on storage.objects
for select to authenticated using (
  bucket_id = 'received-document-files'
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

create policy "authorized roles upload received document objects" on storage.objects
for insert to authenticated with check (
  bucket_id = 'received-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance', 'data_entry')
  )
);

create policy "authorized roles delete received document objects" on storage.objects
for delete to authenticated using (
  bucket_id = 'received-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text in ('administrator', 'finance')
  )
);

create policy "data entry users delete own received document objects" on storage.objects
for delete to authenticated using (
  bucket_id = 'received-document-files'
  and owner_id = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

-- Estos datos no son necesarios para digitar y pueden revelar resultados,
-- pagos, remuneraciones, planificación, relaciones comerciales o aprobaciones.
drop policy if exists "members read collection followups" on public.collection_followups;
create policy "authorized roles read collection followups" on public.collection_followups for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = collection_followups.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor'))
);

drop policy if exists "members read financial periods" on public.financial_periods;
drop policy if exists "members read chart of accounts" on public.chart_of_accounts;
drop policy if exists "members read planning versions" on public.planning_versions;
drop policy if exists "members read planning lines" on public.planning_lines;
create policy "authorized roles read financial periods" on public.financial_periods for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read chart of accounts" on public.chart_of_accounts for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read planning versions" on public.planning_versions for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read planning lines" on public.planning_lines for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));

drop policy if exists "members read person cost centers" on public.payroll_person_cost_center_assignments;
drop policy if exists "members read center customers" on public.cost_center_customer_links;
create policy "authorized roles read person cost centers" on public.payroll_person_cost_center_assignments for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = payroll_person_cost_center_assignments.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read center customers" on public.cost_center_customer_links for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = cost_center_customer_links.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));

drop policy if exists "members read counterparty contacts" on public.counterparty_contacts;
drop policy if exists "members read service catalog" on public.service_catalog;
drop policy if exists "members read customer services" on public.customer_services;
drop policy if exists "members read customer files" on public.customer_files;
create policy "authorized roles read counterparty contacts" on public.counterparty_contacts for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = counterparty_contacts.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read service catalog" on public.service_catalog for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = service_catalog.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read customer services" on public.customer_services for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_services.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read customer files" on public.customer_files for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_files.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));

drop policy if exists "members read preinvoices" on public.preinvoices;
drop policy if exists "members read preinvoice lines" on public.preinvoice_lines;
drop policy if exists "members read approval policies" on public.approval_policies;
drop policy if exists "members read approval requests" on public.approval_requests;
drop policy if exists "members read approval steps" on public.approval_steps;
drop policy if exists "members read issued document payments" on public.issued_document_payments;
create policy "authorized roles read preinvoices" on public.preinvoices for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = preinvoices.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read preinvoice lines" on public.preinvoice_lines for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = preinvoice_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read approval policies" on public.approval_policies for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = approval_policies.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read approval requests" on public.approval_requests for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = approval_requests.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read approval steps" on public.approval_steps for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = approval_steps.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read issued document payments" on public.issued_document_payments for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = issued_document_payments.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));

drop policy if exists "members read forecast lines" on public.forecast_lines;
create policy "authorized roles read forecast lines" on public.forecast_lines for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = forecast_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));

drop policy if exists "members read their source workbooks" on storage.objects;
create policy "authorized roles read source workbooks" on storage.objects for select to authenticated using (
  bucket_id = 'source-workbooks'
  and exists (select 1 from public.organization_memberships membership where membership.organization_id::text = split_part(name, '/', 1) and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor'))
);

drop policy if exists "members read customer document objects" on storage.objects;
create policy "authorized roles read customer document objects" on storage.objects for select to authenticated using (
  bucket_id = 'customer-documents'
  and exists (select 1 from public.organization_memberships membership where membership.organization_id::text = split_part(name, '/', 1) and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor'))
);

drop policy if exists "members read commercial opportunities" on public.commercial_opportunities;
drop policy if exists "members read commercial contracts" on public.commercial_contracts;
drop policy if exists "members read commercial projects" on public.commercial_projects;
drop policy if exists "members read commercial activities" on public.commercial_activities;
create policy "authorized roles read commercial opportunities" on public.commercial_opportunities for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_opportunities.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read commercial contracts" on public.commercial_contracts for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_contracts.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read commercial projects" on public.commercial_projects for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_projects.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read commercial activities" on public.commercial_activities for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_activities.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));

drop policy if exists "members read public market radar settings" on public.public_market_radar_settings;
drop policy if exists "members read public market radar runs" on public.public_market_radar_runs;
drop policy if exists "members read public market tenders" on public.public_market_tenders;
drop policy if exists "members read public market documents" on public.public_market_documents;
drop policy if exists "members read public market award history" on public.public_market_award_history;
create policy "authorized roles read public market radar settings" on public.public_market_radar_settings for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_settings.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read public market radar runs" on public.public_market_radar_runs for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_radar_runs.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read public market tenders" on public.public_market_tenders for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_tenders.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read public market documents" on public.public_market_documents for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_documents.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));
create policy "authorized roles read public market award history" on public.public_market_award_history for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = public_market_award_history.organization_id and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor')));

drop policy if exists "members read public market document objects" on storage.objects;
create policy "authorized roles read public market document objects" on storage.objects for select to authenticated using (
  bucket_id = 'public-market-documents'
  and exists (select 1 from public.organization_memberships membership where membership.organization_id::text = (storage.foldername(name))[1] and membership.user_id = (select auth.uid()) and membership.role::text in ('administrator', 'finance', 'operations', 'auditor'))
);
