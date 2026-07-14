-- Base contable IFRS-ready. No reclasifica ni reconoce importes existentes:
-- las facturas y forecast permanecen como fuentes de gestión hasta contar con
-- contratos, obligaciones de desempeño, mayor, cierres y políticas aprobadas.

create type public.financial_period_status as enum ('open', 'soft_closed', 'closed', 'locked');
create type public.account_nature as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
create type public.normal_balance as enum ('debit', 'credit');
create type public.financial_statement_area as enum (
  'statement_of_financial_position', 'profit_or_loss', 'other_comprehensive_income', 'cash_flow', 'management'
);
create type public.accounting_entry_status as enum ('draft', 'posted', 'reversed');
create type public.planning_scenario_kind as enum ('budget', 'forecast', 'actual', 'rolling_forecast');

create table public.financial_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status public.financial_period_status not null default 'open',
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, period_start),
  unique (id, organization_id),
  check (period_end >= period_start),
  check ((status in ('closed', 'locked')) = (closed_at is not null))
);

create table public.chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_code text not null,
  account_name text not null,
  nature public.account_nature not null,
  normal_balance public.normal_balance not null,
  statement_area public.financial_statement_area not null,
  presentation_group text,
  parent_account_id uuid references public.chart_of_accounts(id) on delete restrict,
  is_postable boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, account_code),
  unique (id, organization_id)
);

create table public.accounting_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  financial_period_id uuid not null,
  entry_date date not null,
  status public.accounting_entry_status not null default 'draft',
  description text not null,
  external_reference text,
  source_document_id uuid references public.issued_documents(id) on delete set null,
  reversed_entry_id uuid references public.accounting_entries(id) on delete restrict,
  posted_at timestamptz,
  posted_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (financial_period_id, organization_id) references public.financial_periods (id, organization_id),
  unique (id, organization_id),
  check ((status = 'posted') = (posted_at is not null))
);

create table public.accounting_entry_lines (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entry_id uuid not null,
  account_id uuid not null,
  line_number integer not null,
  description text,
  currency_code char(3) not null,
  functional_debit numeric(18, 2) not null default 0,
  functional_credit numeric(18, 2) not null default 0,
  transaction_amount numeric(18, 2),
  created_at timestamptz not null default now(),
  foreign key (entry_id, organization_id) references public.accounting_entries (id, organization_id) on delete cascade,
  foreign key (account_id, organization_id) references public.chart_of_accounts (id, organization_id) on delete restrict,
  unique (entry_id, line_number),
  check (functional_debit >= 0 and functional_credit >= 0),
  check ((functional_debit = 0) <> (functional_credit = 0))
);

create table public.revenue_recognition_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_document_id uuid references public.issued_documents(id) on delete set null,
  contract_reference text,
  performance_obligation text not null,
  recognition_start date not null,
  recognition_end date not null,
  recognised_amount numeric(18, 2) not null,
  currency_code char(3) not null,
  methodology text not null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (recognition_end >= recognition_start)
);

create table public.planning_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  scenario public.planning_scenario_kind not null,
  valid_from date not null,
  valid_to date not null,
  is_locked boolean not null default false,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name),
  unique (id, organization_id),
  check (valid_to >= valid_from)
);

create table public.planning_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  planning_version_id uuid not null,
  account_id uuid references public.chart_of_accounts(id) on delete restrict,
  period_month date not null,
  amount numeric(18, 2) not null,
  currency_code char(3) not null,
  driver_name text,
  source_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (planning_version_id, organization_id) references public.planning_versions (id, organization_id) on delete cascade
);

create index financial_periods_organization_period_idx on public.financial_periods (organization_id, period_start);
create index chart_of_accounts_organization_parent_idx on public.chart_of_accounts (organization_id, parent_account_id) where parent_account_id is not null;
create index accounting_entries_organization_date_idx on public.accounting_entries (organization_id, entry_date desc);
create index accounting_entries_period_idx on public.accounting_entries (financial_period_id);
create index accounting_entries_source_document_idx on public.accounting_entries (source_document_id) where source_document_id is not null;
create index accounting_lines_entry_idx on public.accounting_entry_lines (entry_id, line_number);
create index accounting_lines_account_idx on public.accounting_entry_lines (account_id);
create index revenue_schedules_organization_period_idx on public.revenue_recognition_schedules (organization_id, recognition_start, recognition_end);
create index planning_versions_organization_scenario_idx on public.planning_versions (organization_id, scenario, valid_from);
create index planning_lines_version_period_idx on public.planning_lines (planning_version_id, period_month);
create index issued_documents_customer_month_idx on public.issued_documents (organization_id, client_name, issue_date);

create trigger financial_periods_set_updated_at before update on public.financial_periods
for each row execute function public.set_updated_at();
create trigger chart_of_accounts_set_updated_at before update on public.chart_of_accounts
for each row execute function public.set_updated_at();
create trigger accounting_entries_set_updated_at before update on public.accounting_entries
for each row execute function public.set_updated_at();
create trigger revenue_recognition_schedules_set_updated_at before update on public.revenue_recognition_schedules
for each row execute function public.set_updated_at();
create trigger planning_versions_set_updated_at before update on public.planning_versions
for each row execute function public.set_updated_at();
create trigger planning_lines_set_updated_at before update on public.planning_lines
for each row execute function public.set_updated_at();

-- Un asiento puede permanecer incompleto en borrador, pero no se puede contabilizar
-- si sus débitos y créditos funcionales no cuadran.
create or replace function public.assert_posted_entry_balanced()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  total_debit numeric(18, 2);
  total_credit numeric(18, 2);
begin
  if new.status = 'posted' then
    select coalesce(sum(line.functional_debit), 0), coalesce(sum(line.functional_credit), 0)
      into total_debit, total_credit
    from public.accounting_entry_lines line
    where line.entry_id = new.id;
    if total_debit <> total_credit or total_debit = 0 then
      raise exception 'A posted accounting entry must have balanced non-zero functional debit and credit totals';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.prevent_posted_entry_line_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_entry_id uuid := coalesce(new.entry_id, old.entry_id);
begin
  if exists (select 1 from public.accounting_entries entry where entry.id = target_entry_id and entry.status = 'posted') then
    raise exception 'Lines of a posted accounting entry cannot be modified';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger accounting_entries_validate_posting before insert or update of status on public.accounting_entries
for each row execute function public.assert_posted_entry_balanced();
create trigger accounting_entry_lines_prevent_posted_changes before insert or update or delete on public.accounting_entry_lines
for each row execute function public.prevent_posted_entry_line_changes();

revoke all on function public.assert_posted_entry_balanced() from public, anon, authenticated;
revoke all on function public.prevent_posted_entry_line_changes() from public, anon, authenticated;

alter table public.financial_periods enable row level security;
alter table public.chart_of_accounts enable row level security;
alter table public.accounting_entries enable row level security;
alter table public.accounting_entry_lines enable row level security;
alter table public.revenue_recognition_schedules enable row level security;
alter table public.planning_versions enable row level security;
alter table public.planning_lines enable row level security;

create policy "members read financial periods" on public.financial_periods for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()))
);
create policy "members read chart of accounts" on public.chart_of_accounts for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()))
);
create policy "finance and auditors read accounting entries" on public.accounting_entries for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entries.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance and auditors read accounting entry lines" on public.accounting_entry_lines for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entry_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance and auditors read revenue schedules" on public.revenue_recognition_schedules for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = revenue_recognition_schedules.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "members read planning versions" on public.planning_versions for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()))
);
create policy "members read planning lines" on public.planning_lines for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()))
);

create policy "finance manages financial periods" on public.financial_periods for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = financial_periods.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance manages chart of accounts" on public.chart_of_accounts for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = chart_of_accounts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance manages accounting entries" on public.accounting_entries for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entries.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entries.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance manages accounting entry lines" on public.accounting_entry_lines for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entry_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = accounting_entry_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance manages revenue schedules" on public.revenue_recognition_schedules for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = revenue_recognition_schedules.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = revenue_recognition_schedules.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance manages planning versions" on public.planning_versions for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_versions.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);
create policy "finance manages planning lines" on public.planning_lines for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = planning_lines.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))
);

create view public.customer_monthly_evolution
with (security_invoker = true)
as
select
  document.organization_id,
  coalesce(document.client_name, document.recipient_name, 'No informado') as client_name,
  date_trunc('month', document.issue_date)::date as period_month,
  count(*) as document_count,
  sum(document.net_amount) as net_amount_documented,
  sum(document.total_amount) as total_amount_documented,
  sum(document.net_amount) filter (where document.payment_status = 'Pagada') as net_amount_status_pagada,
  sum(document.net_amount) filter (where document.payment_status = 'Pendiente') as net_amount_status_pendiente,
  count(*) filter (where document.payment_date is not null) as documents_with_payment_date,
  max(document.issue_date) as latest_issue_date
from public.issued_documents document
where document.issue_date is not null
group by document.organization_id, coalesce(document.client_name, document.recipient_name, 'No informado'), date_trunc('month', document.issue_date)::date;

create view public.monthly_forecast_evolution
with (security_invoker = true)
as
select
  forecast.organization_id,
  forecast.period_month,
  sum(forecast.amount) filter (where forecast.forecast_kind = 'Ingresos proyectados 2026') as projected_revenue,
  sum(forecast.amount) filter (where forecast.forecast_kind = 'Gastos proyectados 2026') as projected_expense,
  sum(forecast.amount) filter (where forecast.forecast_kind = 'Ingresos reales 2026') as source_real_block,
  sum(forecast.amount) filter (where forecast.forecast_kind = 'Ingresos proyectados 2026')
    - sum(forecast.amount) filter (where forecast.forecast_kind = 'Gastos proyectados 2026') as projected_simple_result
from public.forecast_lines forecast
group by forecast.organization_id, forecast.period_month;

grant select, insert, update, delete on public.financial_periods, public.chart_of_accounts, public.accounting_entries, public.accounting_entry_lines, public.revenue_recognition_schedules, public.planning_versions, public.planning_lines to authenticated;
grant select on public.customer_monthly_evolution, public.monthly_forecast_evolution to authenticated;
