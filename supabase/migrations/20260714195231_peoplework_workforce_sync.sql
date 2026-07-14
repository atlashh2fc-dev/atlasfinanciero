-- Snapshot operativo de PeopleWork. Se persiste sólo información necesaria para
-- gestión financiera y de dotación; no se replica información bancaria, médica,
-- de contacto personal ni observaciones de licencias.

create table public.payroll_people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'peoplework' check (provider = 'peoplework'),
  external_employee_id text not null,
  national_identification text,
  full_name text not null,
  is_active boolean not null default true,
  management_name text,
  job_title text,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_employee_id),
  unique (id, organization_id)
);

create table public.payroll_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null,
  provider text not null default 'peoplework' check (provider = 'peoplework'),
  external_contract_id text not null,
  contract_status text,
  contract_type text,
  start_date date,
  end_date date,
  monthly_gross_salary numeric(18, 2) not null default 0 check (monthly_gross_salary >= 0),
  currency_code char(3) not null default 'CLP' check (currency_code ~ '^[A-Z]{3}$'),
  weekly_hours numeric(6, 2),
  payment_schedule text,
  management_name text,
  job_title text,
  cost_centers jsonb not null default '[]'::jsonb check (jsonb_typeof(cost_centers) = 'array'),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (person_id, organization_id) references public.payroll_people (id, organization_id) on delete cascade,
  unique (organization_id, provider, external_contract_id)
);

create table public.payroll_person_period_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null,
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  absence_days numeric(8, 2) not null default 0 check (absence_days >= 0),
  vacation_days numeric(8, 2) not null default 0 check (vacation_days >= 0),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (person_id, organization_id) references public.payroll_people (id, organization_id) on delete cascade,
  unique (organization_id, person_id, period_month)
);

create index payroll_people_organization_active_idx on public.payroll_people (organization_id, is_active, full_name);
create index payroll_contracts_organization_status_idx on public.payroll_contracts (organization_id, contract_status, monthly_gross_salary desc);
create index payroll_contracts_person_idx on public.payroll_contracts (person_id, organization_id);
create index payroll_person_period_metrics_organization_period_idx on public.payroll_person_period_metrics (organization_id, period_month desc);

create trigger payroll_people_set_updated_at before update on public.payroll_people
for each row execute function public.set_updated_at();

create trigger payroll_contracts_set_updated_at before update on public.payroll_contracts
for each row execute function public.set_updated_at();

create trigger payroll_person_period_metrics_set_updated_at before update on public.payroll_person_period_metrics
for each row execute function public.set_updated_at();

alter table public.payroll_people enable row level security;
alter table public.payroll_contracts enable row level security;
alter table public.payroll_person_period_metrics enable row level security;

create policy "finance reads payroll people" on public.payroll_people
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_people.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance reads payroll contracts" on public.payroll_contracts
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_contracts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance reads payroll people metrics" on public.payroll_person_period_metrics
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = payroll_person_period_metrics.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

revoke all on public.payroll_people, public.payroll_contracts, public.payroll_person_period_metrics from anon;
grant select on public.payroll_people, public.payroll_contracts, public.payroll_person_period_metrics to authenticated;
