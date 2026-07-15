-- Los contextos de trigger de PostgreSQL se exponen como TG_TABLE_NAME.
-- La referencia anterior a tg_table hacía fallar toda la transacción: en
-- particular, impedía que una prefactura enviada creara su solicitud.

create or replace function public.audit_approval_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entity_kind text := case tg_table_name when 'approval_requests' then 'approval_request' else 'approval_step' end;
begin
  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    coalesce(new.organization_id, old.organization_id),
    auth.uid(),
    entity_kind,
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create or replace function public.audit_financial_planning_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    coalesce(new.organization_id, old.organization_id),
    (select auth.uid()),
    case tg_table_name
      when 'financial_plan_versions' then 'financial_plan_version'
      when 'financial_budget_lines' then 'financial_budget_line'
      when 'cash_forecast_adjustments' then 'cash_forecast_adjustment'
      else 'profitability_cost_allocation'
    end,
    coalesce(new.id, old.id),
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

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
    elsif old.status = 'draft' and new.status = 'review' then
      null;
    elsif old.status = 'review' and new.status in ('approved', 'rejected') then
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'purchase_order' and r.target_id = new.id and r.status = new.status and r.metadata->>'kind' = 'purchase_request') then
        raise exception 'Purchase request must be decided in approvals';
      end if;
    elsif old.status in ('draft', 'review', 'approved', 'rejected') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid purchase request transition'; end if;
  elsif tg_table_name = 'vendor_purchase_orders' then
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
  elsif tg_table_name = 'payment_batches' then
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

create or replace function public.enforce_procure_to_pay_lines_editability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare v_status text; v_parent_id uuid;
begin
  if tg_table_name = 'vendor_purchase_order_lines' then
    v_parent_id := case when tg_op = 'DELETE' then old.purchase_order_id else new.purchase_order_id end;
    select status into v_status from public.vendor_purchase_orders where id = v_parent_id;
    if v_status <> 'draft' then raise exception 'Purchase order lines can only be changed while draft'; end if;
  elsif tg_table_name = 'payment_batch_items' then
    v_parent_id := case when tg_op = 'DELETE' then old.payment_batch_id else new.payment_batch_id end;
    select status into v_status from public.payment_batches where id = v_parent_id;
    if v_status <> 'draft' then raise exception 'Payment batch items can only be changed while draft'; end if;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function public.refresh_procure_to_pay_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_order_id uuid; v_batch_id uuid;
begin
  if tg_table_name = 'vendor_purchase_order_lines' then
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

create or replace function public.sync_procure_to_pay_approval_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare policy_id uuid; v_target_type text; v_amount numeric; v_title text; v_kind text; v_requested_by uuid;
begin
  if new.status <> 'review' or old.status <> 'draft' then return new; end if;
  if tg_table_name = 'payment_batches' then
    v_target_type := 'payment'; v_amount := new.total_amount; v_title := 'Lote de pago ' || new.batch_number; v_kind := 'payment_batch'; v_requested_by := new.created_by;
  elsif tg_table_name = 'vendor_purchase_orders' then
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

revoke all on function public.audit_approval_changes() from public, anon, authenticated;
revoke all on function public.audit_financial_planning_changes() from public, anon, authenticated;
revoke all on function public.refresh_procure_to_pay_totals() from public, anon, authenticated;
revoke all on function public.sync_procure_to_pay_approval_request() from public, anon, authenticated;
