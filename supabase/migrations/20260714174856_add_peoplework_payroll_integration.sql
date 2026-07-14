-- Integración de remuneraciones PeopleWork.
-- Se conserva sólo costo consolidado por período, categoría y centro de costo;
-- las liquidaciones y datos personales de colaboradores no se copian a Atlas.

create type public.payroll_sync_status as enum (
  'needs_configuration',
  'queued',
  'running',
  'succeeded',
  'failed'
);

create table public.payroll_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'peoplework' check (provider = 'peoplework'),
  api_base_url text,
  is_active boolean not null default false,
  last_sync_at timestamptz,
  last_sync_status public.payroll_sync_status not null default 'needs_configuration',
  last_period_month date,
  configured_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider),
  unique (id, organization_id),
  check (last_period_month is null or last_period_month = date_trunc('month', last_period_month)::date)
);

create table public.payroll_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid not null,
  period_month date not null,
  status public.payroll_sync_status not null default 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  source_reference text,
  payload_sha256 char(64),
  records_received integer not null default 0 check (records_received >= 0),
  records_accepted integer not null default 0 check (records_accepted >= 0),
  records_rejected integer not null default 0 check (records_rejected >= 0),
  error_summary text,
  initiated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (integration_id, organization_id) references public.payroll_integrations (id, organization_id) on delete cascade,
  unique (id, organization_id),
  check (period_month = date_trunc('month', period_month)::date),
  check (finished_at is null or started_at is not null),
  check (status <> 'succeeded' or finished_at is not null)
);

create table public.payroll_cost_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sync_run_id uuid not null,
  period_month date not null,
  cost_category text not null,
  cost_center_code text,
  cost_center_name text,
  amount numeric(18, 2) not null,
  currency_code char(3) not null default 'CLP',
  source_record_sha256 char(64) not null,
  created_at timestamptz not null default now(),
  foreign key (sync_run_id, organization_id) references public.payroll_sync_runs (id, organization_id) on delete cascade,
  unique (sync_run_id, source_record_sha256),
  check (period_month = date_trunc('month', period_month)::date),
  check (amount >= 0),
  check (currency_code ~ '^[A-Z]{3}$')
);

create index payroll_integrations_organization_idx on public.payroll_integrations (organization_id);
create index payroll_sync_runs_organization_period_idx on public.payroll_sync_runs (organization_id, period_month desc);
create index payroll_sync_runs_integration_status_idx on public.payroll_sync_runs (integration_id, status, created_at desc);
create index payroll_cost_lines_organization_period_idx on public.payroll_cost_lines (organization_id, period_month desc);
create index payroll_cost_lines_sync_run_idx on public.payroll_cost_lines (sync_run_id);
create index payroll_cost_lines_cost_center_period_idx on public.payroll_cost_lines (organization_id, cost_center_code, period_month desc) where cost_center_code is not null;

create trigger payroll_integrations_set_updated_at before update on public.payroll_integrations
for each row execute function public.set_updated_at();

create or replace function public.audit_payroll_sync_run_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    coalesce(new.organization_id, old.organization_id),
    auth.uid(),
    'payroll_sync_run',
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger payroll_sync_runs_audit_changes
after insert or update or delete on public.payroll_sync_runs
for each row execute function public.audit_payroll_sync_run_changes();

revoke all on function public.audit_payroll_sync_run_changes() from public, anon, authenticated;

alter table public.payroll_integrations enable row level security;
alter table public.payroll_sync_runs enable row level security;
alter table public.payroll_cost_lines enable row level security;

create policy "administrators read payroll integration settings" on public.payroll_integrations
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_integrations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);
create policy "administrators create payroll integration settings" on public.payroll_integrations
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_integrations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);
create policy "administrators update payroll integration settings" on public.payroll_integrations
for update to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_integrations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_integrations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'administrator'
  )
);

create policy "finance reads payroll sync runs" on public.payroll_sync_runs
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_sync_runs.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);
create policy "finance manages payroll sync runs" on public.payroll_sync_runs
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_sync_runs.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_sync_runs.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance reads payroll cost lines" on public.payroll_cost_lines
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_cost_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);
create policy "finance manages payroll cost lines" on public.payroll_cost_lines
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_cost_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_cost_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

revoke all on public.payroll_integrations, public.payroll_sync_runs, public.payroll_cost_lines from anon;
grant select, insert, update, delete on public.payroll_integrations, public.payroll_sync_runs, public.payroll_cost_lines to authenticated;
