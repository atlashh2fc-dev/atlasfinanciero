-- Cuentas por pagar directas: compromisos autorizados sin una OC o documento
-- recibido previo (por ejemplo, servicios básicos, arriendos o contribuciones).

create table public.direct_payables (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payable_number text not null,
  supplier_counterparty_id uuid,
  supplier_name text not null,
  invoice_number text,
  category text not null default 'other' check (category in ('utilities', 'rent', 'taxes', 'insurance', 'subscriptions', 'other')),
  description text not null,
  issue_date date not null default current_date,
  due_date date,
  currency_code char(3) not null default 'CLP',
  total_amount numeric(18, 2) not null check (total_amount > 0),
  status text not null default 'draft' check (status in ('draft', 'review', 'approved', 'rejected', 'paid', 'cancelled')),
  notes text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  paid_at timestamptz,
  payment_reference text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancellation_reason text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, payable_number),
  foreign key (supplier_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  check (length(btrim(payable_number)) > 0),
  check (length(btrim(supplier_name)) > 0),
  check (length(btrim(description)) > 0),
  check (due_date is null or due_date >= issue_date),
  check (currency_code ~ '^[A-Z]{3}$'),
  check ((status <> 'cancelled') or (cancelled_at is not null and cancellation_reason is not null))
);

create index direct_payables_org_status_due_idx on public.direct_payables (organization_id, status, due_date);

create trigger direct_payables_set_updated_at before update on public.direct_payables
for each row execute function public.set_updated_at();

alter table public.payment_batch_items
  alter column received_document_id drop not null,
  add column direct_payable_id uuid,
  add constraint payment_batch_items_direct_payable_organization_fkey
    foreign key (direct_payable_id, organization_id)
    references public.direct_payables (id, organization_id) on delete restrict,
  add constraint payment_batch_items_one_payable_source_check
    check (num_nonnulls(received_document_id, direct_payable_id) = 1);

create unique index payment_batch_items_direct_payable_unique_idx
  on public.payment_batch_items (payment_batch_id, direct_payable_id)
  where direct_payable_id is not null;
create index payment_batch_items_direct_payable_idx
  on public.payment_batch_items (direct_payable_id)
  where direct_payable_id is not null;

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
    elsif old.status = 'draft' and new.status = 'review' then null;
    elsif old.status = 'review' and new.status in ('approved', 'rejected') then
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'purchase_order' and r.target_id = new.id and r.status = new.status and r.metadata->>'kind' = 'purchase_request') then raise exception 'Purchase request must be decided in approvals'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'rejected') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid purchase request transition'; end if;
  elsif tg_table = 'vendor_purchase_orders' then
    if new.status = old.status then
      if old.status <> 'draft' then raise exception 'Only draft purchase orders can be edited'; end if;
    elsif old.status = 'draft' and new.status = 'review' then null;
    elsif old.status = 'review' and new.status in ('approved', 'cancelled') then
      if new.status = 'approved' and not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'purchase_order' and r.target_id = new.id and r.status = 'approved' and r.metadata->>'kind' = 'vendor_purchase_order') then raise exception 'Purchase order must be approved in approvals'; end if;
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
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'payment' and r.target_id = new.id and r.status = 'approved' and r.metadata->>'kind' = 'payment_batch') then raise exception 'Payment batch must be approved in approvals'; end if;
    elsif old.status = 'approved' and new.status = 'processing' then null;
    elsif old.status = 'processing' and new.status = 'paid' then
      if new.paid_at is null then raise exception 'Paid date is required'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'processing') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid payment batch transition'; end if;
  elsif tg_table = 'direct_payables' then
    if new.status = old.status then
      if old.status <> 'draft' then raise exception 'Only draft direct payables can be edited'; end if;
    elsif old.status = 'draft' and new.status = 'review' then null;
    elsif old.status = 'review' and new.status in ('approved', 'rejected') then
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'payment' and r.target_id = new.id and r.status = new.status and r.metadata->>'kind' = 'direct_payable') then raise exception 'Direct payable must be decided in approvals'; end if;
    elsif old.status = 'approved' and new.status = 'paid' then
      if new.paid_at is null then raise exception 'Paid date is required'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'rejected') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid direct payable transition'; end if;
  end if;
  return new;
end;
$$;

create trigger direct_payables_enforce_transition before update on public.direct_payables
for each row execute function public.enforce_procure_to_pay_transition();

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
  elsif tg_table = 'direct_payables' then
    v_target_type := 'payment'; v_amount := new.total_amount; v_title := 'Cuenta por pagar ' || new.payable_number; v_kind := 'direct_payable'; v_requested_by := new.created_by;
  elsif tg_table = 'vendor_purchase_orders' then
    v_target_type := 'purchase_order'; v_amount := new.total_amount; v_title := 'Orden de compra ' || new.purchase_order_number; v_kind := 'vendor_purchase_order'; v_requested_by := new.created_by;
  else
    v_target_type := 'purchase_order'; v_amount := new.estimated_amount; v_title := 'Solicitud de compra ' || new.request_number; v_kind := 'purchase_request'; v_requested_by := new.requested_by;
  end if;
  select id into policy_id from public.approval_policies where organization_id = new.organization_id and target_type = v_target_type and is_active and currency_code = new.currency_code and minimum_amount <= v_amount and (maximum_amount is null or maximum_amount >= v_amount) order by minimum_amount desc limit 1;
  if policy_id is null then raise exception 'No approval policy applies'; end if;
  insert into public.approval_requests (organization_id, approval_policy_id, target_type, target_id, title, description, amount, currency_code, requested_by, metadata)
  values (new.organization_id, policy_id, v_target_type, new.id, v_title, coalesce(new.notes, ''), v_amount, new.currency_code, coalesce(v_requested_by, auth.uid()), jsonb_build_object('kind', v_kind))
  on conflict (organization_id, target_type, target_id) where status = 'submitted' do nothing;
  return new;
end;
$$;

create trigger direct_payables_sync_approval after update of status on public.direct_payables
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
    update public.purchase_requests set status = case when new.status = 'approved' then 'approved' else 'rejected' end, approved_at = case when new.status = 'approved' then coalesce(new.completed_at, now()) else null end, approved_by = case when new.status = 'approved' then auth.uid() else null end where id = new.target_id and organization_id = new.organization_id and status = 'review';
  elsif v_kind = 'vendor_purchase_order' then
    if new.status = 'approved' then update public.vendor_purchase_orders set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid() where id = new.target_id and organization_id = new.organization_id and status = 'review';
    else update public.vendor_purchase_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancellation_reason = 'Rechazada en aprobaciones' where id = new.target_id and organization_id = new.organization_id and status = 'review'; end if;
  elsif v_kind = 'payment_batch' then
    if new.status = 'approved' then update public.payment_batches set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid() where id = new.target_id and organization_id = new.organization_id and status = 'review';
    else update public.payment_batches set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancellation_reason = 'Rechazado en aprobaciones' where id = new.target_id and organization_id = new.organization_id and status = 'review'; end if;
  elsif v_kind = 'direct_payable' then
    if new.status = 'approved' then update public.direct_payables set status = 'approved', approved_at = coalesce(new.completed_at, now()), approved_by = auth.uid() where id = new.target_id and organization_id = new.organization_id and status = 'review';
    else update public.direct_payables set status = 'rejected' where id = new.target_id and organization_id = new.organization_id and status = 'review'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.sync_paid_batch_to_received_documents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'paid' and new.status = 'paid' then
    update public.received_documents document set payment_status = 'Pagada', payment_date = new.paid_at::date, payment_method = 'Lote de pago', payment_reference = new.payment_reference, payment_notes = concat('Pagada por lote ', new.batch_number), payment_recorded_at = now(), payment_recorded_by = auth.uid()
    from public.payment_batch_items item where item.payment_batch_id = new.id and item.received_document_id = document.id and item.organization_id = new.organization_id and document.organization_id = new.organization_id;
    update public.direct_payables payable set status = 'paid', paid_at = new.paid_at, payment_reference = new.payment_reference
    from public.payment_batch_items item where item.payment_batch_id = new.id and item.direct_payable_id = payable.id and item.organization_id = new.organization_id and payable.organization_id = new.organization_id and payable.status = 'approved';
  end if;
  return new;
end;
$$;

alter table public.direct_payables enable row level security;

create policy "finance and audit read direct payables" on public.direct_payables for select to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = direct_payables.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance', 'operations', 'auditor'))
);
create policy "finance roles manage direct payables" on public.direct_payables for all to authenticated using (
  exists (select 1 from public.organization_memberships m where m.organization_id = direct_payables.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))
) with check (
  exists (select 1 from public.organization_memberships m where m.organization_id = direct_payables.organization_id and m.user_id = (select auth.uid()) and m.role in ('administrator', 'finance'))
);

grant select, insert, update, delete on public.direct_payables to authenticated;
revoke all on function public.enforce_procure_to_pay_transition() from public, anon, authenticated;
revoke all on function public.sync_procure_to_pay_approval_request() from public, anon, authenticated;
revoke all on function public.sync_approval_decision_to_procure_to_pay() from public, anon, authenticated;
revoke all on function public.sync_paid_batch_to_received_documents() from public, anon, authenticated;
