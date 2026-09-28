-- Reprogramación del saldo de pagos abonados.
--
-- Un abono deja la propuesta en processing y hasta ahora su saldo quedaba
-- amarrado a esa fecha: no se podía mover ni volver a proponer. Desde aquí el
-- ítem abonado conserva sus ejecuciones y comprobantes, su autorización se
-- reduce a lo ejecutado y el saldo pasa a un ítem nuevo, con la misma
-- aprobación, en el viernes elegido. Un ítem totalmente ejecutado deja de
-- reservar su documento.

create or replace function public.validate_payment_batch_document_assignment()
returns trigger language plpgsql set search_path='' as $$
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
        and coalesce((select sum(e.amount) from public.payment_executions e where e.payment_batch_item_id=item.id),0)
          < item.authorized_amount-0.01
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
      and coalesce((select sum(e.amount) from public.payment_executions e where e.payment_batch_item_id=item.id),0)
        < item.authorized_amount-0.01
      and (tg_op<>'UPDATE' or item.id<>old.id)) then
    raise exception 'Received document already belongs to an active payment batch';
  end if;
  return new;
end;
$$;

-- Ítems sin ejecución se mueven completos, como antes. Los abonados se
-- dividen: el original queda autorizado por lo ejecutado y el saldo se
-- autoriza en el viernes destino. Una propuesta en processing entrega su
-- saldo a una propuesta aprobada y pasa a paid cuando ya no le queda saldo.
create or replace function private.move_payment_batch_items_internal(p_organization_id uuid,p_item_ids uuid[],p_scheduled_for date,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  source record; line record; target_id uuid; target_status text;
  moved integer:=0; split integer:=0; count_items integer; source_ids uuid[]; target_ids uuid[]:='{}';
  balance numeric(18,2); new_item_id uuid;
  current_supplier text; current_number text; current_due date;
begin
  if auth.uid() is null or not exists(select 1 from public.organization_memberships m where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.role in ('administrator','finance')) then raise exception 'Finance access required'; end if;
  if p_item_ids is null or cardinality(p_item_ids)<1 or cardinality(p_item_ids)>250
    or cardinality(p_item_ids)<>(select count(distinct x) from unnest(p_item_ids)x)
    or p_scheduled_for is null or extract(isodow from p_scheduled_for)<>5 or p_scheduled_for<current_date
    or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Invalid payment reschedule'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,711905));
  select count(*),array_agg(distinct i.payment_batch_id) into count_items,source_ids
  from public.payment_batch_items i join public.payment_batches b on b.id=i.payment_batch_id and b.organization_id=i.organization_id
  where i.organization_id=p_organization_id and i.id=any(p_item_ids) and i.authorization_status='authorized'
    and b.status in ('draft','review','approved','processing')
    and coalesce((select sum(e.amount) from public.payment_executions e where e.payment_batch_item_id=i.id),0) < i.authorized_amount-0.01;
  if count_items<>cardinality(p_item_ids) then raise exception 'Only authorized items with outstanding balance can be rescheduled'; end if;
  perform set_config('app.payment_item_rpc','on',true);
  for source in select distinct b.* from public.payment_batches b join public.payment_batch_items i on i.payment_batch_id=b.id
    where b.organization_id=p_organization_id and i.id=any(p_item_ids)
  loop
    if source.scheduled_for=p_scheduled_for then continue; end if;
    target_status:=case when source.status='processing' then 'approved' else source.status end;
    target_id:=null;
    select id into target_id from public.payment_batches b where b.organization_id=p_organization_id
      and b.status=target_status and b.scheduled_for=p_scheduled_for and b.currency_code=source.currency_code
      and b.bank_account_id is not distinct from source.bank_account_id
      and b.approved_by is not distinct from source.approved_by and b.approved_at is not distinct from source.approved_at
    order by b.created_at limit 1 for update;
    if target_id is null then
      insert into public.payment_batches(organization_id,bank_account_id,scheduled_for,currency_code,status,notes,submitted_at,approved_at,approved_by,created_by)
      values(p_organization_id,source.bank_account_id,p_scheduled_for,source.currency_code,target_status,
        coalesce(source.notes,'Reprogramación autorizada'),source.submitted_at,source.approved_at,source.approved_by,auth.uid()) returning id into target_id;
    end if;
    target_ids:=target_ids||target_id;
    for line in select i.*,coalesce((select sum(e.amount) from public.payment_executions e where e.payment_batch_item_id=i.id),0) as executed_amount
      from public.payment_batch_items i
      where i.organization_id=p_organization_id and i.payment_batch_id=source.id and i.id=any(p_item_ids)
      for update of i
    loop
      if line.executed_amount<=0 then
        insert into public.payment_reschedule_events(organization_id,payment_batch_item_id,received_document_id,direct_payable_id,
          from_payment_batch_id,to_payment_batch_id,from_scheduled_for,to_scheduled_for,amount,reason,moved_by)
        values(line.organization_id,line.id,line.received_document_id,line.direct_payable_id,source.id,target_id,
          source.scheduled_for,p_scheduled_for,line.authorized_amount,btrim(p_reason),auth.uid());
        update public.payment_batch_items set payment_batch_id=target_id,
          authorization_source_batch_id=case when source.status='draft' then target_id else authorization_source_batch_id end
          where id=line.id;
        moved:=moved+1;
      else
        balance:=line.authorized_amount-line.executed_amount;
        if line.received_document_id is not null then
          select d.supplier_name,d.document_number,d.due_date into current_supplier,current_number,current_due
            from public.received_documents d where d.id=line.received_document_id and d.organization_id=p_organization_id;
        else
          select p.supplier_name,coalesce(p.invoice_number,p.payable_number),p.due_date into current_supplier,current_number,current_due
            from public.direct_payables p where p.id=line.direct_payable_id and p.organization_id=p_organization_id;
        end if;
        -- El original queda cerrado por lo ejecutado; así deja de reservar el
        -- documento antes de autorizar el saldo en el nuevo viernes.
        update public.payment_batch_items set authorized_amount=line.executed_amount where id=line.id;
        insert into public.payment_batch_items(organization_id,payment_batch_id,received_document_id,direct_payable_id,
          supplier_name_snapshot,document_number_snapshot,due_date_snapshot,amount,cash_flow_category,
          authorization_status,authorized_amount,authorized_at,authorized_by,authorization_source_batch_id)
        values(p_organization_id,target_id,line.received_document_id,line.direct_payable_id,
          current_supplier,current_number,current_due,balance,line.cash_flow_category,
          'authorized',balance,line.authorized_at,line.authorized_by,line.authorization_source_batch_id)
        returning id into new_item_id;
        insert into public.payment_reschedule_events(organization_id,payment_batch_item_id,received_document_id,direct_payable_id,
          from_payment_batch_id,to_payment_batch_id,from_scheduled_for,to_scheduled_for,amount,reason,moved_by)
        values(p_organization_id,new_item_id,line.received_document_id,line.direct_payable_id,source.id,target_id,
          source.scheduled_for,p_scheduled_for,balance,btrim(p_reason),auth.uid());
        split:=split+1;
      end if;
    end loop;
  end loop;
  update public.payment_batches b set total_amount=coalesce((select sum(i.authorized_amount)
      from public.payment_batch_items i where i.payment_batch_id=b.id and i.authorization_status='authorized'),0)
    where b.organization_id=p_organization_id and (b.id=any(source_ids) or b.id=any(target_ids));
  -- Una instrucción emitida sin saldo pendiente queda ejecutada.
  update public.payment_batches b set status='paid',
      paid_at=coalesce(b.paid_at,(select max(e.executed_on)::timestamptz from public.payment_executions e where e.payment_batch_id=b.id))
    where b.organization_id=p_organization_id and b.id=any(source_ids) and b.status='processing'
      and b.payment_proof_path is not null
      and exists(select 1 from public.payment_executions e where e.payment_batch_id=b.id)
      and not exists(select 1 from public.payment_batch_items i where i.payment_batch_id=b.id and i.authorization_status='authorized'
        and coalesce((select sum(e.amount) from public.payment_executions e where e.payment_batch_item_id=i.id),0) < i.authorized_amount-0.01);
  delete from public.payment_batches b where b.organization_id=p_organization_id and b.id=any(source_ids)
    and b.status='draft' and not exists(select 1 from public.payment_batch_items i where i.payment_batch_id=b.id);
  return jsonb_build_object('moved_items',moved+split,'split_items',split,'scheduled_for',p_scheduled_for,'source_batch_ids',source_ids);
end;
$$;
