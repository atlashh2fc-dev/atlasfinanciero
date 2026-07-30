-- Perfil operativo para evaluar fondos públicos. No almacena Clave Tributaria,
-- Clave Única, cotizaciones ni certificados tributarios completos.

create table public.benefits_company_profiles (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  region text,
  commune text,
  business_sector text,
  legal_start_date date,
  first_category_confirmed boolean not null default false,
  annual_sales_verified boolean not null default false,
  tax_folder_reviewed_at date,
  no_tax_or_labor_debt_declared boolean not null default false,
  no_pending_public_renditions_declared boolean not null default false,
  project_focus text,
  project_budget numeric(18, 2) check (project_budget is null or project_budget >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.benefits_applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  program_id text not null check (char_length(program_id) <= 80),
  program_name text not null check (char_length(program_name) <= 180),
  institution text not null check (char_length(institution) <= 80),
  official_url text not null check (char_length(official_url) <= 1000),
  status text not null default 'preparing' check (status in ('preparing', 'ready_for_submission', 'submitted', 'not_selected', 'awarded', 'withdrawn')),
  deadline date,
  notes text check (notes is null or char_length(notes) <= 2000),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, program_id)
);

create index benefits_applications_organization_status_idx
  on public.benefits_applications (organization_id, status, deadline);

create trigger benefits_company_profiles_set_updated_at before update on public.benefits_company_profiles
for each row execute function public.set_updated_at();

create trigger benefits_applications_set_updated_at before update on public.benefits_applications
for each row execute function public.set_updated_at();

alter table public.benefits_company_profiles enable row level security;
alter table public.benefits_applications enable row level security;

create policy "finance reads benefits company profile" on public.benefits_company_profiles
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_company_profiles.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance manages benefits company profile" on public.benefits_company_profiles
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_company_profiles.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_company_profiles.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance reads benefits applications" on public.benefits_applications
for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_applications.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance manages benefits applications" on public.benefits_applications
for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_applications.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = benefits_applications.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant select, insert, update, delete on public.benefits_company_profiles, public.benefits_applications to authenticated;
