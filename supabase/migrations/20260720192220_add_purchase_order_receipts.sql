-- Recepciones conformes trazables para el match OC -> recepción -> factura.
create table public.vendor_purchase_order_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null,
  received_on date not null default current_date,
  notes text,
  received_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (purchase_order_id, organization_id)
    references public.vendor_purchase_orders (id, organization_id) on delete restrict,
  check (notes is null or length(notes) <= 2000)
);

create table public.vendor_purchase_order_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  receipt_id uuid not null,
  purchase_order_line_id uuid not null,
  received_quantity numeric(18, 4) not null check (received_quantity > 0),
  created_at timestamptz not null default now(),
  unique (receipt_id, purchase_order_line_id),
  foreign key (receipt_id, organization_id)
    references public.vendor_purchase_order_receipts (id, organization_id) on delete cascade,
  foreign key (purchase_order_line_id)
    references public.vendor_purchase_order_lines (id) on delete restrict
);

create index vendor_purchase_order_receipts_order_date_idx
  on public.vendor_purchase_order_receipts (purchase_order_id, received_on desc, created_at desc);
create index vendor_purchase_order_receipt_lines_line_idx
  on public.vendor_purchase_order_receipt_lines (purchase_order_line_id);

create trigger vendor_purchase_order_receipts_set_updated_at before update on public.vendor_purchase_order_receipts
for each row execute function public.set_updated_at();

-- La actualización de cantidades y estado ocurre dentro de la misma transacción
-- que inserta la línea. Nunca permite recibir más de lo pedido ni registrar
-- líneas ajenas a la OC de la recepción.
create or replace function public.apply_vendor_purchase_order_receipt_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_line_order_id uuid;
  v_quantity numeric(18, 4);
  v_received numeric(18, 4);
  v_all_received boolean;
begin
  select purchase_order_id into v_order_id
  from public.vendor_purchase_order_receipts
  where id = new.receipt_id and organization_id = new.organization_id
  for key share;

  select purchase_order_id, quantity, received_quantity
    into v_line_order_id, v_quantity, v_received
  from public.vendor_purchase_order_lines
  where id = new.purchase_order_line_id and organization_id = new.organization_id
  for update;

  if v_order_id is null or v_line_order_id is null or v_order_id <> v_line_order_id then
    raise exception 'Receipt line does not belong to the purchase order';
  end if;
  if v_received + new.received_quantity > v_quantity then
    raise exception 'Receipt quantity exceeds the pending purchase order quantity';
  end if;

  update public.vendor_purchase_order_lines
  set received_quantity = received_quantity + new.received_quantity
  where id = new.purchase_order_line_id and organization_id = new.organization_id;

  select bool_and(received_quantity >= quantity) into v_all_received
  from public.vendor_purchase_order_lines
  where purchase_order_id = v_order_id and organization_id = new.organization_id;

  update public.vendor_purchase_orders
  set status = case when v_all_received then 'received' else 'partially_received' end,
      received_at = now()
  where id = v_order_id
    and organization_id = new.organization_id
    and status in ('sent', 'partially_received');

  if not found then
    raise exception 'Purchase order is not available to receive';
  end if;
  return new;
end;
$$;

create trigger vendor_purchase_order_receipt_lines_apply
before insert on public.vendor_purchase_order_receipt_lines
for each row execute function public.apply_vendor_purchase_order_receipt_line();

alter table public.vendor_purchase_order_receipts enable row level security;
alter table public.vendor_purchase_order_receipt_lines enable row level security;

create policy "procure roles read vendor purchase order receipts"
on public.vendor_purchase_order_receipts for select to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = vendor_purchase_order_receipts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations', 'auditor')
  )
);
create policy "procure roles manage vendor purchase order receipts"
on public.vendor_purchase_order_receipts for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = vendor_purchase_order_receipts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = vendor_purchase_order_receipts.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);
create policy "procure roles read vendor purchase order receipt lines"
on public.vendor_purchase_order_receipt_lines for select to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = vendor_purchase_order_receipt_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations', 'auditor')
  )
);
create policy "procure roles manage vendor purchase order receipt lines"
on public.vendor_purchase_order_receipt_lines for all to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = vendor_purchase_order_receipt_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = vendor_purchase_order_receipt_lines.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);

grant select, insert, update, delete on public.vendor_purchase_order_receipts, public.vendor_purchase_order_receipt_lines to authenticated;
revoke all on function public.apply_vendor_purchase_order_receipt_line() from public, anon, authenticated;
