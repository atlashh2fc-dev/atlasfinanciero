create table public.cost_centers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (id, organization_id)
);

create table public.payroll_person_cost_center_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  person_id uuid not null,
  cost_center_id uuid not null,
  allocation_percentage numeric(5, 2) not null default 100 check (allocation_percentage > 0 and allocation_percentage <= 100),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (person_id, organization_id) references public.payroll_people (id, organization_id) on delete cascade,
  foreign key (cost_center_id, organization_id) references public.cost_centers (id, organization_id) on delete restrict,
  unique (person_id, cost_center_id, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);

create table public.cost_center_customer_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cost_center_id uuid not null,
  counterparty_id uuid not null,
  allocation_percentage numeric(5, 2) not null default 100 check (allocation_percentage > 0 and allocation_percentage <= 100),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (cost_center_id, organization_id) references public.cost_centers (id, organization_id) on delete cascade,
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete restrict,
  unique (cost_center_id, counterparty_id, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);

create index payroll_person_cost_center_active_idx on public.payroll_person_cost_center_assignments (organization_id, person_id, effective_from desc);
create index cost_center_customer_active_idx on public.cost_center_customer_links (organization_id, cost_center_id, effective_from desc);

create trigger cost_centers_set_updated_at before update on public.cost_centers for each row execute function public.set_updated_at();
create trigger payroll_person_cost_centers_set_updated_at before update on public.payroll_person_cost_center_assignments for each row execute function public.set_updated_at();
create trigger cost_center_customer_links_set_updated_at before update on public.cost_center_customer_links for each row execute function public.set_updated_at();

alter table public.cost_centers enable row level security;
alter table public.payroll_person_cost_center_assignments enable row level security;
alter table public.cost_center_customer_links enable row level security;

create policy "members read cost centers" on public.cost_centers for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = cost_centers.organization_id and membership.user_id = (select auth.uid())));
create policy "members read person cost centers" on public.payroll_person_cost_center_assignments for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = payroll_person_cost_center_assignments.organization_id and membership.user_id = (select auth.uid())));
create policy "members read center customers" on public.cost_center_customer_links for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = cost_center_customer_links.organization_id and membership.user_id = (select auth.uid())));
create policy "finance manages cost centers" on public.cost_centers for all to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = cost_centers.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = cost_centers.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance')));
create policy "finance manages person cost centers" on public.payroll_person_cost_center_assignments for all to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = payroll_person_cost_center_assignments.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = payroll_person_cost_center_assignments.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance')));
create policy "finance manages center customers" on public.cost_center_customer_links for all to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = cost_center_customer_links.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = cost_center_customer_links.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance')));

grant select, insert, update, delete on public.cost_centers, public.payroll_person_cost_center_assignments, public.cost_center_customer_links to authenticated;
