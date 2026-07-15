-- P2: planificación financiera. El presupuesto conserva versiones explícitas;
-- los reales provienen de los documentos y la caja de los bancos/documentos
-- pendientes. No se altera información contable de origen.

create type public.financial_plan_status as enum ('draft', 'active', 'archived');
create type public.financial_budget_kind as enum ('revenue', 'expense');
create type public.cash_flow_direction as enum ('inflow', 'outflow');

create table public.financial_plan_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_year integer not null,
  name text not null,
  status public.financial_plan_status not null default 'draft',
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  activated_by uuid references auth.users(id) on delete set null,
  unique (id, organization_id),
  unique (organization_id, fiscal_year, name),
  check (fiscal_year between 2000 and 2100),
  check (length(btrim(name)) > 0),
  check ((status = 'active') = (activated_at is not null))
);

-- Sólo una versión activa por año evita sumar presupuestos de escenarios
-- distintos. Los borradores pueden coexistir para simulación y preparación.
create unique index financial_plan_versions_one_active_year_idx
  on public.financial_plan_versions (organization_id, fiscal_year)
  where status = 'active';

create table public.financial_budget_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_version_id uuid not null,
  period_month date not null,
  kind public.financial_budget_kind not null,
  name text not null,
  amount numeric(18, 2) not null check (amount >= 0),
  cost_center_id uuid,
  counterparty_id uuid,
  service_catalog_id uuid,
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (plan_version_id, organization_id)
    references public.financial_plan_versions (id, organization_id) on delete cascade,
  foreign key (cost_center_id, organization_id)
    references public.cost_centers (id, organization_id) on delete restrict,
  foreign key (counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  foreign key (service_catalog_id, organization_id)
    references public.service_catalog (id, organization_id) on delete restrict,
  check (period_month = date_trunc('month', period_month)::date),
  check (length(btrim(name)) > 0)
);

create table public.cash_forecast_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  horizon_weeks smallint not null default 13 check (horizon_weeks between 4 and 26),
  include_overdue_in_first_week boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ajustes manuales cubren egresos/ingresos comprometidos que aún no se han
-- convertido en un documento tributario, siempre visibles y auditables.
create table public.cash_forecast_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  expected_on date not null,
  direction public.cash_flow_direction not null,
  amount numeric(18, 2) not null check (amount > 0),
  description text not null,
  counterparty_id uuid,
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete set null,
  check (length(btrim(description)) > 0)
);

-- Imputación de costo a un cliente o servicio para margen de contribución.
-- Las asignaciones nunca pueden exceder el neto del documento recibido.
create table public.profitability_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  received_document_id uuid not null,
  counterparty_id uuid not null,
  customer_service_id uuid,
  allocated_amount numeric(18, 2) not null check (allocated_amount > 0),
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (received_document_id, organization_id)
    references public.received_documents (id, organization_id) on delete cascade,
  foreign key (counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  foreign key (customer_service_id, organization_id)
    references public.customer_services (id, organization_id) on delete restrict
);

create index financial_budget_lines_plan_period_idx
  on public.financial_budget_lines (plan_version_id, period_month, kind);
create index financial_budget_lines_org_period_idx
  on public.financial_budget_lines (organization_id, period_month, kind);
create index cash_forecast_adjustments_org_expected_idx
  on public.cash_forecast_adjustments (organization_id, expected_on, direction);
create index profitability_cost_allocations_document_idx
  on public.profitability_cost_allocations (received_document_id, organization_id);
create index profitability_cost_allocations_customer_idx
  on public.profitability_cost_allocations (organization_id, counterparty_id);

create trigger financial_plan_versions_set_updated_at before update on public.financial_plan_versions
for each row execute function public.set_updated_at();
create trigger financial_budget_lines_set_updated_at before update on public.financial_budget_lines
for each row execute function public.set_updated_at();
create trigger cash_forecast_settings_set_updated_at before update on public.cash_forecast_settings
for each row execute function public.set_updated_at();
create trigger cash_forecast_adjustments_set_updated_at before update on public.cash_forecast_adjustments
for each row execute function public.set_updated_at();
create trigger profitability_cost_allocations_set_updated_at before update on public.profitability_cost_allocations
for each row execute function public.set_updated_at();

create or replace function public.enforce_financial_plan_version_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    if not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = new.organization_id
        and membership.user_id = (select auth.uid())
        and membership.role in ('administrator', 'finance')
    ) then
      raise exception 'finance role is required to activate a financial plan';
    end if;
    new.activated_at := now();
    new.activated_by := (select auth.uid());
  elsif new.status <> 'active' then
    new.activated_at := null;
    new.activated_by := null;
  end if;
  return new;
end;
$$;

create trigger financial_plan_versions_enforce_status
before update of status on public.financial_plan_versions
for each row execute function public.enforce_financial_plan_version_status();

create or replace function public.validate_profitability_cost_allocation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_net numeric(18, 2);
  allocated_total numeric(18, 2);
  service_customer_id uuid;
begin
  select abs(net_amount) into document_net
  from public.received_documents
  where id = new.received_document_id and organization_id = new.organization_id
  for update;

  if document_net is null or document_net <= 0 then
    raise exception 'allocation requires a received document with a positive net amount';
  end if;

  if new.customer_service_id is not null then
    select counterparty_id into service_customer_id
    from public.customer_services
    where id = new.customer_service_id and organization_id = new.organization_id;
    if service_customer_id is null or service_customer_id <> new.counterparty_id then
      raise exception 'customer service must belong to the allocated customer';
    end if;
  end if;

  select coalesce(sum(allocated_amount), 0) into allocated_total
  from public.profitability_cost_allocations
  where received_document_id = new.received_document_id
    and organization_id = new.organization_id
    and (tg_op <> 'UPDATE' or id <> old.id);

  if allocated_total + new.allocated_amount > document_net then
    raise exception 'cost allocation exceeds the received document net amount';
  end if;
  return new;
end;
$$;

create trigger profitability_cost_allocations_validate
before insert or update on public.profitability_cost_allocations
for each row execute function public.validate_profitability_cost_allocation();

create or replace function public.audit_financial_planning_changes()
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
    (select auth.uid()),
    case tg_table
      when 'financial_plan_versions' then 'financial_plan_version'
      when 'financial_budget_lines' then 'financial_budget_line'
      when 'cash_forecast_adjustments' then 'cash_forecast_adjustment'
      else 'profitability_cost_allocation'
    end,
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger financial_plan_versions_audit after insert or update or delete on public.financial_plan_versions
for each row execute function public.audit_financial_planning_changes();
create trigger financial_budget_lines_audit after insert or update or delete on public.financial_budget_lines
for each row execute function public.audit_financial_planning_changes();
create trigger cash_forecast_adjustments_audit after insert or update or delete on public.cash_forecast_adjustments
for each row execute function public.audit_financial_planning_changes();
create trigger profitability_cost_allocations_audit after insert or update or delete on public.profitability_cost_allocations
for each row execute function public.audit_financial_planning_changes();

alter table public.financial_plan_versions enable row level security;
alter table public.financial_budget_lines enable row level security;
alter table public.cash_forecast_settings enable row level security;
alter table public.cash_forecast_adjustments enable row level security;
alter table public.profitability_cost_allocations enable row level security;

create policy "finance and audit read plan versions" on public.financial_plan_versions
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_plan_versions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance manages plan versions" on public.financial_plan_versions
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_plan_versions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_plan_versions.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
);

create policy "finance and audit read budget lines" on public.financial_budget_lines
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_budget_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance manages budget lines" on public.financial_budget_lines
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_budget_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = financial_budget_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
);

create policy "finance and audit read cash forecast settings" on public.cash_forecast_settings
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = cash_forecast_settings.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance manages cash forecast settings" on public.cash_forecast_settings
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = cash_forecast_settings.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = cash_forecast_settings.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
);

create policy "finance and audit read cash forecast adjustments" on public.cash_forecast_adjustments
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = cash_forecast_adjustments.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance manages cash forecast adjustments" on public.cash_forecast_adjustments
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = cash_forecast_adjustments.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = cash_forecast_adjustments.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
);

create policy "finance and audit read profitability allocations" on public.profitability_cost_allocations
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = profitability_cost_allocations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance manages profitability allocations" on public.profitability_cost_allocations
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = profitability_cost_allocations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = profitability_cost_allocations.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance'))
);

grant select, insert, update, delete on public.financial_plan_versions to authenticated;
grant select, insert, update, delete on public.financial_budget_lines to authenticated;
grant select, insert, update, delete on public.cash_forecast_settings to authenticated;
grant select, insert, update, delete on public.cash_forecast_adjustments to authenticated;
grant select, insert, update, delete on public.profitability_cost_allocations to authenticated;
revoke all on function public.enforce_financial_plan_version_status() from public, anon, authenticated;
revoke all on function public.validate_profitability_cost_allocation() from public, anon, authenticated;
revoke all on function public.audit_financial_planning_changes() from public, anon, authenticated;
