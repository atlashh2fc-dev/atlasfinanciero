-- Compromisos comerciales recibidos y su consumo parcial mediante facturas.
create table public.customer_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_number text not null,
  customer_name text not null,
  customer_tax_id text,
  received_date date not null,
  valid_until date,
  net_amount numeric(18, 2) not null check (net_amount >= 0),
  currency_code char(3) not null default 'CLP' check (currency_code ~ '^[A-Z]{3}$'),
  notes text,
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, purchase_order_number),
  unique (id, organization_id)
);

create table public.customer_purchase_order_billings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null,
  issued_document_id uuid not null,
  allocated_net_amount numeric(18, 2) not null check (allocated_net_amount > 0),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (purchase_order_id, organization_id) references public.customer_purchase_orders (id, organization_id) on delete cascade,
  foreign key (issued_document_id, organization_id) references public.issued_documents (id, organization_id) on delete restrict,
  unique (purchase_order_id, issued_document_id),
  unique (issued_document_id)
);

create index customer_purchase_orders_organization_status_idx on public.customer_purchase_orders (organization_id, status, received_date desc);
create index customer_purchase_order_billings_purchase_order_idx on public.customer_purchase_order_billings (purchase_order_id, organization_id);

create trigger customer_purchase_orders_set_updated_at before update on public.customer_purchase_orders
for each row execute function public.set_updated_at();

alter table public.customer_purchase_orders enable row level security;
alter table public.customer_purchase_order_billings enable row level security;

create policy "finance reads customer purchase orders" on public.customer_purchase_orders
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_purchase_orders.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations', 'auditor'))
);
create policy "operators manage customer purchase orders" on public.customer_purchase_orders
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_purchase_orders.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_purchase_orders.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);
create policy "finance reads customer purchase order billings" on public.customer_purchase_order_billings
for select to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_purchase_order_billings.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations', 'auditor'))
);
create policy "operators manage customer purchase order billings" on public.customer_purchase_order_billings
for all to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_purchase_order_billings.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = customer_purchase_order_billings.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);

grant select, insert, update, delete on public.customer_purchase_orders, public.customer_purchase_order_billings to authenticated;

-- El estado de cobranza conserva el ciclo de factoring y evita confundirlo con pago directo.
alter table public.issued_documents
  add column factoring_entity text,
  add column factored_at date,
  add column factoring_settled_at date,
  add column factoring_recourse_at date;
