-- Las cuentas directas no tienen received_document_id. La validación anterior
-- aplicaba por error el flujo de facturas recibidas a ambos tipos de ítem y
-- hacía imposible crear una propuesta con una CxP directa.
create or replace function public.validate_payment_batch_document_assignment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_row public.received_documents%rowtype;
  payable_row public.direct_payables%rowtype;
begin
  if new.direct_payable_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || new.direct_payable_id::text, 0));

    select * into payable_row
    from public.direct_payables
    where id = new.direct_payable_id
      and organization_id = new.organization_id
    for key share;

    if not found or coalesce(payable_row.total_amount, 0) <= 0 then
      raise exception 'Direct payable is not available for payment';
    end if;
    if payable_row.status <> 'approved' or payable_row.is_reference then
      raise exception 'Only approved direct payables can be added to a payment batch';
    end if;
    if new.amount > payable_row.total_amount then
      raise exception 'Payment batch amount exceeds direct payable total';
    end if;
    if new.supplier_name_snapshot is distinct from payable_row.supplier_name
       or new.document_number_snapshot is distinct from coalesce(payable_row.invoice_number, payable_row.payable_number)
       or new.due_date_snapshot is distinct from payable_row.due_date then
      raise exception 'Payment batch snapshots must match the direct payable at assignment time';
    end if;
    if exists (
      select 1
      from public.payment_batch_items item
      join public.payment_batches batch on batch.id = item.payment_batch_id
        and batch.organization_id = item.organization_id
      where item.organization_id = new.organization_id
        and item.direct_payable_id = new.direct_payable_id
        and batch.status in ('draft', 'review', 'approved', 'processing')
        and (tg_op <> 'UPDATE' or item.id <> old.id)
    ) then
      raise exception 'Direct payable already belongs to an active payment batch';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || new.received_document_id::text, 0));

  select * into document_row
  from public.received_documents
  where id = new.received_document_id
    and organization_id = new.organization_id
  for key share;

  if not found or coalesce(document_row.total_amount, 0) <= 0 then
    raise exception 'Received document is not available for payment';
  end if;
  if lower(coalesce(document_row.payment_status, '')) like '%pagada%' then
    raise exception 'Paid received document cannot be added to a payment batch';
  end if;
  if document_row.purchase_match_status not in ('matched', 'exception', 'not_required') then
    raise exception 'Received document requires purchase match or approved exception before payment';
  end if;
  if document_row.purchase_match_status = 'exception'
     and (document_row.purchase_match_approved_at is null or document_row.purchase_match_approved_by is null) then
    raise exception 'Purchase match exception is not approved';
  end if;
  if new.amount > document_row.total_amount then
    raise exception 'Payment batch amount exceeds received document total';
  end if;
  if new.supplier_name_snapshot is distinct from document_row.supplier_name
     or new.document_number_snapshot is distinct from document_row.document_number
     or new.due_date_snapshot is distinct from document_row.due_date then
    raise exception 'Payment batch snapshots must match the received document at assignment time';
  end if;
  if exists (
    select 1
    from public.payment_batch_items item
    join public.payment_batches batch on batch.id = item.payment_batch_id
      and batch.organization_id = item.organization_id
    where item.organization_id = new.organization_id
      and item.received_document_id = new.received_document_id
      and batch.status in ('draft', 'review', 'approved', 'processing')
      and (tg_op <> 'UPDATE' or item.id <> old.id)
  ) then
    raise exception 'Received document already belongs to an active payment batch';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_payment_batch_document_assignment() from public, anon, authenticated;
