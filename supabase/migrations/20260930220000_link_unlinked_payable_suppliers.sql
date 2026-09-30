-- Una cuenta por pagar enviada sin ficha de proveedor ("proveedor no
-- registrado") no se podía vincular después al maestro: el trigger sólo
-- permitía corregir nombre, beneficiario y folio. Ahora también acepta
-- vincular supplier_counterparty_id cuando estaba vacío (nunca reasignar
-- una cuenta ya vinculada a otro proveedor).
create or replace function public.enforce_procure_to_pay_transition()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  v_document_rpc boolean := coalesce(current_setting('app.direct_payable_document_link',true),'off')='on';
  v_correctable text[];
begin
  if tg_table_name='purchase_requests' then
    if new.status=old.status then if old.status<>'draft' then raise exception 'Only draft purchase requests can be edited'; end if;
    elsif old.status='draft' and new.status='review' then null;
    elsif old.status='review' and new.status in ('approved','rejected') then
      if not exists(select 1 from public.approval_requests r where r.organization_id=new.organization_id and r.target_type='purchase_order' and r.target_id=new.id and r.status=new.status and r.metadata->>'kind'='purchase_request') then raise exception 'Purchase request must be decided in approvals'; end if;
    elsif old.status in ('draft','review','approved','rejected') and new.status='cancelled' then if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid purchase request transition'; end if;
  elsif tg_table_name='vendor_purchase_orders' then
    if new.status=old.status then if old.status<>'draft' then raise exception 'Only draft purchase orders can be edited'; end if;
    elsif old.status='draft' and new.status='review' then null;
    elsif old.status='review' and new.status in ('approved','cancelled') then
      if new.status='approved' and not exists(select 1 from public.approval_requests r where r.organization_id=new.organization_id and r.target_type='purchase_order' and r.target_id=new.id and r.status='approved' and r.metadata->>'kind'='vendor_purchase_order') then raise exception 'Purchase order must be approved in approvals'; end if;
    elsif old.status='approved' and new.status='sent' then null;
    elsif old.status='sent' and new.status in ('partially_received','received') then null;
    elsif old.status='partially_received' and new.status='received' then null;
    elsif old.status in ('draft','review','approved','sent','partially_received') and new.status='cancelled' then if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid purchase order transition'; end if;
  elsif tg_table_name='payment_batches' then
    if new.status=old.status then
      if old.status<>'draft' and not (
        current_setting('app.payment_item_rpc',true)='on'
        and (to_jsonb(new)-array['updated_at','total_amount','cash_flow_classification'])
          is not distinct from (to_jsonb(old)-array['updated_at','total_amount','cash_flow_classification'])
      ) then raise exception 'Only draft payment batches can be edited'; end if;
    elsif old.status='draft' and new.status='review' then null;
    elsif old.status='review' and new.status='approved' then
      if not exists(select 1 from public.approval_requests r where r.organization_id=new.organization_id and r.target_type='payment' and r.target_id=new.id and r.status='approved' and r.metadata->>'kind'='payment_batch') then raise exception 'Payment batch must be approved in approvals'; end if;
    elsif old.status='approved' and new.status='processing' then null;
    elsif old.status in ('approved','processing') and new.status='paid' then
      if new.paid_at is null then raise exception 'Paid date is required'; end if;
      if new.payment_proof_path is null then raise exception 'Payment proof is required'; end if;
    elsif old.status in ('draft','review','approved','processing') and new.status='cancelled' then if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid payment batch transition'; end if;
  elsif tg_table_name='direct_payables' then
    if not v_document_rpc and (
      new.received_document_id is distinct from old.received_document_id
      or new.document_status is distinct from old.document_status
      or new.document_linked_at is distinct from old.document_linked_at
      or new.document_linked_by is distinct from old.document_linked_by
    ) then raise exception 'Direct payable documents can only change through link_direct_payable_document'; end if;
    if not v_document_rpc and old.document_status='documented' and new.invoice_number is distinct from old.invoice_number then
      raise exception 'Documented direct payables keep the linked document folio';
    end if;
    if new.status=old.status then
      v_correctable := array['updated_at','beneficiary_name','beneficiary_tax_id','invoice_number','supplier_name','received_document_id','document_status','document_linked_at','document_linked_by']
        || case when old.supplier_counterparty_id is null then array['supplier_counterparty_id'] else array[]::text[] end;
      if old.status<>'draft' and (to_jsonb(new)-v_correctable) is distinct from (to_jsonb(old)-v_correctable) then raise exception 'Only supplier, beneficiary or invoice number can be corrected after direct payable submission'; end if;
    elsif old.status='draft' and new.status='review' then null;
    elsif old.status='review' and new.status in ('approved','rejected') then
      if not exists(select 1 from public.approval_requests r where r.organization_id=new.organization_id and r.target_type='payment' and r.target_id=new.id and r.status=new.status and r.metadata->>'kind'='direct_payable') then raise exception 'Direct payable must be decided in approvals'; end if;
    elsif old.status='approved' and new.status='paid' then if new.paid_at is null then raise exception 'Paid date is required'; end if;
    elsif old.status in ('draft','review','approved','rejected') and new.status='cancelled' then if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid direct payable transition'; end if;
  end if;
  return new;
end;
$function$;

-- Personal LP (RUT 13109521-K): gastos ingresados como "proveedor no
-- registrado" (Parque del Recuerdo, EFF, C Dar / C-Dar). Se crea su ficha y
-- se vinculan, confirmado por el usuario el 2026-09-30.
with organization as (
  select id from public.organizations where lower(tax_id) = '13109521-k'
), suppliers (name) as (
  values ('Parque del Recuerdo'), ('EFF'), ('C Dar')
), created as (
  insert into public.counterparties (organization_id, legal_name, trade_name, kind)
  select organization.id, suppliers.name, suppliers.name, 'supplier'
  from organization, suppliers
  where not exists (
    select 1 from public.counterparties existing
    where existing.organization_id = organization.id
      and lower(existing.legal_name) = lower(suppliers.name)
  )
  returning id, organization_id, legal_name
)
update public.direct_payables payable
set supplier_counterparty_id = created.id,
    supplier_name = created.legal_name
from created
where payable.organization_id = created.organization_id
  and payable.supplier_counterparty_id is null
  and payable.category not in ('payroll', 'social_security', 'termination')
  and regexp_replace(lower(payable.supplier_name), '[^a-z0-9]', '', 'g')
    = regexp_replace(lower(created.legal_name), '[^a-z0-9]', '', 'g');
