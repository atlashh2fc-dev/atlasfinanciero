-- Recepción necesita preparar propuestas de pago y registrar transferencias
-- sin recibir el perfil de Finanzas. Las capacidades quedan separadas del rol
-- (igual que can_create_suppliers): enviar a aprobación, aprobar, reprogramar
-- y cancelar pagos sigue reservado a Administración y Finanzas.
alter table public.organization_memberships
  add column if not exists can_create_payment_proposals boolean not null default false,
  add column if not exists can_record_payment_transfers boolean not null default false;

comment on column public.organization_memberships.can_create_payment_proposals is
  'Permite a digitación preparar propuestas de pago en borrador sin enviarlas ni aprobarlas.';
comment on column public.organization_memberships.can_record_payment_transfers is
  'Permite a digitación registrar transferencias y comprobantes de propuestas ya aprobadas.';

update public.organization_memberships membership
set can_create_payment_proposals = true,
    can_record_payment_transfers = true
from public.profiles profile
where profile.id = membership.user_id
  and membership.role::text = 'data_entry'
  and lower(profile.email) = 'recepcion@geimser.cl';

create or replace function private.has_payment_capability(
  p_organization_id uuid,
  p_capability text
) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
      and case p_capability
        when 'create_proposals' then membership.can_create_payment_proposals
        when 'record_transfers' then membership.can_record_payment_transfers
        when 'any' then membership.can_create_payment_proposals
          or membership.can_record_payment_transfers
        else false
      end
  );
$$;

revoke all on function private.has_payment_capability(uuid, text) from public, anon;
grant execute on function private.has_payment_capability(uuid, text) to authenticated;

-- Lectura necesaria para elegir cuentas por pagar y revisar propuestas.
create policy "payment operators read payment batches"
on public.payment_batches for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read payment batch items"
on public.payment_batch_items for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read payment item proofs"
on public.payment_batch_item_proofs for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read payment executions"
on public.payment_executions for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read received documents"
on public.received_documents for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read direct payables"
on public.direct_payables for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read bank accounts"
on public.bank_accounts for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read payment schedule alerts"
on public.payment_schedule_alerts for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

create policy "payment operators read payment reschedules"
on public.payment_reschedule_events for select to authenticated
using ((select private.has_payment_capability(organization_id, 'any')));

-- Creación acotada a borradores propios; el envío a aprobación (draft→review)
-- queda fuera porque no hay política de update para este perfil.
create policy "payment operators create draft payment batches"
on public.payment_batches for insert to authenticated
with check (
  (select private.has_payment_capability(organization_id, 'create_proposals'))
  and status = 'draft'
  and created_by = (select auth.uid())
);

-- La API elimina el borrador si fallan sus líneas.
create policy "payment operators delete own draft payment batches"
on public.payment_batches for delete to authenticated
using (
  (select private.has_payment_capability(organization_id, 'create_proposals'))
  and status = 'draft'
  and created_by = (select auth.uid())
);

create policy "payment operators add items to own draft batches"
on public.payment_batch_items for insert to authenticated
with check (
  (select private.has_payment_capability(organization_id, 'create_proposals'))
  and exists (
    select 1
    from public.payment_batches batch
    where batch.id = payment_batch_items.payment_batch_id
      and batch.organization_id = payment_batch_items.organization_id
      and batch.status = 'draft'
      and batch.created_by = (select auth.uid())
  )
);

-- Marcar documentos directos como "sin OC requerida" pasa por RPC para no
-- abrir un update general sobre received_documents.
create or replace function private.mark_direct_payment_documents_internal(
  p_organization_id uuid,
  p_document_ids uuid[]
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  updated_count integer;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and (
        membership.role in ('administrator', 'finance')
        or (membership.role::text = 'data_entry' and membership.can_create_payment_proposals)
      )
  ) then
    raise exception 'Payment proposal access required';
  end if;
  if p_document_ids is null or cardinality(p_document_ids) not between 1 and 250 then
    raise exception 'Invalid payment documents';
  end if;

  update public.received_documents
  set purchase_match_status = 'not_required',
      purchase_match_note = 'Documento directo sin orden de compra asociada.',
      purchase_match_checked_at = now(),
      purchase_match_checked_by = auth.uid()
  where organization_id = p_organization_id
    and id = any(p_document_ids)
    and vendor_purchase_order_id is null;
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

create or replace function public.mark_direct_payment_documents(
  p_organization_id uuid,
  p_document_ids uuid[]
) returns integer
language sql security invoker set search_path = '' as $$
  select private.mark_direct_payment_documents_internal($1, $2);
$$;

revoke all on function private.mark_direct_payment_documents_internal(uuid, uuid[]) from public, anon;
grant execute on function private.mark_direct_payment_documents_internal(uuid, uuid[]) to authenticated;
revoke all on function public.mark_direct_payment_documents(uuid, uuid[]) from public, anon;
grant execute on function public.mark_direct_payment_documents(uuid, uuid[]) to authenticated;

-- Comprobantes: lectura para revisar propuestas y carga sólo bajo
-- payment-batches/. No se habilita delete para preservar la evidencia.
create policy "payment operators read direct payable objects"
on storage.objects for select to authenticated
using (
  bucket_id = 'direct-payable-files'
  and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id::text = split_part(objects.name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
      and (membership.can_create_payment_proposals or membership.can_record_payment_transfers)
  )
);

create policy "payment operators upload payment proofs"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'direct-payable-files'
  and split_part(objects.name, '/', 2) = 'payment-batches'
  and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id::text = split_part(objects.name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role::text = 'data_entry'
      and membership.can_record_payment_transfers
  )
);

-- Registro de transferencias: misma RPC, ampliando sólo el control de acceso.
create or replace function private.record_payment_batch_item_execution_internal(
  p_organization_id uuid, p_payment_batch_item_id uuid, p_amount numeric,
  p_paid_on date, p_payment_reference text, p_storage_path text,
  p_file_name text, p_mime_type text, p_file_size bigint, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare item record; execution_id uuid; proof_id uuid; paid_sum numeric(18,2); remaining numeric(18,2); all_done boolean;
begin
  if auth.uid() is null or not exists (select 1 from public.organization_memberships m
    where m.organization_id=p_organization_id and m.user_id=auth.uid() and (m.role in ('administrator','finance') or (m.role::text='data_entry' and m.can_record_payment_transfers))) then
    raise exception 'Finance access required';
  end if;
  if p_amount is null or p_amount<=0 or p_paid_on is null or p_idempotency_key is null
    or p_storage_path is null or length(btrim(p_storage_path))<1
    or p_file_name is null or length(btrim(p_file_name)) not between 1 and 300
    or p_mime_type not in ('application/pdf','image/jpeg','image/png')
    or p_file_size not between 1 and 52428800
    or (p_payment_reference is not null and length(btrim(p_payment_reference)) not between 1 and 180) then
    raise exception 'Invalid payment item execution';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':item:'||p_payment_batch_item_id::text,0));
  select i.*,b.status as batch_status,b.batch_number into item
  from public.payment_batch_items i join public.payment_batches b on b.id=i.payment_batch_id and b.organization_id=i.organization_id
  where i.id=p_payment_batch_item_id and i.organization_id=p_organization_id for update of i,b;
  if item.id is null or item.authorization_status<>'authorized' or item.batch_status not in ('approved','processing','paid') then
    raise exception 'Payment item is not authorized for execution';
  end if;
  select id into execution_id from public.payment_executions
    where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if execution_id is not null then
    return jsonb_build_object('execution_id',execution_id,'idempotent',true);
  end if;
  select coalesce(sum(amount),0) into paid_sum from public.payment_executions
    where organization_id=p_organization_id and payment_batch_item_id=item.id;
  remaining:=item.authorized_amount-paid_sum;
  if p_amount>remaining+0.01 then raise exception 'Payment amount exceeds item outstanding balance'; end if;
  if item.batch_status='approved' then
    -- El cambio de estado y el espejo legacy ocurren juntos porque las
    -- cabeceras aprobadas son inmutables fuera de una transición válida.
    update public.payment_batches set status='processing',processed_at=coalesce(processed_at,now()),
      payment_proof_path=coalesce(payment_proof_path,p_storage_path),
      payment_proof_name=coalesce(payment_proof_name,p_file_name),
      payment_proof_mime_type=coalesce(payment_proof_mime_type,p_mime_type),
      payment_proof_size=coalesce(payment_proof_size,p_file_size)
      where id=item.payment_batch_id and organization_id=p_organization_id;
  end if;
  insert into public.payment_executions(organization_id,direction,source,status,received_document_id,direct_payable_id,
    payment_batch_id,payment_batch_item_id,amount,executed_on,payment_method,payment_reference,notes,created_by,
    cash_flow_classification,idempotency_key,proof_path,proof_name,proof_mime_type,proof_size)
  values(p_organization_id,'outflow','payment_batch','executed',item.received_document_id,item.direct_payable_id,
    item.payment_batch_id,item.id,p_amount,p_paid_on,'Orden de pago',nullif(btrim(p_payment_reference),''),
    concat('Abono ejecutado por propuesta ',item.batch_number),auth.uid(),item.cash_flow_category,p_idempotency_key,
    p_storage_path,p_file_name,p_mime_type,p_file_size) returning id into execution_id;
  insert into public.payment_batch_item_proofs(organization_id,payment_batch_id,payment_batch_item_id,payment_execution_id,
    paid_on,amount,payment_reference,storage_path,file_name,mime_type,file_size,created_by)
  values(p_organization_id,item.payment_batch_id,item.id,execution_id,p_paid_on,p_amount,nullif(btrim(p_payment_reference),''),
    p_storage_path,p_file_name,p_mime_type,p_file_size,auth.uid()) returning id into proof_id;
  select not exists (
    select 1 from public.payment_batch_items i
    where i.payment_batch_id=item.payment_batch_id and i.authorization_status='authorized'
      and coalesce((select sum(e.amount) from public.payment_executions e where e.payment_batch_item_id=i.id),0) < i.authorized_amount-0.01
  ) into all_done;
  if all_done then
    update public.payment_batches set status='paid',paid_at=coalesce(paid_at,p_paid_on::timestamptz),
      payment_reference=coalesce(payment_reference,nullif(btrim(p_payment_reference),'')),
      payment_proof_path=coalesce(payment_proof_path,p_storage_path),
      payment_proof_name=coalesce(payment_proof_name,p_file_name),
      payment_proof_mime_type=coalesce(payment_proof_mime_type,p_mime_type),
      payment_proof_size=coalesce(payment_proof_size,p_file_size)
    where id=item.payment_batch_id and organization_id=p_organization_id;
  end if;
  return jsonb_build_object('execution_id',execution_id,'proof_id',proof_id,'payment_batch_item_id',item.id,
    'executed_amount',p_amount,'remaining_amount',greatest(0,remaining-p_amount),'batch_paid',all_done,'idempotent',false);
end;
$$;
