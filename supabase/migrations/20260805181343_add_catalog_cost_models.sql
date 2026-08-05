alter table public.quotation_catalog_items
  add column is_sellable boolean not null default true,
  add column is_cost_component boolean not null default false;

alter table public.quotation_catalog_items
  add constraint quotation_catalog_items_id_organization_key unique (id, organization_id);

-- Los SaaS y servicios se cotizan; infraestructura e IA alimentan su costo interno.
update public.quotation_catalog_items
set
  is_sellable = category not in ('infrastructure', 'ai'),
  is_cost_component = category in ('infrastructure', 'ai', 'profile', 'professional_service');

insert into public.quotation_catalog_items (
  organization_id,
  name,
  category,
  unit_name,
  billing_period,
  default_unit_cost,
  default_margin_percent,
  is_sellable,
  is_cost_component
)
select
  organization.id,
  'Mercury (IA gratis)',
  'ai',
  'servicio',
  'monthly',
  0,
  0,
  false,
  true
from public.organizations organization
on conflict (organization_id, name) do update
set is_cost_component = true,
    is_sellable = false,
    default_unit_cost = 0;

create table public.quotation_catalog_cost_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_catalog_item_id uuid not null,
  cost_catalog_item_id uuid not null,
  quantity numeric(18, 4) not null default 1 check (quantity > 0),
  unit_cost_override numeric(18, 4) check (unit_cost_override is null or unit_cost_override >= 0),
  notes text check (notes is null or char_length(notes) <= 1000),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, product_catalog_item_id, cost_catalog_item_id),
  check (product_catalog_item_id <> cost_catalog_item_id),
  foreign key (product_catalog_item_id, organization_id)
    references public.quotation_catalog_items(id, organization_id) on delete cascade,
  foreign key (cost_catalog_item_id, organization_id)
    references public.quotation_catalog_items(id, organization_id) on delete restrict
);

create index quotation_cost_components_product_idx
  on public.quotation_catalog_cost_components (product_catalog_item_id, organization_id);
create index quotation_cost_components_cost_idx
  on public.quotation_catalog_cost_components (cost_catalog_item_id, organization_id);
create index quotation_cost_components_created_by_idx
  on public.quotation_catalog_cost_components (created_by);

create trigger quotation_catalog_cost_components_set_updated_at
before update on public.quotation_catalog_cost_components
for each row execute function public.set_updated_at();

alter table public.quotation_catalog_cost_components enable row level security;

create policy "members read quotation cost components"
on public.quotation_catalog_cost_components
for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_cost_components.organization_id
    and membership.user_id = (select auth.uid())
));

create policy "operators insert quotation cost components"
on public.quotation_catalog_cost_components
for insert to authenticated
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_cost_components.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "operators update quotation cost components"
on public.quotation_catalog_cost_components
for update to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_cost_components.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
))
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_cost_components.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "operators delete quotation cost components"
on public.quotation_catalog_cost_components
for delete to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_cost_components.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

grant select, insert, update, delete on public.quotation_catalog_cost_components to authenticated;
