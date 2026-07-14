-- Índices que cubren las claves foráneas compuestas y evita evaluar dos veces
-- la misma regla de lectura al consultar una sincronización.

drop policy "finance reads payroll sync runs" on public.payroll_sync_runs;
drop policy "finance reads payroll cost lines" on public.payroll_cost_lines;

drop index public.payroll_sync_runs_integration_status_idx;
drop index public.payroll_cost_lines_sync_run_idx;

create index payroll_integrations_configured_by_idx on public.payroll_integrations (configured_by) where configured_by is not null;
create index payroll_sync_runs_initiated_by_idx on public.payroll_sync_runs (initiated_by) where initiated_by is not null;
create index payroll_sync_runs_integration_organization_status_idx on public.payroll_sync_runs (integration_id, organization_id, status, created_at desc);
create index payroll_cost_lines_sync_run_organization_idx on public.payroll_cost_lines (sync_run_id, organization_id);
