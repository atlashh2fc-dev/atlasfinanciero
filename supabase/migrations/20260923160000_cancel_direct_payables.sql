-- Anulación de cuentas por pagar directas (duplicadas, provisorias o mal
-- registradas). Es una baja lógica: la fila queda con motivo y autor en la
-- bitácora. En la misma transacción se cierra la aprobación pendiente y se
-- liberan los pagos aún no ejecutados en propuestas activas. Una cuenta con
-- pagos ejecutados o conciliados no se puede anular.
create or replace function public.cancel_direct_payable(
  p_organization_id uuid,
  p_direct_payable_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_item_ids uuid[];
  v_cancelled_items jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.role in ('administrator', 'finance')
  ) then raise exception 'Finance access required'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'Cancellation reason is required';
  end if;

  select status into v_status from public.direct_payables
  where id = p_direct_payable_id and organization_id = p_organization_id
  for update;
  if v_status is null then raise exception 'Direct payable not found'; end if;
  if v_status not in ('draft', 'review', 'approved', 'rejected') then
    raise exception 'Only unpaid direct payables can be cancelled';
  end if;
  if exists (select 1 from public.payment_executions e where e.direct_payable_id = p_direct_payable_id)
    or exists (select 1 from public.bank_reconciliation_matches r where r.direct_payable_id = p_direct_payable_id)
  then raise exception 'Direct payable has recorded payments'; end if;

  select array_agg(i.id) into v_item_ids
  from public.payment_batch_items i
  join public.payment_batches b on b.id = i.payment_batch_id
  where i.organization_id = p_organization_id
    and i.direct_payable_id = p_direct_payable_id
    and i.authorization_status = 'authorized'
    and b.status in ('draft', 'review', 'approved', 'processing');
  if v_item_ids is not null then
    v_cancelled_items := private.cancel_payment_batch_items_internal(
      p_organization_id, v_item_ids, 'Cuenta anulada: ' || btrim(p_reason));
  end if;

  update public.approval_steps s set status = 'skipped'
  from public.approval_requests r
  where s.approval_request_id = r.id
    and r.organization_id = p_organization_id
    and r.target_type = 'payment'
    and r.target_id = p_direct_payable_id
    and r.status = 'submitted'
    and s.status = 'pending';
  update public.approval_requests set status = 'cancelled'
  where organization_id = p_organization_id
    and target_type = 'payment'
    and target_id = p_direct_payable_id
    and status = 'submitted';

  update public.direct_payables
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancellation_reason = btrim(p_reason)
  where id = p_direct_payable_id and organization_id = p_organization_id;

  return jsonb_build_object(
    'direct_payable_id', p_direct_payable_id,
    'previous_status', v_status,
    'cancelled_payment_items', coalesce(v_cancelled_items, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.cancel_direct_payable(uuid, uuid, text) from public, anon;
grant execute on function public.cancel_direct_payable(uuid, uuid, text) to authenticated;
