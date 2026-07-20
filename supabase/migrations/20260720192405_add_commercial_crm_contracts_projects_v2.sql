-- Núcleo comercial: la ficha existente de cliente es el origen único.
create table public.commercial_opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid,
  title text not null,
  stage text not null default 'lead' check (stage in ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  expected_amount numeric(18, 2) not null default 0 check (expected_amount >= 0),
  currency_code char(3) not null default 'CLP' check (currency_code in ('CLP', 'UF', 'USD')),
  probability integer not null default 10 check (probability between 0 and 100),
  expected_close_on date,
  next_action_on date,
  source text,
  lost_reason text,
  description text,
  owner_user_id uuid references auth.users(id) on delete set null default auth.uid(),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete restrict
);

create table public.commercial_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid not null,
  opportunity_id uuid,
  contract_code text not null,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'expiring', 'closed', 'cancelled')),
  total_amount numeric(18, 2) not null default 0 check (total_amount >= 0),
  currency_code char(3) not null default 'CLP' check (currency_code in ('CLP', 'UF', 'USD')),
  starts_on date,
  ends_on date,
  renewal_notice_on date,
  billing_frequency text not null default 'monthly' check (billing_frequency in ('monthly', 'quarterly', 'annual', 'one_time')),
  responsible_user_id uuid references auth.users(id) on delete set null default auth.uid(),
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, contract_code),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete restrict,
  foreign key (opportunity_id, organization_id) references public.commercial_opportunities (id, organization_id) on delete set null
);

create table public.commercial_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid not null,
  contract_id uuid,
  opportunity_id uuid,
  cost_center_id uuid,
  project_code text not null,
  name text not null,
  status text not null default 'planning' check (status in ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  revenue_budget numeric(18, 2) not null default 0 check (revenue_budget >= 0),
  expense_budget numeric(18, 2) not null default 0 check (expense_budget >= 0),
  currency_code char(3) not null default 'CLP' check (currency_code in ('CLP', 'UF', 'USD')),
  starts_on date,
  ends_on date,
  manager_user_id uuid references auth.users(id) on delete set null default auth.uid(),
  notes text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, project_code),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  foreign key (counterparty_id, organization_id) references public.counterparties (id, organization_id) on delete restrict,
  foreign key (contract_id, organization_id) references public.commercial_contracts (id, organization_id) on delete set null,
  foreign key (opportunity_id, organization_id) references public.commercial_opportunities (id, organization_id) on delete set null,
  foreign key (cost_center_id, organization_id) references public.cost_centers (id, organization_id) on delete set null
);

create table public.commercial_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  opportunity_id uuid not null,
  activity_type text not null default 'task' check (activity_type in ('call', 'meeting', 'email', 'task', 'note')),
  subject text not null,
  notes text,
  due_on date,
  completed_on date,
  assigned_to uuid references auth.users(id) on delete set null default auth.uid(),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (opportunity_id, organization_id) references public.commercial_opportunities (id, organization_id) on delete cascade
);

create index commercial_opportunities_board_idx on public.commercial_opportunities (organization_id, stage, next_action_on, expected_close_on);
create index commercial_opportunities_customer_idx on public.commercial_opportunities (organization_id, counterparty_id, updated_at desc);
create index commercial_contracts_customer_status_idx on public.commercial_contracts (organization_id, counterparty_id, status, ends_on);
create index commercial_projects_customer_status_idx on public.commercial_projects (organization_id, counterparty_id, status, ends_on);
create index commercial_activities_opportunity_due_idx on public.commercial_activities (organization_id, opportunity_id, due_on, completed_on);

create trigger commercial_opportunities_set_updated_at before update on public.commercial_opportunities for each row execute function public.set_updated_at();
create trigger commercial_contracts_set_updated_at before update on public.commercial_contracts for each row execute function public.set_updated_at();
create trigger commercial_projects_set_updated_at before update on public.commercial_projects for each row execute function public.set_updated_at();
create trigger commercial_activities_set_updated_at before update on public.commercial_activities for each row execute function public.set_updated_at();

alter table public.commercial_opportunities enable row level security;
alter table public.commercial_contracts enable row level security;
alter table public.commercial_projects enable row level security;
alter table public.commercial_activities enable row level security;

create policy "members read commercial opportunities" on public.commercial_opportunities for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_opportunities.organization_id and membership.user_id = (select auth.uid())));
create policy "operators manage commercial opportunities" on public.commercial_opportunities for all to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_opportunities.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_opportunities.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "members read commercial contracts" on public.commercial_contracts for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_contracts.organization_id and membership.user_id = (select auth.uid())));
create policy "operators manage commercial contracts" on public.commercial_contracts for all to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_contracts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_contracts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "members read commercial projects" on public.commercial_projects for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_projects.organization_id and membership.user_id = (select auth.uid())));
create policy "operators manage commercial projects" on public.commercial_projects for all to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_projects.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_projects.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));
create policy "members read commercial activities" on public.commercial_activities for select to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_activities.organization_id and membership.user_id = (select auth.uid())));
create policy "operators manage commercial activities" on public.commercial_activities for all to authenticated using (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_activities.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))) with check (exists (select 1 from public.organization_memberships membership where membership.organization_id = commercial_activities.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations')));

grant select, insert, update, delete on public.commercial_opportunities, public.commercial_contracts, public.commercial_projects, public.commercial_activities to authenticated;
