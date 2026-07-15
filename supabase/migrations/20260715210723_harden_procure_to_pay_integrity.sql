-- Integridad del flujo procure-to-pay.  Las facturas históricas no se
-- invalidan: quedan explícitamente marcadas como "not_required"; los nuevos
-- documentos entran a revisión y no pueden pagarse sin match o excepción.

alter table public.received_documents
  add column purchase_match_status text not null default 'pending'
    check (purchase_match_status in ('pending', 'matched', 'exception', 'rejected', 'not_required')),
  add column purchase_match_note text,
  add column purchase_match_checked_at timestamptz,
  add column purchase_match_checked_by uuid references auth.users(id) on delete set null,
  add column purchase_match_approved_at timestamptz,
  add column purchase_match_approved_by uuid references auth.users(id) on delete set null;

alter table public.vendor_purchase_orders
  add column receipt_confirmed_at timestamptz,
  add column receipt_confirmed_by uuid references auth.users(id) on delete set null,
  add column receipt_conformity_note text;

-- Los documentos ya cargados no estaban sometidos al nuevo control. Se dejan
-- utilizables, pero su condición queda visible y trazable para regularización.
update public.received_documents
set purchase_match_status = 'not_required',
    purchase_match_note = 'Documento heredado previo al control P2P.',
    purchase_match_checked_at = created_at
where purchase_match_status = 'pending'
  and vendor_purchase_order_id is null;

create index received_documents_purchase_match_queue_idx
  on public.received_documents (organization_id, purchase_match_status, due_date, issue_date desc)
  where purchase_match_status in ('pending', 'exception');

-- Al conformar una OC se registra quién y cuándo, sin alterar el flujo actual
-- (la transición a "received" sigue siendo la fuente de verdad operativa).
create or replace function public.capture_vendor_purchase_order_conformity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status is distinct from new.status
     and new.status in ('partially_received', 'received') then
    new.receipt_confirmed_at := coalesce(new.receipt_confirmed_at, now());
    new.receipt_confirmed_by := coalesce(new.receipt_confirmed_by, (select auth.uid()));
  end if;
  return new;
end;
$$;

create trigger vendor_purchase_orders_capture_conformity
before update of status on public.vendor_purchase_orders
for each row execute function public.capture_vendor_purchase_order_conformity();

-- Un match "matched" sólo es posible contra una OC del mismo proveedor y sin
-- sobrepasar su neto autorizado. Las diferencias se conservan como excepción
-- con fundamento y aprobación explícita, en lugar de esconderse en el pago.
create or replace function public.validate_received_document_purchase_match()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  order_row public.vendor_purchase_orders%rowtype;
  previously_matched numeric(18, 2);
  normalized_document_supplier text;
  normalized_order_supplier text;
begin
  if new.vendor_purchase_order_id is null then
    if new.purchase_match_status = 'matched' then
      raise exception 'A matched received document requires a purchase order';
    end if;
    if new.purchase_match_status = 'not_required'
       and nullif(btrim(coalesce(new.purchase_match_note, '')), '') is null then
      raise exception 'A not_required purchase match requires a reason';
    end if;
  else
    select * into order_row
    from public.vendor_purchase_orders
    where id = new.vendor_purchase_order_id
      and organization_id = new.organization_id
    for key share;

    if not found then
      raise exception 'Purchase order is not available in this organization';
    end if;

    if new.purchase_match_status = 'not_required' then
      raise exception 'A document linked to a purchase order cannot be not_required';
    end if;

    if new.purchase_match_status = 'matched' then
      if order_row.status not in ('partially_received', 'received') then
        raise exception 'Purchase order must be received before an invoice can be matched';
      end if;

      if order_row.supplier_counterparty_id is not null
         and new.supplier_counterparty_id is not null
         and order_row.supplier_counterparty_id <> new.supplier_counterparty_id then
        raise exception 'Invoice supplier does not match purchase order supplier';
      end if;

      if nullif(btrim(coalesce(order_row.supplier_tax_id, '')), '') is not null
         and nullif(btrim(coalesce(new.supplier_tax_id, '')), '') is not null
         and upper(regexp_replace(order_row.supplier_tax_id, '[^0-9kK]', '', 'g'))
             <> upper(regexp_replace(new.supplier_tax_id, '[^0-9kK]', '', 'g')) then
        raise exception 'Invoice tax id does not match purchase order supplier';
      end if;

      normalized_document_supplier := lower(regexp_replace(btrim(new.supplier_name), '\s+', ' ', 'g'));
      normalized_order_supplier := lower(regexp_replace(btrim(order_row.supplier_name), '\s+', ' ', 'g'));
      if normalized_document_supplier <> normalized_order_supplier
         and (order_row.supplier_counterparty_id is null or new.supplier_counterparty_id is null)
         and (nullif(btrim(coalesce(order_row.supplier_tax_id, '')), '') is null
              or nullif(btrim(coalesce(new.supplier_tax_id, '')), '') is null) then
        raise exception 'Invoice supplier name does not match purchase order supplier';
      end if;

      select coalesce(sum(document.net_amount), 0) into previously_matched
      from public.received_documents document
      where document.organization_id = new.organization_id
        and document.vendor_purchase_order_id = new.vendor_purchase_order_id
        and document.purchase_match_status in ('matched', 'exception')
        and (tg_op <> 'UPDATE' or document.id <> old.id);

      if previously_matched + new.net_amount > order_row.net_amount + 0.01 then
        raise exception 'Invoice net amount exceeds the remaining purchase order amount; record an approved exception instead';
      end if;
    end if;
  end if;

  if new.purchase_match_status = 'exception' then
    if nullif(btrim(coalesce(new.purchase_match_note, '')), '') is null
       or new.purchase_match_approved_at is null
       or new.purchase_match_approved_by is null then
      raise exception 'A purchase match exception requires note, approver and approval timestamp';
    end if;
  elsif new.purchase_match_status in ('matched', 'rejected', 'not_required') then
    new.purchase_match_checked_at := coalesce(new.purchase_match_checked_at, now());
    new.purchase_match_checked_by := coalesce(new.purchase_match_checked_by, (select auth.uid()));
  end if;

  return new;
end;
$$;

create trigger received_documents_validate_purchase_match
before insert or update of vendor_purchase_order_id, supplier_counterparty_id, supplier_name,
  supplier_tax_id, net_amount, purchase_match_status, purchase_match_note,
  purchase_match_approved_at, purchase_match_approved_by
on public.received_documents
for each row execute function public.validate_received_document_purchase_match();

-- Un documento sólo puede vivir en un lote activo a la vez. El advisory lock
-- hace que la validación sea segura ante dos intentos concurrentes de pago.
create or replace function public.validate_payment_batch_document_assignment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_row public.received_documents%rowtype;
begin
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

create trigger payment_batch_items_validate_document_assignment
before insert or update of received_document_id, amount, supplier_name_snapshot,
  document_number_snapshot, due_date_snapshot
on public.payment_batch_items
for each row execute function public.validate_payment_batch_document_assignment();

revoke all on function public.capture_vendor_purchase_order_conformity() from public, anon, authenticated;
revoke all on function public.validate_received_document_purchase_match() from public, anon, authenticated;
revoke all on function public.validate_payment_batch_document_assignment() from public, anon, authenticated;
