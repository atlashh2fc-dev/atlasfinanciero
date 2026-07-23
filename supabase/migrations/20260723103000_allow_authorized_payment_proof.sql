-- Una orden autorizada puede quedar ejecutada al cargar su comprobante. Esto
-- conserva la aprobación obligatoria y elimina un paso manual intermedio que
-- no agrega control cuando la misma persona opera el pago.
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
    elsif old.status in ('approved', 'processing') and new.status = 'paid' then
      if new.paid_at is null then raise exception 'Paid date is required'; end if;
      if new.payment_proof_path is null then raise exception 'Payment proof is required'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'processing') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid payment batch transition'; end if;
  elsif tg_table_name = 'direct_payables' then
    if new.status = old.status then
      if old.status <> 'draft' and (to_jsonb(new) - array['updated_at', 'beneficiary_name', 'invoice_number', 'supplier_name']) is distinct from (to_jsonb(old) - array['updated_at', 'beneficiary_name', 'invoice_number', 'supplier_name']) then
        raise exception 'Only supplier, beneficiary or invoice number can be corrected after direct payable submission'; end if;
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

revoke all on function public.enforce_procure_to_pay_transition() from public, anon, authenticated;
