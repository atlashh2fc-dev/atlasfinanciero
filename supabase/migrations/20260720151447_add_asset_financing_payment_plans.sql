-- Un expediente de financiamiento conserva tres dimensiones: obligación de
-- pago, cuota de caja y amortización contable del activo.

create table public.asset_financing_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_number text not null,
  supplier_counterparty_id uuid,
  supplier_name text not null,
  asset_name text not null,
  contract_reference text,
  cost_center_id uuid,
  currency_code char(3) not null check (currency_code in ('CLP', 'UF')),
  asset_acquisition_amount numeric(18, 4) not null check (asset_acquisition_amount > 0),
  financing_total_amount numeric(18, 4) not null check (financing_total_amount >= asset_acquisition_amount),
  asset_cost_clp numeric(18, 2) not null check (asset_cost_clp > 0),
  residual_value_clp numeric(18, 2) not null default 0 check (residual_value_clp >= 0 and residual_value_clp < asset_cost_clp),
  installment_count smallint not null check (installment_count between 1 and 240),
  first_due_date date not null,
  useful_life_months smallint not null check (useful_life_months between 1 and 600),
  amortization_start_month date not null,
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'rejected', 'cancelled', 'completed')),
  notes text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, plan_number),
  foreign key (supplier_counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete restrict,
  foreign key (cost_center_id, organization_id) references public.cost_centers (id, organization_id) on delete restrict,
  check (length(btrim(plan_number)) > 0),
  check (length(btrim(supplier_name)) > 0),
  check (length(btrim(asset_name)) > 0),
  check (amortization_start_month = date_trunc('month', amortization_start_month)::date)
);

create table public.asset_financing_installments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null,
  installment_number smallint not null check (installment_number > 0),
  due_date date not null,
  currency_amount numeric(18, 4) not null check (currency_amount > 0),
  principal_amount numeric(18, 4) not null check (principal_amount >= 0),
  finance_charge_amount numeric(18, 4) not null check (finance_charge_amount >= 0),
  created_at timestamptz not null default now(),
  foreign key (plan_id, organization_id) references public.asset_financing_plans (id, organization_id) on delete cascade,
  unique (id, organization_id),
  unique (plan_id, installment_number),
  check (currency_amount = principal_amount + finance_charge_amount)
);

create table public.asset_amortization_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_id uuid not null,
  period_month date not null,
  opening_balance_clp numeric(18, 2) not null check (opening_balance_clp >= 0),
  amortization_amount_clp numeric(18, 2) not null check (amortization_amount_clp >= 0),
  closing_balance_clp numeric(18, 2) not null check (closing_balance_clp >= 0),
  created_at timestamptz not null default now(),
  foreign key (plan_id, organization_id) references public.asset_financing_plans (id, organization_id) on delete cascade,
  unique (plan_id, period_month),
  check (period_month = date_trunc('month', period_month)::date),
  check (opening_balance_clp - amortization_amount_clp = closing_balance_clp)
);

alter table public.direct_payables add column asset_financing_installment_id uuid;
alter table public.direct_payables add constraint direct_payables_asset_financing_installment_fkey foreign key (asset_financing_installment_id, organization_id) references public.asset_financing_installments (id, organization_id) on delete restrict;
create unique index direct_payables_asset_financing_installment_unique_idx on public.direct_payables (asset_financing_installment_id) where asset_financing_installment_id is not null;
create index asset_financing_plans_org_status_idx on public.asset_financing_plans (organization_id, status, first_due_date);
create index asset_financing_installments_org_due_idx on public.asset_financing_installments (organization_id, due_date);
create index asset_amortization_schedules_org_period_idx on public.asset_amortization_schedules (organization_id, period_month);

create trigger asset_financing_plans_set_updated_at before update on public.asset_financing_plans for each row execute function public.set_updated_at();

create or replace function public.enforce_asset_financing_plan_transition()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.status = old.status then
    if old.status <> 'draft' then raise exception 'Only draft financing plans can be edited'; end if;
  elsif old.status = 'draft' and new.status = 'review' then null;
  elsif old.status = 'review' and new.status in ('approved', 'rejected') then
    if not exists (select 1 from public.approval_requests request where request.organization_id = new.organization_id and request.target_type = 'payment' and request.target_id = new.id and request.status = new.status and request.metadata->>'kind' = 'asset_financing_plan') then raise exception 'Financing plan must be decided in approvals'; end if;
  elsif old.status = 'approved' and new.status = 'completed' then null;
  elsif old.status in ('draft', 'review', 'approved', 'rejected') and new.status = 'cancelled' then null;
  else raise exception 'Invalid financing plan transition'; end if;
  return new;
end;
$$;
create trigger asset_financing_plans_enforce_transition before update on public.asset_financing_plans for each row execute function public.enforce_asset_financing_plan_transition();

create or replace function public.sync_asset_financing_plan_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
declare policy_id uuid;
begin
  if new.status <> 'review' or old.status <> 'draft' then return new; end if;
  select id into policy_id from public.approval_policies where organization_id = new.organization_id and target_type = 'payment' and is_active and currency_code = new.currency_code and minimum_amount <= new.financing_total_amount and (maximum_amount is null or maximum_amount >= new.financing_total_amount) order by minimum_amount desc limit 1;
  if policy_id is null then raise exception 'No approval policy applies'; end if;
  insert into public.approval_requests (organization_id, approval_policy_id, target_type, target_id, title, description, amount, currency_code, requested_by, metadata)
  values (new.organization_id, policy_id, 'payment', new.id, 'Financiamiento de activo ' || new.plan_number, new.asset_name, new.financing_total_amount, new.currency_code, coalesce(new.created_by, auth.uid()), jsonb_build_object('kind', 'asset_financing_plan'));
  return new;
end;
$$;
create trigger asset_financing_plans_sync_approval after update of status on public.asset_financing_plans for each row execute function public.sync_asset_financing_plan_approval();

create or replace function public.materialize_asset_financing_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare plan_row public.asset_financing_plans%rowtype;
begin
  if old.status <> 'submitted' or new.status not in ('approved', 'rejected') or new.metadata->>'kind' <> 'asset_financing_plan' then return new; end if;
  select * into plan_row from public.asset_financing_plans where id = new.target_id and organization_id = new.organization_id for update;
  if not found or plan_row.status <> 'review' then return new; end if;
  if new.status = 'rejected' then update public.asset_financing_plans set status = 'rejected' where id = plan_row.id;
  else
    update public.asset_financing_plans set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid() where id = plan_row.id;
    insert into public.direct_payables (organization_id, payable_number, supplier_counterparty_id, supplier_name, category, description, issue_date, due_date, currency_code, total_amount, status, notes, approved_at, approved_by, created_by, asset_financing_installment_id)
    select plan_row.organization_id, plan_row.plan_number || '-' || lpad(installment.installment_number::text, 3, '0'), plan_row.supplier_counterparty_id, plan_row.supplier_name, 'other', plan_row.asset_name || ' · cuota ' || installment.installment_number || '/' || plan_row.installment_count, plan_row.first_due_date, installment.due_date, plan_row.currency_code, installment.currency_amount, 'approved', plan_row.notes, coalesce(new.completed_at, now()), auth.uid(), plan_row.created_by, installment.id
    from public.asset_financing_installments installment where installment.plan_id = plan_row.id;
  end if;
  return new;
end;
$$;
create trigger approval_requests_materialize_asset_financing after update of status on public.approval_requests for each row execute function public.materialize_asset_financing_plan();

alter table public.asset_financing_plans enable row level security;
alter table public.asset_financing_installments enable row level security;
alter table public.asset_amortization_schedules enable row level security;
create policy "members read asset financing plans" on public.asset_financing_plans for select to authenticated using (exists (select 1 from public.organization_memberships m where m.organization_id = asset_financing_plans.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations', 'auditor')));
create policy "members read asset financing installments" on public.asset_financing_installments for select to authenticated using (exists (select 1 from public.organization_memberships m where m.organization_id = asset_financing_installments.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations', 'auditor')));
create policy "members read asset amortization schedules" on public.asset_amortization_schedules for select to authenticated using (exists (select 1 from public.organization_memberships m where m.organization_id = asset_amortization_schedules.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations', 'auditor')));
create policy "finance manages asset financing plans" on public.asset_financing_plans for all to authenticated using (exists (select 1 from public.organization_memberships m where m.organization_id = asset_financing_plans.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))) with check (exists (select 1 from public.organization_memberships m where m.organization_id = asset_financing_plans.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance')));
create policy "finance manages asset financing installments" on public.asset_financing_installments for all to authenticated using (exists (select 1 from public.organization_memberships m where m.organization_id = asset_financing_installments.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))) with check (exists (select 1 from public.organization_memberships m where m.organization_id = asset_financing_installments.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance')));
create policy "finance manages asset amortization schedules" on public.asset_amortization_schedules for all to authenticated using (exists (select 1 from public.organization_memberships m where m.organization_id = asset_amortization_schedules.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))) with check (exists (select 1 from public.organization_memberships m where m.organization_id = asset_amortization_schedules.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance')));
grant select, insert, update, delete on public.asset_financing_plans, public.asset_financing_installments, public.asset_amortization_schedules to authenticated;
revoke all on function public.enforce_asset_financing_plan_transition() from public, anon, authenticated;
revoke all on function public.sync_asset_financing_plan_approval() from public, anon, authenticated;
revoke all on function public.materialize_asset_financing_plan() from public, anon, authenticated;
