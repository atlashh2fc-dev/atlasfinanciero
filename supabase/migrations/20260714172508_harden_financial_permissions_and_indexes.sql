-- Evita evaluación duplicada de políticas SELECT y cubre todas las claves foráneas
-- de la capa financiera con índices aptos para consultas y borrados referenciados.

create index financial_periods_closed_by_idx on public.financial_periods (closed_by) where closed_by is not null;
create index chart_of_accounts_parent_idx on public.chart_of_accounts (parent_account_id) where parent_account_id is not null;
create index accounting_entries_period_organization_idx on public.accounting_entries (financial_period_id, organization_id);
create index accounting_entries_created_by_idx on public.accounting_entries (created_by) where created_by is not null;
create index accounting_entries_posted_by_idx on public.accounting_entries (posted_by) where posted_by is not null;
create index accounting_entries_reversed_entry_idx on public.accounting_entries (reversed_entry_id) where reversed_entry_id is not null;
create index accounting_lines_entry_organization_idx on public.accounting_entry_lines (entry_id, organization_id);
create index accounting_lines_account_organization_idx on public.accounting_entry_lines (account_id, organization_id);
create index accounting_lines_organization_idx on public.accounting_entry_lines (organization_id);
create index revenue_schedules_source_document_idx on public.revenue_recognition_schedules (source_document_id) where source_document_id is not null;
create index revenue_schedules_approved_by_idx on public.revenue_recognition_schedules (approved_by) where approved_by is not null;
create index planning_versions_approved_by_idx on public.planning_versions (approved_by) where approved_by is not null;
create index planning_versions_created_by_idx on public.planning_versions (created_by) where created_by is not null;
create index planning_lines_account_idx on public.planning_lines (account_id) where account_id is not null;
create index planning_lines_organization_idx on public.planning_lines (organization_id);
create index planning_lines_version_organization_idx on public.planning_lines (planning_version_id, organization_id);

drop policy "finance manages financial periods" on public.financial_periods;
drop policy "finance manages chart of accounts" on public.chart_of_accounts;
drop policy "finance manages accounting entries" on public.accounting_entries;
drop policy "finance manages accounting entry lines" on public.accounting_entry_lines;
drop policy "finance manages revenue schedules" on public.revenue_recognition_schedules;
drop policy "finance manages planning versions" on public.planning_versions;
drop policy "finance manages planning lines" on public.planning_lines;

create policy "finance creates financial periods" on public.financial_periods for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance updates financial periods" on public.financial_periods for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance deletes financial periods" on public.financial_periods for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);

create policy "finance creates chart accounts" on public.chart_of_accounts for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance updates chart accounts" on public.chart_of_accounts for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance deletes chart accounts" on public.chart_of_accounts for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);

create policy "finance creates accounting entries" on public.accounting_entries for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entries.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance updates accounting entries" on public.accounting_entries for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entries.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entries.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance deletes accounting entries" on public.accounting_entries for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entries.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);

create policy "finance creates accounting entry lines" on public.accounting_entry_lines for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entry_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance updates accounting entry lines" on public.accounting_entry_lines for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entry_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entry_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance deletes accounting entry lines" on public.accounting_entry_lines for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entry_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);

create policy "finance creates revenue schedules" on public.revenue_recognition_schedules for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = revenue_recognition_schedules.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance updates revenue schedules" on public.revenue_recognition_schedules for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = revenue_recognition_schedules.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = revenue_recognition_schedules.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance deletes revenue schedules" on public.revenue_recognition_schedules for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = revenue_recognition_schedules.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);

create policy "finance creates planning versions" on public.planning_versions for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance updates planning versions" on public.planning_versions for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance deletes planning versions" on public.planning_versions for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);

create policy "finance creates planning lines" on public.planning_lines for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance updates planning lines" on public.planning_lines for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance deletes planning lines" on public.planning_lines for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
