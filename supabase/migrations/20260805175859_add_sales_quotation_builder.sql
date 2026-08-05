create table public.quotation_catalog_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 180),
  category text not null check (category in ('saas', 'infrastructure', 'ai', 'professional_service', 'profile', 'bpo', 'other')),
  unit_name text not null default 'unidad' check (char_length(unit_name) between 1 and 80),
  billing_period text not null default 'monthly' check (billing_period in ('one_time', 'monthly')),
  default_unit_cost numeric(18, 4) not null default 0 check (default_unit_cost >= 0),
  default_margin_percent numeric(7, 4) not null default 30 check (default_margin_percent >= 0 and default_margin_percent < 100),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table public.sales_quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_id uuid,
  opportunity_id uuid,
  quote_number text not null default ('COT-' || to_char(now(), 'YYYYMMDD-HH24MISS') || '-' || upper(substr(gen_random_uuid()::text, 1, 4))),
  title text not null check (char_length(title) between 1 and 250),
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  currency_code char(3) not null default 'CLP' check (currency_code in ('CLP', 'UF', 'USD')),
  valid_until date,
  term_months integer not null default 12 check (term_months between 1 and 120),
  notes text check (notes is null or char_length(notes) <= 4000),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  one_time_cost numeric(18, 2) not null default 0 check (one_time_cost >= 0),
  one_time_sale numeric(18, 2) not null default 0 check (one_time_sale >= 0),
  monthly_cost numeric(18, 2) not null default 0 check (monthly_cost >= 0),
  monthly_sale numeric(18, 2) not null default 0 check (monthly_sale >= 0),
  contract_value numeric(18, 2) not null default 0 check (contract_value >= 0),
  gross_profit numeric(18, 2) not null default 0,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, quote_number),
  foreign key (counterparty_id, organization_id) references public.counterparties(id, organization_id) on delete restrict,
  foreign key (opportunity_id, organization_id) references public.commercial_opportunities(id, organization_id) on delete set null
);

create index quotation_catalog_items_active_idx on public.quotation_catalog_items (organization_id, is_active, category, name);
create index sales_quotes_recent_idx on public.sales_quotes (organization_id, updated_at desc);
create index sales_quotes_customer_idx on public.sales_quotes (organization_id, counterparty_id, status);

create trigger quotation_catalog_items_set_updated_at before update on public.quotation_catalog_items for each row execute function public.set_updated_at();
create trigger sales_quotes_set_updated_at before update on public.sales_quotes for each row execute function public.set_updated_at();

alter table public.quotation_catalog_items enable row level security;
alter table public.sales_quotes enable row level security;

create policy "members read quotation catalog" on public.quotation_catalog_items
for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_items.organization_id
    and membership.user_id = (select auth.uid())
));

create policy "operators manage quotation catalog" on public.quotation_catalog_items
for all to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_items.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
))
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_items.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "members read sales quotes" on public.sales_quotes
for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sales_quotes.organization_id
    and membership.user_id = (select auth.uid())
));

create policy "operators manage sales quotes" on public.sales_quotes
for all to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sales_quotes.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
))
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sales_quotes.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

grant select, insert, update, delete on public.quotation_catalog_items, public.sales_quotes to authenticated;

insert into public.quotation_catalog_items (
  organization_id,
  name,
  category,
  unit_name,
  billing_period,
  default_unit_cost,
  default_margin_percent
)
select
  organization.id,
  seed.name,
  seed.category,
  seed.unit_name,
  seed.billing_period,
  seed.default_unit_cost,
  seed.default_margin_percent
from public.organizations organization
cross join (values
  ('Atlas Financiero', 'saas', 'licencia', 'monthly', 0::numeric, 70::numeric),
  ('Atlas ITSM', 'saas', 'licencia', 'monthly', 0, 70),
  ('Atlas CRM', 'saas', 'licencia', 'monthly', 0, 70),
  ('Atlas Aprende', 'saas', 'licencia', 'monthly', 0, 70),
  ('Atlas Lead', 'saas', 'licencia', 'monthly', 0, 70),
  ('BPO mensual', 'bpo', 'servicio', 'monthly', 0, 35),
  ('Vercel', 'infrastructure', 'proyecto', 'monthly', 0, 30),
  ('AWS', 'infrastructure', 'cuenta', 'monthly', 0, 30),
  ('IA Claude', 'ai', 'bolsa mensual', 'monthly', 0, 35),
  ('IA GPT', 'ai', 'bolsa mensual', 'monthly', 0, 35),
  ('Discovery', 'professional_service', 'servicio', 'one_time', 0, 40),
  ('Setup e implementación', 'professional_service', 'servicio', 'one_time', 0, 40),
  ('Arquitecto/a de software', 'profile', 'hora', 'monthly', 0, 35),
  ('Desarrollador/a backend', 'profile', 'hora', 'monthly', 0, 35),
  ('Desarrollador/a frontend', 'profile', 'hora', 'monthly', 0, 35),
  ('Desarrollador/a full stack', 'profile', 'hora', 'monthly', 0, 35),
  ('QA / Automatización', 'profile', 'hora', 'monthly', 0, 35),
  ('UX/UI', 'profile', 'hora', 'monthly', 0, 35),
  ('Project Manager', 'profile', 'hora', 'monthly', 0, 35)
) as seed(name, category, unit_name, billing_period, default_unit_cost, default_margin_percent)
on conflict (organization_id, name) do nothing;
