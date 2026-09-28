-- Remuneraciones como cuentas por pagar directas, no como facturas.
--
-- Causa raíz: los finiquitos (y cotizaciones de Isapre) se registraban como
-- gasto "Otro" contra un proveedor genérico ("Finiquitos"/"Remuneraciones"),
-- con folio de factura. Así aparecían como gasto de proveedores, entraban a
-- la lógica de folios duplicados y documentos pendientes, y el acreedor real
-- (la persona o la institución previsional) quedaba sin registrar.
--
-- Modelo:
--   * Nuevas categorías 'payroll' (Sueldos y remuneraciones) y
--     'social_security' (Leyes sociales / cotizaciones) junto a
--     'termination' (Finiquito). Las tres son remuneraciones: cuenta 610200
--     "Remuneraciones y cargas sociales", pasivo 210300 "Remuneraciones y
--     cargas por pagar" y NIC 7 operación ("pagos a y por cuenta de los
--     empleados"). Ver src/lib/expense-categories.ts.
--   * El acreedor es beneficiary_name (+ beneficiary_tax_id opcional); no se
--     exige contraparte proveedora. La API exige el beneficiario al crear.
--   * direct_payables_payroll_shape_check: una remuneración no lleva folio de
--     factura, documento pendiente/vinculado, factoring ni cuota de
--     financiamiento. Con folio nulo quedan fuera, sin redefinirlas, de
--     private.guard_direct_payable_document_identity,
--     private.guard_received_document_payable_identity y de la vinculación de
--     documentos pendientes.
--   * enforce_procure_to_pay_transition: idéntica a la definición vigente
--     (20260928183206, md5 prosrc 7243f943a767cd16f6bc9469076ae8ab en
--     producción) salvo que beneficiary_tax_id se puede corregir tras el envío,
--     igual que beneficiary_name.
--   * Corrección de datos: finiquitos y cotizaciones registrados como "Otro"
--     pasan a su categoría de remuneración. El trigger de transiciones se
--     desactiva sólo dentro de esta transacción (ALTER TABLE toma un lock que
--     impide escrituras concurrentes hasta el commit); la auditoría sigue
--     registrando cada cambio.
--
-- Idempotente: se puede volver a ejecutar sin efectos adicionales.

-- ---------------------------------------------------------------------------
-- 1. RUT opcional de la persona o institución beneficiaria.
-- ---------------------------------------------------------------------------
alter table public.direct_payables
  add column if not exists beneficiary_tax_id text;

alter table public.direct_payables
  drop constraint if exists direct_payables_beneficiary_tax_id_check;
alter table public.direct_payables
  add constraint direct_payables_beneficiary_tax_id_check
  check (beneficiary_tax_id is null or beneficiary_tax_id ~ '^[1-9][0-9]{6,7}-[0-9K]$');

comment on column public.direct_payables.beneficiary_name is
  'Acreedor real cuando no es un proveedor: persona desvinculada, trabajador/a o institución previsional. Obligatorio (vía API) en remuneraciones.';
comment on column public.direct_payables.beneficiary_tax_id is
  'RUT canónico (12345678-K) de la persona o institución beneficiaria. Opcional.';

-- ---------------------------------------------------------------------------
-- 2. Categorías de remuneraciones.
-- ---------------------------------------------------------------------------
alter table public.direct_payables
  drop constraint if exists direct_payables_category_check;
alter table public.direct_payables
  add constraint direct_payables_category_check
  check (category = any (array[
    'utilities', 'rent', 'taxes', 'insurance', 'subscriptions',
    'payroll', 'social_security', 'termination', 'other'
  ]::text[]));

comment on column public.direct_payables.category is
  'utilities/rent/taxes/insurance/subscriptions/other = gasto de proveedores; payroll/social_security/termination = remuneraciones (cuenta 610200), no facturas.';

-- ---------------------------------------------------------------------------
-- 3. Transiciones: beneficiary_tax_id se corrige igual que beneficiary_name.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_procure_to_pay_transition()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_document_rpc boolean := coalesce(current_setting('app.direct_payable_document_link',true),'off')='on';
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
      if old.status<>'draft' and (to_jsonb(new)-array['updated_at','beneficiary_name','beneficiary_tax_id','invoice_number','supplier_name','received_document_id','document_status','document_linked_at','document_linked_by']) is distinct from (to_jsonb(old)-array['updated_at','beneficiary_name','beneficiary_tax_id','invoice_number','supplier_name','received_document_id','document_status','document_linked_at','document_linked_by']) then raise exception 'Only supplier, beneficiary or invoice number can be corrected after direct payable submission'; end if;
    elsif old.status='draft' and new.status='review' then null;
    elsif old.status='review' and new.status in ('approved','rejected') then
      if not exists(select 1 from public.approval_requests r where r.organization_id=new.organization_id and r.target_type='payment' and r.target_id=new.id and r.status=new.status and r.metadata->>'kind'='direct_payable') then raise exception 'Direct payable must be decided in approvals'; end if;
    elsif old.status='approved' and new.status='paid' then if new.paid_at is null then raise exception 'Paid date is required'; end if;
    elsif old.status in ('draft','review','approved','rejected') and new.status='cancelled' then if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid direct payable transition'; end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_procure_to_pay_transition() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Corrección de datos: remuneraciones registradas como gasto "Otro".
-- ---------------------------------------------------------------------------
alter table public.direct_payables disable trigger direct_payables_enforce_transition;

-- Finiquitos: categoría propia, sin folio de factura ("Finiquito" no es un
-- folio) y sin la contraparte genérica "Remuneraciones"/"Finiquitos", que no
-- es un proveedor (quedó inactiva en la limpieza de contrapartes).
update public.direct_payables payable
set category = 'termination',
    category_detail = 'Finiquito',
    invoice_number = null,
    supplier_counterparty_id = case
      when exists (
        select 1 from public.counterparties generic
        where generic.id = payable.supplier_counterparty_id
          and generic.organization_id = payable.organization_id
          and (lower(btrim(coalesce(generic.legal_name, ''))) ~ '^(remuneraciones|finiquitos?)$'
            or lower(btrim(coalesce(generic.trade_name, ''))) ~ '^(remuneraciones|finiquitos?)$')
      ) then null
      else payable.supplier_counterparty_id
    end
where payable.category = 'other'
  and lower(btrim(coalesce(payable.category_detail, ''))) ~ '^finiquit'
  and payable.document_status = 'not_required'
  and not payable.is_reference
  and payable.factoring_issued_document_id is null
  and payable.asset_financing_installment_id is null;

-- Las cuentas que ya eran 'termination' tampoco llevan folio ni contraparte genérica.
with generic_link as (
  select payable.id,
    exists (
      select 1 from public.counterparties generic
      where generic.id = payable.supplier_counterparty_id
        and generic.organization_id = payable.organization_id
        and (lower(btrim(coalesce(generic.legal_name, ''))) ~ '^(remuneraciones|finiquitos?)$'
          or lower(btrim(coalesce(generic.trade_name, ''))) ~ '^(remuneraciones|finiquitos?)$')
    ) as is_generic
  from public.direct_payables payable
  where payable.category = 'termination'
)
update public.direct_payables payable
set invoice_number = null,
    supplier_counterparty_id = case when generic_link.is_generic then null else payable.supplier_counterparty_id end
from generic_link
where generic_link.id = payable.id
  and (payable.invoice_number is not null or generic_link.is_generic);

-- Cotizaciones previsionales / Isapre: leyes sociales. La institución sigue
-- siendo la contraparte y pasa a figurar también como beneficiaria.
update public.direct_payables payable
set category = 'social_security',
    beneficiary_name = coalesce(payable.beneficiary_name, payable.supplier_name),
    invoice_number = null
where payable.category = 'other'
  and payable.category_detail ~* '(cotizaci|isapre|imposici|leyes? social|previred|\mafp\M)'
  and payable.category_detail !~* 'honorario'
  and payable.document_status = 'not_required'
  and not payable.is_reference
  and payable.factoring_issued_document_id is null
  and payable.asset_financing_installment_id is null;

-- Sueldos y remuneraciones escritos a mano como "Otro".
update public.direct_payables payable
set category = 'payroll',
    beneficiary_name = coalesce(
      payable.beneficiary_name,
      case when lower(btrim(payable.supplier_name)) !~ '^(remuneraciones|sueldos?|finiquitos?)$'
        then nullif(btrim(payable.supplier_name), '') end
    ),
    invoice_number = null,
    supplier_counterparty_id = case
      when exists (
        select 1 from public.counterparties generic
        where generic.id = payable.supplier_counterparty_id
          and generic.organization_id = payable.organization_id
          and (lower(btrim(coalesce(generic.legal_name, ''))) ~ '^(remuneraciones|sueldos?|finiquitos?)$'
            or lower(btrim(coalesce(generic.trade_name, ''))) ~ '^(remuneraciones|sueldos?|finiquitos?)$')
      ) then null
      else payable.supplier_counterparty_id
    end
where payable.category = 'other'
  and payable.category_detail ~* '(sueldo|remuneraci|gratificaci|aguinaldo)'
  and payable.category_detail !~* 'honorario'
  and payable.document_status = 'not_required'
  and not payable.is_reference
  and payable.factoring_issued_document_id is null
  and payable.asset_financing_installment_id is null;

alter table public.direct_payables enable trigger direct_payables_enforce_transition;

-- ---------------------------------------------------------------------------
-- 5. Una remuneración no es una factura: sin folio, sin documento tributario
--    pendiente ni vinculado, sin factoring ni cuota de financiamiento.
-- ---------------------------------------------------------------------------
alter table public.direct_payables
  drop constraint if exists direct_payables_payroll_shape_check;
alter table public.direct_payables
  add constraint direct_payables_payroll_shape_check
  check (
    category not in ('payroll', 'social_security', 'termination')
    or (
      invoice_number is null
      and document_status = 'not_required'
      and received_document_id is null
      and expected_document_type is null
      and not is_reference
      and factoring_issued_document_id is null
      and asset_financing_installment_id is null
    )
  );
