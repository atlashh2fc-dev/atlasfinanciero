-- Procure-to-pay: solicitudes, órdenes a proveedor y lotes de pago. Las
-- referencias compuestas impiden cruzar información entre organizaciones.

create table public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_number text not null,
  requested_by uuid references auth.users(id) on delete set null default auth.uid(),
  supplier_counterparty_id uuid,
  supplier_name text not null,
  description text not null,
  requested_on date not null default current_date,
  needed_by date,
  cost_center_id uuid,
  currency_code char(3) not null default 'CLP',
  estimated_amount numeric(18, 2) not null check (estimated_amount >= 0),
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'rejected', 'cancelled')),
  notes text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, request_number),
  foreign key (supplier_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  foreign key (cost_center_id, organization_id)
    references public.cost_centers (id, organization_id) on delete restrict,
  check (length(btrim(request_number)) > 0),
  check (length(btrim(supplier_name)) > 0),
  check (length(btrim(description)) > 0),
  check (needed_by is null or needed_by >= requested_on),
  check (currency_code ~ '^[A-Z]{3}$'),
  check ((status <> 'cancelled') or (cancelled_at is not null and cancellation_reason is not null))
);

create table public.vendor_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_number text not null,
  purchase_request_id uuid,
  supplier_counterparty_id uuid,
  supplier_name text not null,
  supplier_tax_id text,
  ordered_on date not null default current_date,
  expected_on date,
  currency_code char(3) not null default 'CLP',
  net_amount numeric(18, 2) not null default 0 check (net_amount >= 0),
  vat_amount numeric(18, 2) not null default 0 check (vat_amount >= 0),
  total_amount numeric(18, 2) not null default 0 check (total_amount >= 0),
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'sent', 'partially_received', 'received', 'cancelled')),
  notes text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  sent_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancellation_reason text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, purchase_order_number),
  foreign key (purchase_request_id, organization_id)
    references public.purchase_requests (id, organization_id) on delete restrict,
  foreign key (supplier_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  check (length(btrim(purchase_order_number)) > 0),
  check (length(btrim(supplier_name)) > 0),
  check (expected_on is null or expected_on >= ordered_on),
  check (currency_code ~ '^[A-Z]{3}$'),
  check ((status <> 'cancelled') or (cancelled_at is not null and cancellation_reason is not null))
);

create table public.vendor_purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_order_id uuid not null,
  line_number smallint not null check (line_number > 0),
  description text not null,
  quantity numeric(18, 4) not null check (quantity > 0),
  unit_price numeric(18, 2) not null check (unit_price >= 0),
  net_amount numeric(18, 2) not null check (net_amount >= 0),
  received_quantity numeric(18, 4) not null default 0 check (received_quantity >= 0 and received_quantity <= quantity),
  cost_center_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (purchase_order_id, organization_id)
    references public.vendor_purchase_orders (id, organization_id) on delete cascade,
  foreign key (cost_center_id, organization_id)
    references public.cost_centers (id, organization_id) on delete restrict,
  unique (purchase_order_id, line_number),
  check (length(btrim(description)) > 0)
);

alter table public.received_documents
  add column vendor_purchase_order_id uuid,
  add constraint received_documents_vendor_purchase_order_organization_fkey
    foreign key (vendor_purchase_order_id, organization_id)
    references public.vendor_purchase_orders (id, organization_id) on delete restrict;

create table public.payment_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_number text not null,
  bank_account_id uuid,
  scheduled_for date not null,
  currency_code char(3) not null default 'CLP',
  total_amount numeric(18, 2) not null default 0 check (total_amount >= 0),
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'processing', 'paid', 'cancelled')),
  notes text,
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  processed_at timestamptz,
  paid_at timestamptz,
  payment_reference text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancellation_reason text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, batch_number),
  foreign key (bank_account_id, organization_id)
    references public.bank_accounts (id, organization_id) on delete restrict,
  check (length(btrim(batch_number)) > 0),
  check (currency_code ~ '^[A-Z]{3}$'),
  check ((status <> 'cancelled') or (cancelled_at is not null and cancellation_reason is not null))
);

create table public.payment_batch_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_batch_id uuid not null,
  received_document_id uuid not null,
  supplier_name_snapshot text not null,
  document_number_snapshot text,
  due_date_snapshot date,
  amount numeric(18, 2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (payment_batch_id, organization_id)
    references public.payment_batches (id, organization_id) on delete cascade,
  foreign key (received_document_id, organization_id)
    references public.received_documents (id, organization_id) on delete restrict,
  unique (payment_batch_id, received_document_id),
  check (length(btrim(supplier_name_snapshot)) > 0)
);

create index purchase_requests_org_status_needed_idx on public.purchase_requests (organization_id, status, needed_by);
create index vendor_purchase_orders_org_status_ordered_idx on public.vendor_purchase_orders (organization_id, status, ordered_on desc);
create index vendor_purchase_orders_request_idx on public.vendor_purchase_orders (purchase_request_id) where purchase_request_id is not null;
create index vendor_purchase_order_lines_order_idx on public.vendor_purchase_order_lines (purchase_order_id, line_number);
create index received_documents_vendor_purchase_order_idx on public.received_documents (vendor_purchase_order_id) where vendor_purchase_order_id is not null;
create index payment_batches_org_status_scheduled_idx on public.payment_batches (organization_id, status, scheduled_for);
create index payment_batch_items_document_idx on public.payment_batch_items (received_document_id);

create trigger purchase_requests_set_updated_at before update on public.purchase_requests
for each row execute function public.set_updated_at();
create trigger vendor_purchase_orders_set_updated_at before update on public.vendor_purchase_orders
for each row execute function public.set_updated_at();
create trigger vendor_purchase_order_lines_set_updated_at before update on public.vendor_purchase_order_lines
for each row execute function public.set_updated_at();
create trigger payment_batches_set_updated_at before update on public.payment_batches
for each row execute function public.set_updated_at();
create trigger payment_batch_items_set_updated_at before update on public.payment_batch_items
for each row execute function public.set_updated_at();

-- Sólo los borradores pueden editarse. Los saltos review->approved son
-- producidos por la solicitud formal de aprobación creada abajo.
create or replace function public.enforce_procure_to_pay_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_table = 'purchase_requests' then
    if new.status = old.status then
      if old.status <> 'draft' then raise exception 'Only draft purchase requests can be edited'; end if;
    elsif old.status = 'draft' and new.status = 'review' then
      null;
    elsif old.status = 'review' and new.status in ('approved', 'rejected') then
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'purchase_order' and r.target_id = new.id and r.status = new.status and r.metadata->>'kind' = 'purchase_request') then
        raise exception 'Purchase request must be decided in approvals';
      end if;
    elsif old.status in ('draft', 'review', 'approved', 'rejected') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid purchase request transition'; end if;
  elsif tg_table = 'vendor_purchase_orders' then
    if new.status = old.status then
      if old.status <> 'draft' then raise exception 'Only draft purchase orders can be edited'; end if;
    elsif old.status = 'draft' and new.status = 'review' then null;
    elsif old.status = 'review' and new.status in ('approved', 'cancelled') then
      if new.status = 'approved' and not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'purchase_order' and r.target_id = new.id and r.status = 'approved' and r.metadata->>'kind' = 'vendor_purchase_order') then
        raise exception 'Purchase order must be approved in approvals';
      end if;
    elsif old.status = 'approved' and new.status = 'sent' then null;
    elsif old.status = 'sent' and new.status in ('partially_received', 'received') then null;
    elsif old.status = 'partially_received' and new.status = 'received' then null;
    elsif old.status in ('draft', 'review', 'approved', 'sent', 'partially_received') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid purchase order transition'; end if;
  elsif tg_table = 'payment_batches' then
    if new.status = old.status then
      if old.status <> 'draft' then raise exception 'Only draft payment batches can be edited'; end if;
    elsif old.status = 'draft' and new.status = 'review' then null;
    elsif old.status = 'review' and new.status = 'approved' then
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'payment' and r.target_id = new.id and r.status = 'approved' and r.metadata->>'kind' = 'payment_batch') then
        raise exception 'Payment batch must be approved in approvals';
      end if;
    elsif old.status = 'approved' and new.status = 'processing' then null;
    elsif old.status = 'processing' and new.status = 'paid' then
      if new.paid_at is null then raise exception 'Paid date is required'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'processing') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid payment batch transition'; end if;
  end if;
  return new;
end;
$$;

create trigger purchase_requests_enforce_transition before update on public.purchase_requests
for each row execute function public.enforce_procure_to_pay_transition();
create trigger vendor_purchase_orders_enforce_transition before update on public.vendor_purchase_orders
for each row execute function public.enforce_procure_to_pay_transition();
create trigger payment_batches_enforce_transition before update on public.payment_batches
for each row execute function public.enforce_procure_to_pay_transition();

create or replace function public.enforce_procure_to_pay_lines_editability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare v_status text; v_parent_id uuid;
begin
  if tg_table = 'vendor_purchase_order_lines' then
    v_parent_id := case when tg_op = 'DELETE' then old.purchase_order_id else new.purchase_order_id end;
    select status into v_status from public.vendor_purchase_orders where id = v_parent_id;
    if v_status <> 'draft' then raise exception 'Purchase order lines can only be changed while draft'; end if;
  elsif tg_table = 'payment_batch_items' then
    v_parent_id := case when tg_op = 'DELETE' then old.payment_batch_id else new.payment_batch_id end;
    select status into v_status from public.payment_batches where id = v_parent_id;
    if v_status <> 'draft' then raise exception 'Payment batch items can only be changed while draft'; end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger vendor_purchase_order_lines_editability before insert or update or delete on public.vendor_purchase_order_lines
for each row execute function public.enforce_procure_to_pay_lines_editability();
create trigger payment_batch_items_editability before insert or update or delete on public.payment_batch_items
for each row execute function public.enforce_procure_to_pay_lines_editability();

create or replace function public.refresh_procure_to_pay_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_order_id uuid; v_batch_id uuid;
begin
  if tg_table = 'vendor_purchase_order_lines' then
    v_order_id := case when tg_op = 'DELETE' then old.purchase_order_id else new.purchase_order_id end;
    update public.vendor_purchase_orders set
      net_amount = coalesce((select sum(net_amount) from public.vendor_purchase_order_lines where purchase_order_id = v_order_id), 0),
      vat_amount = round(coalesce((select sum(net_amount) from public.vendor_purchase_order_lines where purchase_order_id = v_order_id), 0) * 0.19, 2),
      total_amount = round(coalesce((select sum(net_amount) from public.vendor_purchase_order_lines where purchase_order_id = v_order_id), 0) * 1.19, 2)
    where id = v_order_id;
  else
    v_batch_id := case when tg_op = 'DELETE' then old.payment_batch_id else new.payment_batch_id end;
    update public.payment_batches set total_amount = coalesce((select sum(amount) from public.payment_batch_items where payment_batch_id = v_batch_id), 0)
    where id = v_batch_id;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger vendor_purchase_order_lines_refresh_totals after insert or update or delete on public.vendor_purchase_order_lines
for each row execute function public.refresh_procure_to_pay_totals();
create trigger payment_batch_items_refresh_totals after insert or update or delete on public.payment_batch_items
for each row execute function public.refresh_procure_to_pay_totals();

create or replace function public.sync_procure_to_pay_approval_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare policy_id uuid; v_target_type text; v_amount numeric; v_title text; v_kind text; v_requested_by uuid;
begin
  if new.status <> 'review' or old.status <> 'draft' then return new; end if;
  if tg_table = 'payment_batches' then
    v_target_type := 'payment'; v_amount := new.total_amount; v_title := 'Lote de pago ' || new.batch_number; v_kind := 'payment_batch'; v_requested_by := new.created_by;
  elsif tg_table = 'vendor_purchase_orders' then
    v_target_type := 'purchase_order'; v_amount := new.total_amount; v_title := 'Orden de compra ' || new.purchase_order_number; v_kind := 'vendor_purchase_order'; v_requested_by := new.created_by;
  else
    v_target_type := 'purchase_order'; v_amount := new.estimated_amount; v_title := 'Solicitud de compra ' || new.request_number; v_kind := 'purchase_request'; v_requested_by := new.requested_by;
  end if;
  select id into policy_id from public.approval_policies
  where organization_id = new.organization_id and target_type = v_target_type and is_active and currency_code = new.currency_code and minimum_amount <= v_amount and (maximum_amount is null or maximum_amount >= v_amount)
  order by minimum_amount desc limit 1;
  if policy_id is null then raise exception 'No approval policy applies'; end if;
  insert into public.approval_requests (organization_id, approval_policy_id, target_type, target_id, title, description, amount, currency_code, requested_by, metadata)
  values (new.organization_id, policy_id, v_target_type, new.id, v_title, coalesce(new.notes, ''), v_amount, new.currency_code, coalesce(v_requested_by, auth.uid()), jsonb_build_object('kind', v_kind))
  on conflict (organization_id, target_type, target_id) where status = 'submitted' do nothing;
  return new;
end;
$$;

create trigger purchase_requests_sync_approval after update of status on public.purchase_requests
for each row execute function public.sync_procure_to_pay_approval_request();
create trigger vendor_purchase_orders_sync_approval after update of status on public.vendor_purchase_orders
for each row execute function public.sync_procure_to_pay_approval_request();
create trigger payment_batches_sync_approval after update of status on public.payment_batches
for each row execute function public.sync_procure_to_pay_approval_request();

create or replace function public.sync_approval_decision_to_procure_to_pay()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_kind text := new.metadata->>'kind';
begin
  if old.status <> 'submitted' or new.status not in ('approved', 'rejected') then return new; end if;
  if v_kind = 'purchase_request' then
    update public.purchase_requests set status = case when new.status = 'approved' then 'approved' else 'rejected' end,
      approved_at = case when new.status = 'approved' then coalesce(new.completed_at, now()) else null end,
      approved_by = case when new.status = 'approved' then auth.uid() else null end
    where id = new.target_id and organization_id = new.organization_id and status = 'review';
  elsif v_kind = 'vendor_purchase_order' then
    if new.status = 'approved' then
      update public.vendor_purchase_orders set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid()
      where id = new.target_id and organization_id = new.organization_id and status = 'review';
    else
      update public.vendor_purchase_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancellation_reason = 'Rechazada en aprobaciones'
      where id = new.target_id and organization_id = new.organization_id and status = 'review';
    end if;
  elsif v_kind = 'payment_batch' then
    if new.status = 'approved' then
      update public.payment_batches set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid()
      where id = new.target_id and organization_id = new.organization_id and status = 'review';
    else
      update public.payment_batches set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancellation_reason = 'Rechazado en aprobaciones'
      where id = new.target_id and organization_id = new.organization_id and status = 'review';
    end if;
  end if;
  return new;
end;
$$;

create trigger approval_requests_sync_procure_to_pay
after update of status on public.approval_requests
for each row execute function public.sync_approval_decision_to_procure_to_pay();

create or replace function public.sync_paid_batch_to_received_documents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'paid' and new.status = 'paid' then
    update public.received_documents document
    set payment_status = 'Pagada', payment_date = new.paid_at::date,
        payment_method = 'Lote de pago', payment_reference = new.payment_reference,
        payment_notes = concat('Pagada por lote ', new.batch_number), payment_recorded_at = now(), payment_recorded_by = auth.uid()
    from public.payment_batch_items item
    where item.payment_batch_id = new.id and item.received_document_id = document.id
      and item.organization_id = new.organization_id and document.organization_id = new.organization_id;
  end if;
  return new;
end;
$$;
create trigger payment_batches_sync_paid_documents after update of status on public.payment_batches
for each row execute function public.sync_paid_batch_to_received_documents();

alter table public.purchase_requests enable row level security;
alter table public.vendor_purchase_orders enable row level security;
alter table public.vendor_purchase_order_lines enable row level security;
alter table public.payment_batches enable row level security;
alter table public.payment_batch_items enable row level security;

create policy "procure roles read purchase requests" on public.purchase_requests for select to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = purchase_requests.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations', 'auditor'))
);
create policy "procure roles manage purchase requests" on public.purchase_requests for all to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = purchase_requests.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships m where m.organization_id = purchase_requests.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations'))
);
create policy "procure roles read vendor purchase orders" on public.vendor_purchase_orders for select to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = vendor_purchase_orders.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations', 'auditor'))
);
create policy "procure roles manage vendor purchase orders" on public.vendor_purchase_orders for all to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = vendor_purchase_orders.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships m where m.organization_id = vendor_purchase_orders.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations'))
);
create policy "procure roles read vendor purchase order lines" on public.vendor_purchase_order_lines for select to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = vendor_purchase_order_lines.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations', 'auditor'))
);
create policy "procure roles manage vendor purchase order lines" on public.vendor_purchase_order_lines for all to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = vendor_purchase_order_lines.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships m where m.organization_id = vendor_purchase_order_lines.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations'))
);
create policy "finance and audit read payment batches" on public.payment_batches for select to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = payment_batches.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance roles manage payment batches" on public.payment_batches for all to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = payment_batches.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships m where m.organization_id = payment_batches.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))
);
create policy "finance and audit read payment batch items" on public.payment_batch_items for select to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = payment_batch_items.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'auditor'))
);
create policy "finance roles manage payment batch items" on public.payment_batch_items for all to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = payment_batch_items.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships m where m.organization_id = payment_batch_items.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))
);

grant select, insert, update, delete on public.purchase_requests, public.vendor_purchase_orders, public.vendor_purchase_order_lines, public.payment_batches, public.payment_batch_items to authenticated;
revoke all on function public.enforce_procure_to_pay_transition() from public, anon, authenticated;
revoke all on function public.enforce_procure_to_pay_lines_editability() from public, anon, authenticated;
revoke all on function public.refresh_procure_to_pay_totals() from public, anon, authenticated;
revoke all on function public.sync_procure_to_pay_approval_request() from public, anon, authenticated;
revoke all on function public.sync_approval_decision_to_procure_to_pay() from public, anon, authenticated;
revoke all on function public.sync_paid_batch_to_received_documents() from public, anon, authenticated;
