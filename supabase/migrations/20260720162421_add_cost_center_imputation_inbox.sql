-- Permite completar la imputación histórica sin reabrir el flujo de pagos ni
-- modificar sus demás atributos.
alter table public.direct_payables
  add column category_detail text,
  add constraint direct_payables_category_detail_check
    check (category_detail is null or length(btrim(category_detail)) between 2 and 120);

create or replace function public.enforce_procure_to_pay_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_table_name = 'purchase_requests' then
    if new.status = old.status then
      if old.status <> 'draft' then raise exception 'Only draft purchase requests can be edited'; end if;
    elsif old.status = 'draft' and new.status = 'review' then null;
    elsif old.status = 'review' and new.status in ('approved', 'rejected') then
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'purchase_order' and r.target_id = new.id and r.status = new.status and r.metadata->>'kind' = 'purchase_request') then raise exception 'Purchase request must be decided in approvals'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'rejected') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid purchase request transition'; end if;
  elsif tg_table_name = 'vendor_purchase_orders' then
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
  elsif tg_table_name = 'payment_batches' then
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
  elsif tg_table_name = 'direct_payables' then
    if new.status = old.status then
      if old.status <> 'draft' and (to_jsonb(new) - array['updated_at', 'cost_center_id']) is distinct from (to_jsonb(old) - array['updated_at', 'cost_center_id']) then
        raise exception 'Only cost center can be updated after direct payable submission';
      end if;
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

create or replace function public.enforce_asset_financing_plan_transition()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.status = old.status then
    if old.status <> 'draft' and (to_jsonb(new) - array['updated_at', 'cost_center_id']) is distinct from (to_jsonb(old) - array['updated_at', 'cost_center_id']) then
      raise exception 'Only cost center can be updated after financing plan submission';
    end if;
  elsif old.status = 'draft' and new.status = 'review' then null;
  elsif old.status = 'review' and new.status in ('approved', 'rejected') then
    if not exists (select 1 from public.approval_requests request where request.organization_id = new.organization_id and request.target_type = 'payment' and request.target_id = new.id and request.status = new.status and request.metadata->>'kind' = 'asset_financing_plan') then raise exception 'Financing plan must be decided in approvals'; end if;
  elsif old.status = 'approved' and new.status = 'completed' then null;
  elsif old.status in ('draft', 'review', 'approved', 'rejected') and new.status = 'cancelled' then null;
  else raise exception 'Invalid financing plan transition'; end if;
  return new;
end;
$$;

create or replace function public.audit_direct_payable_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (organization_id, actor_id, entity_type, entity_id, action, before_state, after_state)
  values (new.organization_id, auth.uid(), 'direct_payable', new.id, 'update', to_jsonb(old), to_jsonb(new));
  return new;
end;
$$;

create trigger direct_payables_audit_changes
after update on public.direct_payables
for each row execute function public.audit_direct_payable_changes();

revoke all on function public.enforce_procure_to_pay_transition() from public, anon, authenticated;
revoke all on function public.enforce_asset_financing_plan_transition() from public, anon, authenticated;
revoke all on function public.audit_direct_payable_changes() from public, anon, authenticated;

-- La aprobación conserva el detalle operativo que se revisó. Así el modal no
-- depende de una nota genérica y también mantiene una fotografía del gasto.
create or replace function public.sync_procure_to_pay_approval_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy_id uuid;
  v_target_type text;
  v_amount numeric;
  v_title text;
  v_kind text;
  v_requested_by uuid;
  v_description text;
  v_metadata jsonb;
begin
  if new.status <> 'review' or old.status <> 'draft' then return new; end if;

  if tg_table_name = 'payment_batches' then
    v_target_type := 'payment'; v_amount := new.total_amount; v_title := 'Lote de pago ' || new.batch_number; v_kind := 'payment_batch'; v_requested_by := new.created_by;
    v_description := coalesce(new.notes, ''); v_metadata := jsonb_build_object('kind', v_kind);
  elsif tg_table_name = 'direct_payables' then
    v_target_type := 'payment'; v_amount := new.total_amount; v_title := 'Cuenta por pagar ' || new.payable_number; v_kind := 'direct_payable'; v_requested_by := new.created_by;
    v_description := concat('Concepto: ', new.description, case when new.notes is not null and btrim(new.notes) <> '' then ' · Respaldo: ' || new.notes else '' end);
    v_metadata := jsonb_build_object(
      'kind', v_kind,
      'supplier_name', new.supplier_name,
      'invoice_number', new.invoice_number,
      'category', new.category,
      'category_detail', new.category_detail,
      'description', new.description,
      'issue_date', new.issue_date,
      'due_date', new.due_date,
      'notes', new.notes,
      'cost_center_id', new.cost_center_id
    );
  elsif tg_table_name = 'vendor_purchase_orders' then
    v_target_type := 'purchase_order'; v_amount := new.total_amount; v_title := 'Orden de compra ' || new.purchase_order_number; v_kind := 'vendor_purchase_order'; v_requested_by := new.created_by;
    v_description := coalesce(new.notes, ''); v_metadata := jsonb_build_object('kind', v_kind);
  else
    v_target_type := 'purchase_order'; v_amount := new.estimated_amount; v_title := 'Solicitud de compra ' || new.request_number; v_kind := 'purchase_request'; v_requested_by := new.requested_by;
    v_description := coalesce(new.notes, ''); v_metadata := jsonb_build_object('kind', v_kind);
  end if;

  select id into policy_id from public.approval_policies
  where organization_id = new.organization_id and target_type = v_target_type and is_active
    and currency_code = new.currency_code and minimum_amount <= v_amount
    and (maximum_amount is null or maximum_amount >= v_amount)
  order by minimum_amount desc limit 1;
  if policy_id is null then raise exception 'No approval policy applies'; end if;

  insert into public.approval_requests (organization_id, approval_policy_id, target_type, target_id, title, description, amount, currency_code, requested_by, metadata)
  values (new.organization_id, policy_id, v_target_type, new.id, v_title, v_description, v_amount, new.currency_code, coalesce(v_requested_by, auth.uid()), v_metadata)
  on conflict (organization_id, target_type, target_id) where status = 'submitted' do nothing;
  return new;
end;
$$;

revoke all on function public.sync_procure_to_pay_approval_request() from public, anon, authenticated;
