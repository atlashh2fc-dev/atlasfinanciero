-- Gastos con documento pendiente y control de duplicados entre cuentas
-- directas y documentos recibidos.
--
-- Muchos pagos se hacen antes de que llegue la factura (o boleta) y se
-- concilian después. Hasta ahora sólo existía el ingreso contra un documento
-- recibido con folio, o una cuenta directa creada por Finanzas que nunca se
-- relacionaba con el DTE real cuando éste llegaba: el gasto quedaba contado
-- dos veces y la factura aparecía como una segunda deuda abierta.
--
-- Esta migración:
--   1. Marca cada cuenta directa con su estado documental
--      (not_required | pending_document | documented) y el documento recibido
--      que la respalda una vez vinculado.
--   2. Permite a Digitación registrar un gasto con documento pendiente
--      (RPC create_pending_document_expense) que sigue el mismo circuito de
--      aprobación que las cuentas directas de Finanzas.
--   3. Vincula / desvincula el documento recibido (sólo Finanzas), sugiere
--      candidatos y enlaza automáticamente cuando llega una factura del mismo
--      proveedor con el mismo folio y monto que una cuenta pendiente.
--   4. Impide pagar dos veces: un documento cubierto por una cuenta directa no
--      entra a propuestas de pago y queda "Pagada" cuando se paga la cuenta.
--   5. Bloquea folios duplicados entre cuentas directas y documentos
--      recibidos, y expone find_payable_duplicates para advertir posibles
--      duplicados por proveedor, monto y fecha antes de crear.
--
-- Depende de private.received_document_supplier_key, private.normalize_folio
-- y private.received_document_kind (migración add_received_document_links).

-- ---------------------------------------------------------------------------
-- 1. Estado documental de las cuentas directas
-- ---------------------------------------------------------------------------
alter table public.direct_payables
  add column if not exists document_status text not null default 'not_required',
  add column if not exists expected_document_type text,
  add column if not exists received_document_id uuid,
  add column if not exists document_linked_at timestamptz,
  add column if not exists document_linked_by uuid references auth.users(id) on delete set null;

alter table public.direct_payables
  add constraint direct_payables_document_status_check
    check (document_status in ('not_required', 'pending_document', 'documented')),
  add constraint direct_payables_expected_document_type_check
    check (expected_document_type is null or expected_document_type in (
      'Factura afecta', 'Factura exenta', 'Boleta de honorarios', 'Boleta', 'Otro'
    )),
  add constraint direct_payables_documented_link_check
    check ((document_status = 'documented') = (received_document_id is not null)),
  add constraint direct_payables_received_document_organization_fkey
    foreign key (received_document_id, organization_id)
    references public.received_documents (id, organization_id) on delete restrict;

comment on column public.direct_payables.document_status is
  'not_required: compromiso sin documento tributario (arriendo, contribuciones); pending_document: pagado o comprometido antes de recibir el documento; documented: vinculado a received_document_id.';
comment on column public.direct_payables.received_document_id is
  'Documento recibido que respalda esta cuenta. Mientras la cuenta no esté anulada ni rechazada, el documento no se paga por separado ni se cuenta como un segundo gasto.';

-- Un documento respalda a lo más una cuenta vigente.
create unique index if not exists direct_payables_received_document_active_key
  on public.direct_payables (received_document_id)
  where received_document_id is not null and status not in ('cancelled', 'rejected');
create index if not exists direct_payables_pending_document_idx
  on public.direct_payables (organization_id, supplier_counterparty_id, issue_date)
  where document_status = 'pending_document' and received_document_id is null;

-- Digitación ve los gastos que registró (el resto de cuentas sigue reservado).
create policy "data entry reads own direct payables"
on public.direct_payables for select to authenticated
using (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = direct_payables.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

-- Respaldo opcional del gasto pendiente, cargado por Digitación bajo su
-- propia carpeta. La RPC lo registra en direct_payable_attachments.
create policy "data entry uploads pending expense support"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'direct-payable-files'
  and split_part(name, '/', 2) = 'pending-expenses'
  and split_part(name, '/', 3) = (select auth.uid())::text
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(objects.name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
  )
);

-- Limpieza de una carga cuyo registro falló: sólo archivos propios que aún no
-- forman parte de ningún expediente.
create policy "data entry removes own unregistered pending expense support"
on storage.objects for delete to authenticated
using (
  bucket_id = 'direct-payable-files'
  and split_part(name, '/', 2) = 'pending-expenses'
  and split_part(name, '/', 3) = (select auth.uid())::text
  and not exists (
    select 1 from public.direct_payable_attachments attachment
    where attachment.storage_path = objects.name
  )
);

-- ---------------------------------------------------------------------------
-- 2. Normalizadores
-- ---------------------------------------------------------------------------
create or replace function private.direct_payable_supplier_key(
  p_counterparty_id uuid, p_name text
) returns text
language sql stable security definer set search_path = '' as $$
  select private.received_document_supplier_key(
    (select counterparty.tax_id from public.counterparties counterparty where counterparty.id = p_counterparty_id),
    p_counterparty_id,
    p_name
  );
$$;

create or replace function private.received_document_folio(p_sii_folio bigint, p_document_number text)
returns text
language sql immutable set search_path = '' as $$
  select private.normalize_folio(coalesce(p_sii_folio::text, p_document_number));
$$;

revoke all on function private.direct_payable_supplier_key(uuid, text) from public, anon, authenticated;
revoke all on function private.received_document_folio(bigint, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Transiciones: los campos documentales sólo cambian por las RPC de
--    vinculación. Basado en la definición de 20260812013000.
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
      if old.status<>'draft' and (to_jsonb(new)-array['updated_at','beneficiary_name','invoice_number','supplier_name','received_document_id','document_status','document_linked_at','document_linked_by']) is distinct from (to_jsonb(old)-array['updated_at','beneficiary_name','invoice_number','supplier_name','received_document_id','document_status','document_linked_at','document_linked_by']) then raise exception 'Only supplier, beneficiary or invoice number can be corrected after direct payable submission'; end if;
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

-- ---------------------------------------------------------------------------
-- 4. Propuestas de pago: un documento cubierto por una cuenta directa se paga
--    a través de esa cuenta. Basado en la definición de 20260812013000.
-- ---------------------------------------------------------------------------
create or replace function public.validate_payment_batch_document_assignment()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  document_row public.received_documents%rowtype;
  payable_row public.direct_payables%rowtype;
  settled_amount numeric(18,2);
begin
  if new.direct_payable_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':'||new.direct_payable_id::text,0));
    select * into payable_row from public.direct_payables
      where id=new.direct_payable_id and organization_id=new.organization_id for key share;
    if not found or coalesce(payable_row.total_amount,0)<=0 then raise exception 'Direct payable is not available for payment'; end if;
    if payable_row.status<>'approved' or payable_row.is_reference then raise exception 'Only approved direct payables can be added to a payment batch'; end if;
    select coalesce(sum(execution.amount),0) into settled_amount from public.payment_executions execution
      where execution.organization_id=new.organization_id and execution.direct_payable_id=new.direct_payable_id;
    if new.amount>payable_row.total_amount-settled_amount+0.01 then raise exception 'Payment batch amount exceeds direct payable outstanding balance'; end if;
    if new.supplier_name_snapshot is distinct from payable_row.supplier_name
      or new.document_number_snapshot is distinct from coalesce(payable_row.invoice_number,payable_row.payable_number)
      or new.due_date_snapshot is distinct from payable_row.due_date then
      raise exception 'Payment batch snapshots must match the direct payable at assignment time';
    end if;
    if exists(select 1 from public.payment_batch_items item
      join public.payment_batches batch on batch.id=item.payment_batch_id and batch.organization_id=item.organization_id
      where item.organization_id=new.organization_id and item.direct_payable_id=new.direct_payable_id
        and item.authorization_status='authorized'
        and batch.status in ('draft','review','approved','processing')
        and (tg_op<>'UPDATE' or item.id<>old.id)) then
      raise exception 'Direct payable already belongs to an active payment batch';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':'||new.received_document_id::text,0));
  select * into document_row from public.received_documents
    where id=new.received_document_id and organization_id=new.organization_id for key share;
  if not found or coalesce(document_row.total_amount,0)<=0 then raise exception 'Received document is not available for payment'; end if;
  if lower(coalesce(document_row.payment_status,'')) like '%pagada%' then raise exception 'Paid received document cannot be added to a payment batch'; end if;
  if exists(select 1 from public.direct_payables payable
    where payable.organization_id=new.organization_id and payable.received_document_id=new.received_document_id
      and payable.status not in ('cancelled','rejected')) then
    raise exception 'Received document is covered by a direct payable';
  end if;
  if document_row.purchase_match_status not in ('matched','exception','not_required') then raise exception 'Received document requires purchase match or approved exception before payment'; end if;
  if document_row.purchase_match_status='exception'
    and (document_row.purchase_match_approved_at is null or document_row.purchase_match_approved_by is null) then
    raise exception 'Purchase match exception is not approved';
  end if;
  select coalesce(sum(execution.amount),0) into settled_amount from public.payment_executions execution
    where execution.organization_id=new.organization_id and execution.received_document_id=new.received_document_id;
  if new.amount>document_row.total_amount-settled_amount+0.01 then raise exception 'Payment batch amount exceeds received document outstanding balance'; end if;
  if new.supplier_name_snapshot is distinct from document_row.supplier_name
    or new.document_number_snapshot is distinct from document_row.document_number
    or new.due_date_snapshot is distinct from document_row.due_date then
    raise exception 'Payment batch snapshots must match the received document at assignment time';
  end if;
  if exists(select 1 from public.payment_batch_items item
    join public.payment_batches batch on batch.id=item.payment_batch_id and batch.organization_id=item.organization_id
    where item.organization_id=new.organization_id and item.received_document_id=new.received_document_id
      and item.authorization_status='authorized'
      and batch.status in ('draft','review','approved','processing')
      and (tg_op<>'UPDATE' or item.id<>old.id)) then
    raise exception 'Received document already belongs to an active payment batch';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Estado de pago del documento cubierto.
--
-- Se refleja en received_documents (igual que un pago por propuesta) para que
-- el documento no vuelva a aparecer como deuda abierta. Se escribe desde
-- triggers (profundidad > 1) porque prevent_direct_document_payment_status_change
-- sólo admite liquidar documentos por el libro de ejecuciones. La marca
-- payment_method = 'Cuenta por pagar directa' permite revertirlo al desvincular.
-- La salida de caja sigue registrada una sola vez: en la ejecución de la
-- cuenta directa.
-- ---------------------------------------------------------------------------
create or replace function private.sync_direct_payable_document_payment(p_direct_payable_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_payable public.direct_payables%rowtype;
  v_settled numeric(18,2);
  v_last_paid_on date;
  v_status text;
begin
  select * into v_payable from public.direct_payables where id = p_direct_payable_id;
  if not found or v_payable.received_document_id is null or v_payable.status in ('cancelled', 'rejected') then
    return;
  end if;
  select coalesce(sum(execution.amount), 0), max(execution.executed_on)
    into v_settled, v_last_paid_on
  from public.payment_executions execution
  where execution.organization_id = v_payable.organization_id
    and execution.direct_payable_id = v_payable.id;
  if v_payable.status = 'paid' or v_settled >= v_payable.total_amount - 0.01 then
    v_status := 'Pagada';
  elsif v_settled > 0 then
    v_status := 'Abonada';
  else
    return;
  end if;

  update public.received_documents document set
    payment_status = v_status,
    payment_date = coalesce(v_payable.paid_at::date, v_last_paid_on, current_date),
    payment_method = 'Cuenta por pagar directa',
    payment_reference = v_payable.payment_reference,
    payment_notes = case when v_status = 'Pagada'
      then 'Pagada mediante la cuenta por pagar directa ' || v_payable.payable_number
      else 'Abonada mediante la cuenta por pagar directa ' || v_payable.payable_number end,
    payment_recorded_at = now(),
    payment_recorded_by = auth.uid()
  where document.id = v_payable.received_document_id
    and document.organization_id = v_payable.organization_id
    and not exists (
      select 1 from public.payment_executions execution
      where execution.received_document_id = document.id
    )
    and (
      document.payment_status is distinct from v_status
      or document.payment_method is distinct from 'Cuenta por pagar directa'
      or document.payment_date is distinct from coalesce(v_payable.paid_at::date, v_last_paid_on, current_date)
    );
end;
$$;

create or replace function private.revert_direct_payable_document_payment(
  p_organization_id uuid, p_received_document_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.received_documents document set
    payment_status = 'Pendiente',
    payment_date = null,
    payment_method = null,
    payment_reference = null,
    payment_notes = null,
    payment_recorded_at = null,
    payment_recorded_by = null
  where document.id = p_received_document_id
    and document.organization_id = p_organization_id
    and document.payment_method = 'Cuenta por pagar directa'
    and not exists (
      select 1 from public.payment_executions execution
      where execution.received_document_id = document.id
    );
end;
$$;

create or replace function private.sync_direct_payable_document_payment_trigger()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'payment_executions' then
    perform private.sync_direct_payable_document_payment(new.direct_payable_id);
    return null;
  end if;
  if old.received_document_id is not null
    and old.received_document_id is distinct from new.received_document_id then
    perform private.revert_direct_payable_document_payment(old.organization_id, old.received_document_id);
  end if;
  if new.received_document_id is not null then
    perform private.sync_direct_payable_document_payment(new.id);
  end if;
  return null;
end;
$$;

create trigger direct_payables_sync_document_payment
after update of status, received_document_id on public.direct_payables
for each row
when (new.received_document_id is not null or old.received_document_id is not null)
execute function private.sync_direct_payable_document_payment_trigger();

create trigger payment_executions_sync_covered_document
after insert on public.payment_executions
for each row
when (new.direct_payable_id is not null)
execute function private.sync_direct_payable_document_payment_trigger();

revoke all on function private.sync_direct_payable_document_payment(uuid) from public, anon, authenticated;
revoke all on function private.revert_direct_payable_document_payment(uuid, uuid) from public, anon, authenticated;
revoke all on function private.sync_direct_payable_document_payment_trigger() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Vinculación de documento
-- ---------------------------------------------------------------------------
create or replace function private.link_direct_payable_document_internal(
  p_direct_payable_id uuid,
  p_received_document_id uuid,
  p_allow_amount_difference boolean,
  p_origin text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_payable public.direct_payables%rowtype;
  v_document public.received_documents%rowtype;
  v_document_folio text;
  v_document_number text;
  v_difference numeric(18,2);
begin
  select * into v_payable from public.direct_payables
  where id = p_direct_payable_id for update;
  if not found then raise exception 'Direct payable not found'; end if;
  if v_payable.status in ('cancelled', 'rejected') or v_payable.is_reference then
    raise exception 'Direct payable is not available for document linking';
  end if;
  if v_payable.received_document_id is not null or v_payable.document_status = 'documented' then
    raise exception 'Direct payable already has a linked document';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_payable.organization_id::text || ':' || p_received_document_id::text, 0));
  select * into v_document from public.received_documents
  where id = p_received_document_id and organization_id = v_payable.organization_id
  for update;
  if not found then raise exception 'Received document not found in the same organization'; end if;
  if private.received_document_kind(v_document.document_type, v_document.sii_document_type) not in ('invoice', 'other') then
    raise exception 'Only invoices or equivalent charge documents can be linked';
  end if;
  if coalesce(v_document.total_amount, 0) <= 0 then
    raise exception 'Received document amount must be positive';
  end if;
  if private.received_document_supplier_key(v_document.supplier_tax_id, v_document.supplier_counterparty_id, v_document.supplier_name)
      is distinct from private.direct_payable_supplier_key(v_payable.supplier_counterparty_id, v_payable.supplier_name)
    and (v_document.supplier_counterparty_id is null
      or v_document.supplier_counterparty_id is distinct from v_payable.supplier_counterparty_id) then
    raise exception 'Received document supplier does not match the direct payable';
  end if;
  if exists (
    select 1 from public.direct_payables other
    where other.received_document_id = v_document.id
      and other.status not in ('cancelled', 'rejected')
  ) then raise exception 'Received document is already linked to another direct payable'; end if;
  if exists (select 1 from public.payment_executions execution where execution.received_document_id = v_document.id)
    or lower(coalesce(v_document.payment_status, '')) similar to '%(pagada|abonada)%' then
    raise exception 'Received document already has recorded payments';
  end if;
  if exists (
    select 1 from public.payment_batch_items item
    join public.payment_batches batch on batch.id = item.payment_batch_id and batch.organization_id = item.organization_id
    where item.organization_id = v_payable.organization_id
      and item.received_document_id = v_document.id
      and item.authorization_status = 'authorized'
      and batch.status in ('draft', 'review', 'approved', 'processing')
  ) then raise exception 'Received document belongs to an active payment batch'; end if;

  v_difference := round(v_document.total_amount - v_payable.total_amount, 2);
  if abs(v_difference) > 1 and not coalesce(p_allow_amount_difference, false) then
    raise exception 'Received document amount differs from the direct payable';
  end if;

  v_document_folio := private.received_document_folio(v_document.sii_folio, v_document.document_number);
  v_document_number := coalesce(nullif(btrim(v_document.document_number), ''), v_document.sii_folio::text);
  if nullif(btrim(v_payable.invoice_number), '') is not null
    and private.normalize_folio(v_payable.invoice_number) is distinct from v_document_folio then
    raise exception 'Direct payable invoice number does not match the received document folio';
  end if;

  perform set_config('app.direct_payable_document_link', 'on', true);
  update public.direct_payables set
    received_document_id = v_document.id,
    document_status = 'documented',
    invoice_number = coalesce(nullif(btrim(invoice_number), ''), v_document_number),
    document_linked_at = now(),
    document_linked_by = auth.uid()
  where id = v_payable.id;
  perform set_config('app.direct_payable_document_link', 'off', true);

  -- El documento hereda la imputación del gasto si llegó sin centro de costo.
  update public.received_documents set cost_center_id = v_payable.cost_center_id
  where id = v_document.id and cost_center_id is null and v_payable.cost_center_id is not null;

  insert into public.audit_log (organization_id, actor_id, entity_type, entity_id, action, before_state, after_state)
  values (
    v_payable.organization_id, auth.uid(), 'direct_payable', v_payable.id, 'link_document',
    jsonb_build_object('document_status', v_payable.document_status, 'invoice_number', v_payable.invoice_number),
    jsonb_build_object(
      'received_document_id', v_document.id,
      'document_number', v_document_number,
      'document_total', v_document.total_amount,
      'payable_total', v_payable.total_amount,
      'amount_difference', v_difference,
      'origin', p_origin
    )
  );

  return jsonb_build_object(
    'direct_payable_id', v_payable.id,
    'received_document_id', v_document.id,
    'document_number', v_document_number,
    'amount_difference', v_difference,
    'origin', p_origin
  );
end;
$$;

create or replace function public.link_direct_payable_document(
  p_direct_payable_id uuid,
  p_received_document_id uuid,
  p_allow_amount_difference boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_organization_id uuid;
begin
  select organization_id into v_organization_id from public.direct_payables where id = p_direct_payable_id;
  if auth.uid() is null or v_organization_id is null or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = v_organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance')
  ) then raise exception 'Finance access required'; end if;
  return private.link_direct_payable_document_internal(
    p_direct_payable_id, p_received_document_id, p_allow_amount_difference, 'manual'
  );
end;
$$;

create or replace function public.unlink_direct_payable_document(
  p_direct_payable_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_payable public.direct_payables%rowtype;
  v_document public.received_documents%rowtype;
begin
  select * into v_payable from public.direct_payables where id = p_direct_payable_id for update;
  if auth.uid() is null or not found or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = v_payable.organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance')
  ) then raise exception 'Finance access required'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'Unlink reason is required';
  end if;
  if v_payable.received_document_id is null then raise exception 'Direct payable has no linked document'; end if;
  if v_payable.status = 'cancelled' then raise exception 'Cancelled direct payables cannot be changed'; end if;

  select * into v_document from public.received_documents where id = v_payable.received_document_id;
  if exists (select 1 from public.payment_executions execution where execution.received_document_id = v_payable.received_document_id) then
    raise exception 'Received document has its own recorded payments';
  end if;

  perform set_config('app.direct_payable_document_link', 'on', true);
  update public.direct_payables set
    received_document_id = null,
    document_status = 'pending_document',
    invoice_number = case
      when private.normalize_folio(invoice_number) = private.received_document_folio(v_document.sii_folio, v_document.document_number)
        then null
      else invoice_number
    end,
    document_linked_at = null,
    document_linked_by = null
  where id = v_payable.id;
  perform set_config('app.direct_payable_document_link', 'off', true);

  insert into public.audit_log (organization_id, actor_id, entity_type, entity_id, action, before_state, after_state)
  values (
    v_payable.organization_id, auth.uid(), 'direct_payable', v_payable.id, 'unlink_document',
    jsonb_build_object('received_document_id', v_payable.received_document_id, 'invoice_number', v_payable.invoice_number),
    jsonb_build_object('reason', btrim(p_reason))
  );
  return jsonb_build_object('direct_payable_id', v_payable.id, 'received_document_id', v_payable.received_document_id);
end;
$$;

revoke all on function private.link_direct_payable_document_internal(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.link_direct_payable_document(uuid, uuid, boolean) from public, anon;
grant execute on function public.link_direct_payable_document(uuid, uuid, boolean) to authenticated;
revoke all on function public.unlink_direct_payable_document(uuid, text) from public, anon;
grant execute on function public.unlink_direct_payable_document(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Registro de gasto con documento pendiente (Digitación y Finanzas)
-- ---------------------------------------------------------------------------
create or replace function public.create_pending_document_expense(
  p_organization_id uuid,
  p_supplier_counterparty_id uuid,
  p_cost_center_id uuid,
  p_category text,
  p_category_detail text,
  p_description text,
  p_total_amount numeric,
  p_issue_date date,
  p_due_date date,
  p_expected_document_type text,
  p_notes text default null,
  p_attachment_path text default null,
  p_attachment_name text default null,
  p_attachment_mime_type text default null,
  p_attachment_size bigint default null,
  p_duplicate_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_supplier record;
  v_payable_id uuid;
  v_payable_number text;
  v_notes text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role::text in ('administrator', 'finance', 'data_entry')
  ) then raise exception 'Expense entry access required'; end if;

  select counterparty.id, coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name) as name
    into v_supplier
  from public.counterparties counterparty
  where counterparty.id = p_supplier_counterparty_id
    and counterparty.organization_id = p_organization_id
    and counterparty.kind in ('supplier', 'both')
    and counterparty.is_active
    and counterparty.merged_into_counterparty_id is null;
  if v_supplier.id is null then raise exception 'Supplier not found'; end if;
  if not exists (
    select 1 from public.cost_centers cost_center
    where cost_center.id = p_cost_center_id and cost_center.organization_id = p_organization_id and cost_center.is_active
  ) then raise exception 'Cost center not found'; end if;
  if p_category is null or p_category not in ('utilities', 'rent', 'taxes', 'insurance', 'subscriptions', 'other')
    or (p_category = 'other' and (p_category_detail is null or length(btrim(p_category_detail)) not between 2 and 120))
    or p_description is null or length(btrim(p_description)) not between 1 and 2000
    or p_total_amount is null or p_total_amount <= 0 or p_total_amount > 1000000000000
    or p_issue_date is null
    or (p_due_date is not null and p_due_date < p_issue_date)
    or p_expected_document_type is null
    or p_expected_document_type not in ('Factura afecta', 'Factura exenta', 'Boleta de honorarios', 'Boleta', 'Otro')
    or (p_notes is not null and length(p_notes) > 2000)
    or (p_duplicate_reason is not null and length(btrim(p_duplicate_reason)) not between 3 and 500)
  then raise exception 'Invalid pending document expense'; end if;
  if p_attachment_path is not null and (
    p_attachment_path not like p_organization_id::text || '/pending-expenses/' || auth.uid()::text || '/%'
    or p_attachment_name is null or length(btrim(p_attachment_name)) not between 1 and 300
    or p_attachment_mime_type not in ('application/pdf', 'image/jpeg', 'image/png')
    or p_attachment_size is null or p_attachment_size not between 1 and 52428800
  ) then raise exception 'Invalid pending document expense attachment'; end if;

  -- Doble envío del formulario: mismo proveedor, monto y fecha en 10 minutos.
  if exists (
    select 1 from public.direct_payables payable
    where payable.organization_id = p_organization_id
      and payable.supplier_counterparty_id = v_supplier.id
      and payable.document_status = 'pending_document'
      and payable.status in ('draft', 'review', 'approved')
      and payable.total_amount = round(p_total_amount, 2)
      and payable.issue_date = p_issue_date
      and payable.created_at > now() - interval '10 minutes'
  ) then raise exception 'Duplicate pending document expense'; end if;

  v_payable_number := 'CXP-' || to_char(p_issue_date, 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_notes := nullif(concat_ws(E'\n',
    nullif(btrim(coalesce(p_notes, '')), ''),
    case when p_duplicate_reason is not null
      then 'Posible duplicado confirmado: ' || btrim(p_duplicate_reason) end
  ), '');

  insert into public.direct_payables (
    organization_id, payable_number, supplier_counterparty_id, supplier_name, category, category_detail,
    description, issue_date, due_date, currency_code, total_amount, status, notes, cost_center_id,
    document_status, expected_document_type, created_by
  ) values (
    p_organization_id, v_payable_number, v_supplier.id, v_supplier.name, p_category,
    case when p_category = 'other' then btrim(p_category_detail) end,
    btrim(p_description), p_issue_date, p_due_date, 'CLP', round(p_total_amount, 2), 'draft', v_notes, p_cost_center_id,
    'pending_document', p_expected_document_type, auth.uid()
  ) returning id into v_payable_id;

  if p_attachment_path is not null then
    insert into public.direct_payable_attachments (
      organization_id, direct_payable_id, storage_path, file_name, mime_type, file_size, uploaded_by
    ) values (
      p_organization_id, v_payable_id, p_attachment_path, btrim(p_attachment_name), p_attachment_mime_type, p_attachment_size, auth.uid()
    );
  end if;

  -- Mismo circuito que las cuentas de Finanzas: draft -> review crea la
  -- solicitud de aprobación (sync_procure_to_pay_approval_request).
  update public.direct_payables set status = 'review' where id = v_payable_id;

  if p_duplicate_reason is not null then
    insert into public.audit_log (organization_id, actor_id, entity_type, entity_id, action, before_state, after_state)
    values (p_organization_id, auth.uid(), 'direct_payable', v_payable_id, 'confirm_possible_duplicate', null,
      jsonb_build_object('reason', btrim(p_duplicate_reason)));
  end if;

  return jsonb_build_object('id', v_payable_id, 'payable_number', v_payable_number, 'status', 'review');
end;
$$;

revoke all on function public.create_pending_document_expense(uuid, uuid, uuid, text, text, text, numeric, date, date, text, text, text, text, text, bigint, text) from public, anon;
grant execute on function public.create_pending_document_expense(uuid, uuid, uuid, text, text, text, numeric, date, date, text, text, text, text, text, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Sugerencias de vinculación (requieren un clic de Finanzas)
-- ---------------------------------------------------------------------------
create or replace function public.suggest_pending_document_matches(p_organization_id uuid)
returns table (
  direct_payable_id uuid,
  payable_number text,
  received_document_id uuid,
  document_number text,
  document_type text,
  supplier_name text,
  issue_date date,
  total_amount numeric,
  amount_difference numeric,
  days_from_payable integer,
  match text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance', 'auditor')
  ) then raise exception 'Finance access required'; end if;

  return query
  with payables as (
    select payable.id, payable.payable_number, payable.supplier_counterparty_id, payable.issue_date,
      payable.total_amount, payable.document_status, payable.due_date,
      private.normalize_folio(payable.invoice_number) as folio,
      private.direct_payable_supplier_key(payable.supplier_counterparty_id, payable.supplier_name) as supplier_key
    from public.direct_payables payable
    where payable.organization_id = p_organization_id
      and payable.received_document_id is null
      and payable.status in ('draft', 'review', 'approved', 'paid')
      and not payable.is_reference
      and (payable.document_status = 'pending_document' or nullif(btrim(payable.invoice_number), '') is not null)
  ),
  documents as (
    select document.id, coalesce(nullif(btrim(document.document_number), ''), document.sii_folio::text) as number,
      document.document_type, document.supplier_name, document.supplier_counterparty_id,
      document.issue_date, document.total_amount,
      private.received_document_folio(document.sii_folio, document.document_number) as folio,
      private.received_document_supplier_key(document.supplier_tax_id, document.supplier_counterparty_id, document.supplier_name) as supplier_key
    from public.received_documents document
    where document.organization_id = p_organization_id
      and document.total_amount > 0
      and private.received_document_kind(document.document_type, document.sii_document_type) in ('invoice', 'other')
      and lower(coalesce(document.payment_status, '')) not similar to '%(pagada|abonada)%'
      and not exists (
        select 1 from public.direct_payables linked
        where linked.received_document_id = document.id and linked.status not in ('cancelled', 'rejected')
      )
      and not exists (select 1 from public.payment_executions execution where execution.received_document_id = document.id)
      and not exists (
        select 1 from public.payment_batch_items item
        join public.payment_batches batch on batch.id = item.payment_batch_id and batch.organization_id = item.organization_id
        where item.received_document_id = document.id
          and item.authorization_status = 'authorized'
          and batch.status in ('draft', 'review', 'approved', 'processing')
      )
  )
  select payables.id, payables.payable_number, documents.id, documents.number, documents.document_type,
    documents.supplier_name, documents.issue_date, documents.total_amount,
    round(documents.total_amount - payables.total_amount, 2),
    (documents.issue_date - payables.issue_date)::integer,
    case when payables.folio is not null and payables.folio = documents.folio then 'same_folio' else 'same_amount' end
  from payables
  join documents
    on (documents.supplier_key = payables.supplier_key
      or (documents.supplier_counterparty_id is not null and documents.supplier_counterparty_id = payables.supplier_counterparty_id))
  where (payables.folio is not null and payables.folio = documents.folio)
     or (payables.document_status = 'pending_document'
       and abs(documents.total_amount - payables.total_amount) <= 1
       and documents.issue_date between payables.issue_date - 30 and payables.issue_date + 60)
  order by payables.due_date nulls last, payables.id,
    (payables.folio is not null and payables.folio = documents.folio) desc,
    abs(documents.total_amount - payables.total_amount),
    abs(documents.issue_date - payables.issue_date);
end;
$$;

revoke all on function public.suggest_pending_document_matches(uuid) from public, anon;
grant execute on function public.suggest_pending_document_matches(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Duplicados entre cuentas directas y documentos recibidos
-- ---------------------------------------------------------------------------
create or replace function private.find_payable_duplicates_internal(
  p_organization_id uuid,
  p_supplier_counterparty_id uuid,
  p_supplier_tax_id text,
  p_supplier_name text,
  p_folio text,
  p_total numeric,
  p_issue_date date,
  p_exclude_received_id uuid,
  p_exclude_direct_id uuid
) returns table (
  source text, id uuid, number text, document_type text, supplier_name text,
  total_amount numeric, issue_date date, status text, match text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tax_id text := nullif(btrim(coalesce(p_supplier_tax_id, '')), '');
  v_key text;
  v_folio text := private.normalize_folio(p_folio);
begin
  if v_tax_id is null and p_supplier_counterparty_id is not null then
    select counterparty.tax_id into v_tax_id from public.counterparties counterparty
    where counterparty.id = p_supplier_counterparty_id and counterparty.organization_id = p_organization_id;
  end if;
  v_key := private.received_document_supplier_key(v_tax_id, p_supplier_counterparty_id, p_supplier_name);
  if v_key is null then return; end if;

  return query
  select * from (
    select 'received'::text,
      document.id,
      coalesce(nullif(btrim(document.document_number), ''), document.sii_folio::text),
      document.document_type,
      document.supplier_name,
      document.total_amount,
      document.issue_date,
      document.payment_status,
      case when v_folio is not null
        and private.received_document_folio(document.sii_folio, document.document_number) = v_folio
        and private.received_document_kind(document.document_type, document.sii_document_type) not in ('credit_note', 'dispatch_guide')
        then 'same_folio' else 'same_amount' end
    from public.received_documents document
    where document.organization_id = p_organization_id
      and document.id is distinct from p_exclude_received_id
      and (private.received_document_supplier_key(document.supplier_tax_id, document.supplier_counterparty_id, document.supplier_name) = v_key
        or (p_supplier_counterparty_id is not null and document.supplier_counterparty_id = p_supplier_counterparty_id))
      and (
        (v_folio is not null
          and private.received_document_folio(document.sii_folio, document.document_number) = v_folio
          and private.received_document_kind(document.document_type, document.sii_document_type) not in ('credit_note', 'dispatch_guide'))
        or (p_total is not null and p_issue_date is not null
          and abs(document.total_amount - p_total) < 1
          and document.issue_date between p_issue_date - 45 and p_issue_date + 45)
      )
      -- Un documento ya cubierto por una cuenta directa aparece por el lado
      -- de la cuenta (su folio pasa a ser el invoice_number de la cuenta).
      and not exists (
        select 1 from public.direct_payables linked
        where linked.received_document_id = document.id
          and linked.status not in ('cancelled', 'rejected')
      )
    union all
    select 'direct'::text,
      payable.id,
      coalesce(nullif(btrim(payable.invoice_number), ''), payable.payable_number),
      'Cuenta por pagar directa'::text,
      payable.supplier_name,
      payable.total_amount,
      payable.issue_date,
      payable.status,
      case when v_folio is not null and private.normalize_folio(payable.invoice_number) = v_folio
        then 'same_folio' else 'same_amount' end
    from public.direct_payables payable
    where payable.organization_id = p_organization_id
      and payable.id is distinct from p_exclude_direct_id
      and payable.status not in ('cancelled', 'rejected')
      and not payable.is_reference
      and (p_exclude_received_id is null or payable.received_document_id is distinct from p_exclude_received_id)
      and (private.direct_payable_supplier_key(payable.supplier_counterparty_id, payable.supplier_name) = v_key
        or (p_supplier_counterparty_id is not null and payable.supplier_counterparty_id = p_supplier_counterparty_id))
      and (
        (v_folio is not null and private.normalize_folio(payable.invoice_number) = v_folio)
        or (p_total is not null and p_issue_date is not null
          and abs(payable.total_amount - p_total) < 1
          and payable.issue_date between p_issue_date - 45 and p_issue_date + 45)
      )
  ) matches (source, id, number, document_type, supplier_name, total_amount, issue_date, status, match)
  order by (matches.match = 'same_folio') desc, abs(matches.total_amount - coalesce(p_total, matches.total_amount)), matches.issue_date desc
  limit 20;
end;
$$;

create or replace function public.find_payable_duplicates(
  p_organization_id uuid,
  p_supplier_counterparty_id uuid,
  p_supplier_tax_id text,
  p_supplier_name text,
  p_folio text,
  p_total numeric,
  p_issue_date date,
  p_exclude_received_id uuid default null,
  p_exclude_direct_id uuid default null
) returns table (
  source text, id uuid, number text, document_type text, supplier_name text,
  total_amount numeric, issue_date date, status text, match text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role::text in ('administrator', 'finance', 'auditor', 'data_entry')
  ) then raise exception 'Organization access required'; end if;
  return query select * from private.find_payable_duplicates_internal(
    p_organization_id, p_supplier_counterparty_id, p_supplier_tax_id, p_supplier_name,
    p_folio, p_total, p_issue_date, p_exclude_received_id, p_exclude_direct_id
  );
end;
$$;

revoke all on function private.find_payable_duplicates_internal(uuid, uuid, text, text, text, numeric, date, uuid, uuid) from public, anon, authenticated;
revoke all on function public.find_payable_duplicates(uuid, uuid, text, text, text, numeric, date, uuid, uuid) from public, anon;
grant execute on function public.find_payable_duplicates(uuid, uuid, text, text, text, numeric, date, uuid, uuid) to authenticated;

-- Bloqueo duro por folio en cuentas directas. El mensaje
-- 'duplicate_payable_folio' y el detalle JSON los traducen las API a un
-- error claro ("Ya existe la factura N° X de este proveedor …").
create or replace function private.guard_direct_payable_document_identity()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_folio text;
  v_key text;
  v_match record;
begin
  if tg_op = 'INSERT'
    and (new.received_document_id is not null or new.document_status = 'documented') then
    raise exception 'Direct payable documents can only change through link_direct_payable_document';
  end if;
  if new.status in ('cancelled', 'rejected') or new.is_reference then return new; end if;
  v_folio := private.normalize_folio(new.invoice_number);
  if v_folio is null then return new; end if;
  -- Sólo un folio nuevo o corregido se valida: correcciones de proveedor o
  -- fusiones de fichas (merge_counterparties) no deben fallar por duplicados
  -- históricos que Finanzas depura aparte.
  if tg_op = 'UPDATE' and private.normalize_folio(old.invoice_number) is not distinct from v_folio then
    return new;
  end if;
  v_key := private.direct_payable_supplier_key(new.supplier_counterparty_id, new.supplier_name);

  select 'received' as source, document.id,
    coalesce(nullif(btrim(document.document_number), ''), document.sii_folio::text) as number,
    document.document_type as label
    into v_match
  from public.received_documents document
  where document.organization_id = new.organization_id
    and document.id is distinct from new.received_document_id
    and private.received_document_folio(document.sii_folio, document.document_number) = v_folio
    and private.received_document_kind(document.document_type, document.sii_document_type) not in ('credit_note', 'dispatch_guide')
    and (private.received_document_supplier_key(document.supplier_tax_id, document.supplier_counterparty_id, document.supplier_name) = v_key
      or (new.supplier_counterparty_id is not null and document.supplier_counterparty_id = new.supplier_counterparty_id))
  limit 1;
  if v_match.id is null then
    select 'direct' as source, payable.id,
      coalesce(nullif(btrim(payable.invoice_number), ''), payable.payable_number) as number,
      payable.payable_number as label
      into v_match
    from public.direct_payables payable
    where payable.organization_id = new.organization_id
      and payable.id <> new.id
      and payable.status not in ('cancelled', 'rejected')
      and not payable.is_reference
      and private.normalize_folio(payable.invoice_number) = v_folio
      and (private.direct_payable_supplier_key(payable.supplier_counterparty_id, payable.supplier_name) = v_key
        or (new.supplier_counterparty_id is not null and payable.supplier_counterparty_id = new.supplier_counterparty_id))
    limit 1;
  end if;
  if v_match.id is not null then
    raise exception using
      message = 'duplicate_payable_folio',
      detail = jsonb_build_object('source', v_match.source, 'id', v_match.id, 'number', v_match.number, 'label', v_match.label)::text,
      hint = 'Vincula el documento existente en lugar de registrarlo otra vez.';
  end if;
  return new;
end;
$$;

create trigger direct_payables_guard_document_identity
before insert or update of invoice_number on public.direct_payables
for each row execute function private.guard_direct_payable_document_identity();

-- Bloqueo en documentos recibidos ingresados a mano. Los DTE oficiales del
-- SII (sii_document_type informado) nunca se bloquean: se vinculan solos si
-- calzan con una cuenta pendiente o quedan como sugerencia/duplicado a revisar.
create or replace function private.guard_received_document_payable_identity()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_folio text;
  v_key text;
  v_match record;
begin
  if private.received_document_kind(new.document_type, new.sii_document_type) in ('credit_note', 'dispatch_guide') then
    return new;
  end if;
  v_folio := private.received_document_folio(new.sii_folio, new.document_number);
  if v_folio is null or new.sii_document_type is not null then return new; end if;
  v_key := private.received_document_supplier_key(new.supplier_tax_id, new.supplier_counterparty_id, new.supplier_name);

  select payable.id, payable.payable_number,
    coalesce(nullif(btrim(payable.invoice_number), ''), payable.payable_number) as number
    into v_match
  from public.direct_payables payable
  where payable.organization_id = new.organization_id
    and payable.status not in ('cancelled', 'rejected')
    and not payable.is_reference
    and private.normalize_folio(payable.invoice_number) = v_folio
    and (private.direct_payable_supplier_key(payable.supplier_counterparty_id, payable.supplier_name) = v_key
      or (new.supplier_counterparty_id is not null and payable.supplier_counterparty_id = new.supplier_counterparty_id))
    -- Una cuenta pendiente del mismo monto se vincula en el AFTER INSERT.
    and not (
      payable.document_status = 'pending_document'
      and payable.received_document_id is null
      and abs(payable.total_amount - new.total_amount) <= 1
    )
  limit 1;
  if v_match.id is not null then
    raise exception using
      message = 'duplicate_payable_folio',
      detail = jsonb_build_object('source', 'direct', 'id', v_match.id, 'number', v_match.number, 'label', v_match.payable_number)::text,
      hint = 'La factura ya está registrada como cuenta por pagar directa.';
  end if;
  return new;
end;
$$;

create trigger received_documents_guard_payable_identity
before insert on public.received_documents
for each row execute function private.guard_received_document_payable_identity();

-- Vinculación automática: misma factura (proveedor + folio) y mismo monto que
-- una única cuenta con documento pendiente. Un fallo nunca impide registrar
-- el documento (por ejemplo, la importación del SII).
create or replace function private.auto_link_received_document_to_pending_payable()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_folio text;
  v_key text;
  v_payable_ids uuid[];
begin
  if private.received_document_kind(new.document_type, new.sii_document_type) not in ('invoice', 'other') then
    return null;
  end if;
  v_folio := private.received_document_folio(new.sii_folio, new.document_number);
  if v_folio is null then return null; end if;
  v_key := private.received_document_supplier_key(new.supplier_tax_id, new.supplier_counterparty_id, new.supplier_name);

  select array_agg(payable.id) into v_payable_ids
  from public.direct_payables payable
  where payable.organization_id = new.organization_id
    and payable.document_status = 'pending_document'
    and payable.received_document_id is null
    and payable.status in ('draft', 'review', 'approved', 'paid')
    and not payable.is_reference
    and private.normalize_folio(payable.invoice_number) = v_folio
    and abs(payable.total_amount - new.total_amount) <= 1
    and (private.direct_payable_supplier_key(payable.supplier_counterparty_id, payable.supplier_name) = v_key
      or (new.supplier_counterparty_id is not null and payable.supplier_counterparty_id = new.supplier_counterparty_id));

  if coalesce(cardinality(v_payable_ids), 0) = 1 then
    begin
      perform private.link_direct_payable_document_internal(v_payable_ids[1], new.id, false, 'auto_folio');
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;

create trigger received_documents_auto_link_pending_payable
after insert on public.received_documents
for each row execute function private.auto_link_received_document_to_pending_payable();

revoke all on function private.guard_direct_payable_document_identity() from public, anon, authenticated;
revoke all on function private.guard_received_document_payable_identity() from public, anon, authenticated;
revoke all on function private.auto_link_received_document_to_pending_payable() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Sincronización de snapshots de propuestas al corregir folio/proveedor.
--
-- /api/direct-payable-attachments PATCH actualizaba payment_batch_items
-- directamente, pero UPDATE sobre esa tabla fue revocado a authenticated en
-- 20260812013000: la corrección quedaba a medias (cuenta actualizada, ítems
-- no) y la API respondía 409. Esta RPC hace el ajuste en base.
-- ---------------------------------------------------------------------------
create or replace function public.sync_direct_payable_payment_snapshots(
  p_organization_id uuid,
  p_direct_payable_id uuid
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_payable public.direct_payables%rowtype;
  v_updated integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance')
  ) then raise exception 'Finance access required'; end if;
  select * into v_payable from public.direct_payables
  where id = p_direct_payable_id and organization_id = p_organization_id;
  if not found then raise exception 'Direct payable not found'; end if;

  perform set_config('app.payment_item_rpc', 'on', true);
  update public.payment_batch_items item set
    supplier_name_snapshot = v_payable.supplier_name,
    document_number_snapshot = coalesce(v_payable.invoice_number, v_payable.payable_number)
  from public.payment_batches batch
  where batch.id = item.payment_batch_id
    and batch.organization_id = item.organization_id
    and item.organization_id = p_organization_id
    and item.direct_payable_id = p_direct_payable_id
    and item.authorization_status = 'authorized'
    and batch.status in ('draft', 'review')
    and (item.supplier_name_snapshot is distinct from v_payable.supplier_name
      or item.document_number_snapshot is distinct from coalesce(v_payable.invoice_number, v_payable.payable_number));
  get diagnostics v_updated = row_count;
  perform set_config('app.payment_item_rpc', 'off', true);
  return v_updated;
end;
$$;

revoke all on function public.sync_direct_payable_payment_snapshots(uuid, uuid) from public, anon;
grant execute on function public.sync_direct_payable_payment_snapshots(uuid, uuid) to authenticated;
