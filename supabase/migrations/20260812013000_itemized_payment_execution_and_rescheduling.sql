-- Ejecución granular de propuestas de pago.
--
-- Una propuesta autoriza importes por ítem; cada abono y cada comprobante se
-- registra por separado. La cabecera sigue existiendo para compatibilidad y
-- sólo pasa a paid cuando todos sus ítems vigentes están totalmente ejecutados.

-- Correlativo de solicitudes generado en base. Los números manuales e
-- históricos se respetan; sólo se completa null o texto vacío.
create or replace function public.assign_purchase_request_number()
returns trigger language plpgsql security invoker set search_path='' as $$
declare request_year text; next_number bigint;
begin
  if nullif(btrim(coalesce(new.request_number,'')),'') is not null then return new; end if;
  request_year:=to_char(coalesce(new.requested_on,current_date),'YYYY');
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text,968452));
  select coalesce(max((regexp_match(request_number,'^SC-'||request_year||'-([0-9]+)$'))[1]::bigint),0)+1
    into next_number from public.purchase_requests
    where organization_id=new.organization_id and request_number~('^SC-'||request_year||'-[0-9]+$');
  new.request_number:=format('SC-%s-%s',request_year,lpad(next_number::text,4,'0'));
  return new;
end;
$$;
drop trigger if exists purchase_requests_assign_number on public.purchase_requests;
create trigger purchase_requests_assign_number before insert on public.purchase_requests
for each row execute function public.assign_purchase_request_number();
revoke all on function public.assign_purchase_request_number() from public,anon,authenticated;

alter table public.payment_batch_items
  add column authorization_status text not null default 'authorized'
    check (authorization_status in ('authorized', 'cancelled')),
  add column authorized_amount numeric(18,2),
  add column authorized_at timestamptz,
  add column authorized_by uuid references auth.users(id) on delete set null,
  add column authorization_source_batch_id uuid,
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references auth.users(id) on delete set null,
  add column cancellation_reason text,
  add constraint payment_batch_items_authorization_source_fkey
    foreign key (authorization_source_batch_id, organization_id)
    references public.payment_batches (id, organization_id) on delete restrict,
  add constraint payment_batch_items_authorization_state_check check (
    (authorization_status = 'authorized'
      and authorized_amount is not null and authorized_amount > 0
      and cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or
    (authorization_status = 'cancelled'
      and cancelled_at is not null
      and length(btrim(cancellation_reason)) between 3 and 500)
  ) not valid;

-- El backfill toca propuestas históricas no draft. Esta bandera existe sólo
-- durante la transacción de migración y la función temporal conserva todas
-- las demás protecciones de líneas.
create or replace function public.enforce_procure_to_pay_lines_editability()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_status text; v_parent_id uuid;
begin
  if tg_table_name='vendor_purchase_order_lines' then
    v_parent_id:=case when tg_op='DELETE' then old.purchase_order_id else new.purchase_order_id end;
    select status into v_status from public.vendor_purchase_orders where id=v_parent_id;
    if v_status<>'draft' then raise exception 'Purchase order lines can only be changed while draft'; end if;
  elsif tg_table_name='payment_batch_items' then
    if current_setting('app.payment_item_rpc',true)='on' then return coalesce(new,old); end if;
    v_parent_id:=case when tg_op='DELETE' then old.payment_batch_id else new.payment_batch_id end;
    select status into v_status from public.payment_batches where id=v_parent_id;
    if v_status<>'draft' then raise exception 'Payment batch items can only be changed while draft'; end if;
  end if;
  return coalesce(new,old);
end;
$$;
select set_config('app.payment_item_rpc','on',true);
drop trigger if exists payment_batch_items_refresh_totals on public.payment_batch_items;

update public.payment_batch_items item
set authorized_amount = item.amount,
    authorized_at = coalesce(batch.approved_at, batch.submitted_at, batch.created_at),
    authorized_by = batch.approved_by,
    authorization_source_batch_id = batch.id
from public.payment_batches batch
where batch.id = item.payment_batch_id
  and batch.organization_id = item.organization_id;

select set_config('app.payment_item_rpc','off',true);
create trigger payment_batch_items_refresh_totals
after insert or update or delete on public.payment_batch_items
for each row execute function public.refresh_procure_to_pay_totals();

alter table public.payment_batch_items alter column authorized_amount set not null;
alter table public.payment_batch_items validate constraint payment_batch_items_authorization_state_check;
alter table public.payment_batch_items
  add constraint payment_batch_items_id_organization_key unique (id, organization_id);

alter table public.payment_executions
  add column payment_batch_item_id uuid,
  add constraint payment_executions_batch_item_organization_fkey
    foreign key (payment_batch_item_id, organization_id)
    references public.payment_batch_items (id, organization_id) on delete restrict;

-- En el modelo anterior una ejecución era única por lote/documento. La nueva
-- identidad es el abono (idempotency_key); un mismo ítem admite N abonos.
drop index if exists public.payment_executions_batch_document_idx;
drop index if exists public.payment_executions_batch_direct_payable_idx;
create index payment_executions_batch_item_idx
  on public.payment_executions (organization_id, payment_batch_item_id, executed_on desc)
  where payment_batch_item_id is not null;

update public.payment_executions execution
set payment_batch_item_id = item.id
from public.payment_batch_items item
where execution.source = 'payment_batch'
  and execution.payment_batch_id = item.payment_batch_id
  and execution.organization_id = item.organization_id
  and (
    (execution.received_document_id is not null and execution.received_document_id = item.received_document_id)
    or (execution.direct_payable_id is not null and execution.direct_payable_id = item.direct_payable_id)
  )
  and execution.payment_batch_item_id is null;

create table public.payment_batch_item_proofs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_batch_id uuid not null,
  payment_batch_item_id uuid not null,
  payment_execution_id uuid not null,
  paid_on date not null,
  amount numeric(18,2) not null check (amount > 0),
  payment_reference text,
  storage_path text not null,
  file_name text not null,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  file_size bigint not null check (file_size between 1 and 52428800),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (payment_execution_id),
  foreign key (payment_batch_id, organization_id)
    references public.payment_batches (id, organization_id) on delete restrict,
  foreign key (payment_batch_item_id, organization_id)
    references public.payment_batch_items (id, organization_id) on delete restrict,
  foreign key (payment_execution_id, organization_id)
    references public.payment_executions (id, organization_id) on delete restrict,
  check (length(btrim(file_name)) between 1 and 300),
  check (payment_reference is null or length(btrim(payment_reference)) between 1 and 180)
);

create index payment_batch_item_proofs_item_idx
  on public.payment_batch_item_proofs (organization_id, payment_batch_item_id, paid_on desc);
create index payment_batch_item_proofs_batch_idx
  on public.payment_batch_item_proofs (organization_id, payment_batch_id, paid_on desc);

alter table public.payment_batch_item_proofs enable row level security;
create policy "finance and audit read payment item proofs"
on public.payment_batch_item_proofs for select to authenticated using (
  exists (select 1 from public.organization_memberships membership
    where membership.organization_id = payment_batch_item_proofs.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor'))
);
-- Escrituras sólo por RPC: evita comprobantes huérfanos de una ejecución.
grant select on public.payment_batch_item_proofs to authenticated;
revoke insert, update, delete on public.payment_batch_item_proofs from authenticated, anon;
-- Toda mutación de ítems pasa por las RPC atómicas; se mantiene INSERT para
-- la creación normal de propuestas en borrador.
revoke update, delete on public.payment_batch_items from authenticated, anon;

-- Un ítem cancelado conserva su auditoría, pero deja de reservar la deuda.
-- También aplica el saldo ejecutado a documentos recibidos, igual que ya se
-- hacía con cuentas directas, para soportar abonos sin permitir sobrepagos.
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

-- Las escrituras normales de ítems siguen limitadas a draft. Las RPC privadas
-- abren una excepción local a su transacción, sin desactivar triggers globales.
create or replace function public.enforce_procure_to_pay_lines_editability()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_status text; v_parent_id uuid;
begin
  if tg_table_name='vendor_purchase_order_lines' then
    v_parent_id:=case when tg_op='DELETE' then old.purchase_order_id else new.purchase_order_id end;
    select status into v_status from public.vendor_purchase_orders where id=v_parent_id;
    if v_status<>'draft' then raise exception 'Purchase order lines can only be changed while draft'; end if;
  elsif tg_table_name='payment_batch_items' then
    if current_setting('app.payment_item_rpc',true)='on' then return coalesce(new,old); end if;
    v_parent_id:=case when tg_op='DELETE' then old.payment_batch_id else new.payment_batch_id end;
    select status into v_status from public.payment_batches where id=v_parent_id;
    if v_status<>'draft' then raise exception 'Payment batch items can only be changed while draft'; end if;
  end if;
  return coalesce(new,old);
end;
$$;

-- Mantiene todas las transiciones previas y permite a las RPC security-definer
-- recalcular exclusivamente los campos derivados de una cabecera no borrador.
create or replace function public.enforce_procure_to_pay_transition()
returns trigger language plpgsql security invoker set search_path='' as $$
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
    if new.status=old.status then
      if old.status<>'draft' and (to_jsonb(new)-array['updated_at','beneficiary_name','invoice_number','supplier_name']) is distinct from (to_jsonb(old)-array['updated_at','beneficiary_name','invoice_number','supplier_name']) then raise exception 'Only supplier, beneficiary or invoice number can be corrected after direct payable submission'; end if;
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

create or replace function public.validate_payment_execution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  document_amount numeric(18,2);
  settled_amount numeric(18,2) := 0;
  item_row record;
  bank_amount numeric(18,2);
begin
  if new.received_document_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':received:' || new.received_document_id::text, 0));
    select abs(total_amount) into document_amount from public.received_documents
    where id = new.received_document_id and organization_id = new.organization_id for update;
    select coalesce(sum(amount),0) into settled_amount from public.payment_executions
    where organization_id = new.organization_id and received_document_id = new.received_document_id
      and (tg_op <> 'UPDATE' or id <> old.id);
  elsif new.direct_payable_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':direct:' || new.direct_payable_id::text, 0));
    select abs(total_amount) into document_amount from public.direct_payables
    where id = new.direct_payable_id and organization_id = new.organization_id for update;
    select coalesce(sum(amount),0) into settled_amount from public.payment_executions
    where organization_id = new.organization_id and direct_payable_id = new.direct_payable_id
      and (tg_op <> 'UPDATE' or id <> old.id);
  else
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':issued:' || new.issued_document_id::text, 0));
    select round(abs(coalesce(total_amount,0)),0) into document_amount from public.issued_documents
    where id = new.issued_document_id and organization_id = new.organization_id for update;
    select coalesce(sum(amount),0) into settled_amount from public.payment_executions
    where organization_id = new.organization_id and issued_document_id = new.issued_document_id
      and (tg_op <> 'UPDATE' or id <> old.id);
  end if;
  if document_amount is null or document_amount <= 0 or settled_amount + new.amount > document_amount + 0.01 then
    raise exception 'Payment execution exceeds the outstanding balance';
  end if;
  if new.source = 'payment_batch' then
    select item.id, item.payment_batch_id, item.received_document_id, item.direct_payable_id,
           item.authorized_amount, item.authorization_status, item.cash_flow_category, batch.status
      into item_row
    from public.payment_batch_items item
    join public.payment_batches batch on batch.id = item.payment_batch_id and batch.organization_id = item.organization_id
    where item.id = new.payment_batch_item_id and item.organization_id = new.organization_id for update;
    if item_row.id is null or item_row.payment_batch_id <> new.payment_batch_id
       or item_row.authorization_status <> 'authorized'
       or item_row.status not in ('approved','processing','paid')
       or item_row.received_document_id is distinct from new.received_document_id
       or item_row.direct_payable_id is distinct from new.direct_payable_id
       or item_row.cash_flow_category is distinct from new.cash_flow_classification then
      raise exception 'Execution does not match an authorized payment item';
    end if;
    select coalesce(sum(amount),0) into settled_amount from public.payment_executions
    where organization_id = new.organization_id and payment_batch_item_id = new.payment_batch_item_id
      and (tg_op <> 'UPDATE' or id <> old.id);
    if settled_amount + new.amount > item_row.authorized_amount + 0.01 then
      raise exception 'Execution exceeds the item authorized amount';
    end if;
  end if;
  if new.bank_transaction_id is not null then
    select amount into bank_amount from public.bank_transactions
    where id = new.bank_transaction_id and organization_id = new.organization_id for key share;
    if bank_amount is null or (new.direction = 'inflow' and bank_amount <= 0)
       or (new.direction = 'outflow' and bank_amount >= 0) then
      raise exception 'Bank transaction direction does not match payment execution';
    end if;
  end if;
  return new;
end;
$$;

-- Recibidas y cuentas directas quedan abiertas durante abonos parciales y se
-- cierran exclusivamente al completar su saldo.
create or replace function public.sync_payment_execution_to_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare settled numeric(18,2); total numeric(18,2);
begin
  if new.received_document_id is not null then
    select coalesce(sum(amount),0) into settled from public.payment_executions
      where organization_id=new.organization_id and received_document_id=new.received_document_id;
    select abs(total_amount) into total from public.received_documents
      where id=new.received_document_id and organization_id=new.organization_id;
    update public.received_documents set
      payment_status=case when settled >= total-0.01 then 'Pagada' else 'Abonada' end,
      payment_date=new.executed_on, payment_method=coalesce(new.payment_method,'Pago registrado'),
      payment_reference=new.payment_reference,
      payment_notes=coalesce(new.notes,'Abono registrado en el libro de ejecuciones.'),
      payment_recorded_at=now(), payment_recorded_by=coalesce(new.created_by,auth.uid())
    where id=new.received_document_id and organization_id=new.organization_id;
  elsif new.direct_payable_id is not null then
    select coalesce(sum(amount),0) into settled from public.payment_executions
      where organization_id=new.organization_id and direct_payable_id=new.direct_payable_id;
    select abs(total_amount) into total from public.direct_payables
      where id=new.direct_payable_id and organization_id=new.organization_id;
    if settled >= total-0.01 then
      update public.direct_payables set status='paid', paid_at=coalesce(paid_at,new.executed_on::timestamptz),
        payment_reference=coalesce(new.payment_reference,payment_reference)
      where id=new.direct_payable_id and organization_id=new.organization_id and status='approved';
    end if;
  else
    insert into public.issued_document_payments (
      organization_id,issued_document_id,payment_execution_id,amount,paid_on,payment_method,notes,
      proof_path,proof_name,proof_mime_type,proof_size,created_by,created_at
    ) values (new.organization_id,new.issued_document_id,new.id,new.amount,new.executed_on,new.payment_method,new.notes,
      new.proof_path,new.proof_name,new.proof_mime_type,new.proof_size,new.created_by,new.created_at)
    on conflict (payment_execution_id) where payment_execution_id is not null do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.protect_payment_execution_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'Payment executions are append-only'; end if;
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
    or new.direction is distinct from old.direction or new.source is distinct from old.source
    or new.received_document_id is distinct from old.received_document_id
    or new.issued_document_id is distinct from old.issued_document_id
    or new.direct_payable_id is distinct from old.direct_payable_id
    or new.payment_batch_id is distinct from old.payment_batch_id
    or new.payment_batch_item_id is distinct from old.payment_batch_item_id
    or new.amount is distinct from old.amount or new.executed_on is distinct from old.executed_on
    or new.payment_method is distinct from old.payment_method or new.payment_reference is distinct from old.payment_reference
    or new.notes is distinct from old.notes or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at or new.idempotency_key is distinct from old.idempotency_key
    or new.proof_path is distinct from old.proof_path or new.proof_name is distinct from old.proof_name
    or new.proof_mime_type is distinct from old.proof_mime_type or new.proof_size is distinct from old.proof_size then
    raise exception 'Payment execution financial identity is immutable';
  end if;
  if old.bank_transaction_id is not null and new.bank_transaction_id is distinct from old.bank_transaction_id then
    raise exception 'A reconciled payment execution cannot change bank transaction';
  end if;
  return new;
end;
$$;

-- Desactiva la materialización masiva heredada: desde aquí la ejecución se
-- crea por RPC y nunca por cambiar la cabecera a paid.
drop trigger if exists payment_batches_create_executions on public.payment_batches;

create or replace function private.record_payment_batch_item_execution_internal(
  p_organization_id uuid, p_payment_batch_item_id uuid, p_amount numeric,
  p_paid_on date, p_payment_reference text, p_storage_path text,
  p_file_name text, p_mime_type text, p_file_size bigint, p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare item record; execution_id uuid; proof_id uuid; paid_sum numeric(18,2); remaining numeric(18,2); all_done boolean;
begin
  if auth.uid() is null or not exists (select 1 from public.organization_memberships m
    where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.role in ('administrator','finance')) then
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

create or replace function public.record_payment_batch_item_execution(
  p_organization_id uuid,p_payment_batch_item_id uuid,p_amount numeric,p_paid_on date,p_payment_reference text,
  p_storage_path text,p_file_name text,p_mime_type text,p_file_size bigint,p_idempotency_key uuid
) returns jsonb language sql security invoker set search_path='' as $$
 select private.record_payment_batch_item_execution_internal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);
$$;

create or replace function private.cancel_payment_batch_items_internal(p_organization_id uuid,p_item_ids uuid[],p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare affected integer; batch_ids uuid[];
begin
  if auth.uid() is null or not exists(select 1 from public.organization_memberships m where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.role in ('administrator','finance')) then raise exception 'Finance access required'; end if;
  if p_item_ids is null or cardinality(p_item_ids)<1 or cardinality(p_item_ids)>250
    or cardinality(p_item_ids)<>(select count(distinct x) from unnest(p_item_ids)x)
    or p_reason is null or length(btrim(p_reason)) not between 3 and 500 then raise exception 'Invalid item cancellation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,711906));
  if exists(select 1 from public.payment_batch_items i join public.payment_batches b on b.id=i.payment_batch_id
    where i.organization_id=p_organization_id and i.id=any(p_item_ids)
      and (b.status not in ('draft','review','approved','processing') or i.authorization_status<>'authorized'
        or exists(select 1 from public.payment_executions e where e.payment_batch_item_id=i.id)))
    or (select count(*) from public.payment_batch_items where organization_id=p_organization_id and id=any(p_item_ids))<>cardinality(p_item_ids)
  then raise exception 'Only unexecuted active payment items can be cancelled'; end if;
  select array_agg(distinct payment_batch_id) into batch_ids from public.payment_batch_items where organization_id=p_organization_id and id=any(p_item_ids);
  perform set_config('app.payment_item_rpc','on',true);
  update public.payment_batch_items set authorization_status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancellation_reason=btrim(p_reason)
    where organization_id=p_organization_id and id=any(p_item_ids);
  get diagnostics affected=row_count;
  update public.payment_batches b set total_amount=coalesce((select sum(i.authorized_amount)
      from public.payment_batch_items i where i.payment_batch_id=b.id and i.authorization_status='authorized'),0)
    where b.organization_id=p_organization_id and b.id=any(batch_ids);
  update public.payment_batches b set status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancellation_reason=btrim(p_reason)
    where b.organization_id=p_organization_id and b.id=any(batch_ids)
      and not exists(select 1 from public.payment_batch_items i where i.payment_batch_id=b.id and i.authorization_status='authorized');
  return jsonb_build_object('cancelled_items',affected,'batch_ids',batch_ids);
end;
$$;

create or replace function public.cancel_payment_batch_items(p_organization_id uuid,p_item_ids uuid[],p_reason text)
returns jsonb language sql security invoker set search_path='' as $$ select private.cancel_payment_batch_items_internal($1,$2,$3); $$;

create or replace function public.cancel_payment_batch(p_organization_id uuid,p_payment_batch_id uuid,p_reason text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare ids uuid[];
begin
  select array_agg(id) into ids from public.payment_batch_items
    where organization_id=p_organization_id and payment_batch_id=p_payment_batch_id and authorization_status='authorized';
  if ids is null then raise exception 'Payment batch has no active items'; end if;
  return private.cancel_payment_batch_items_internal(p_organization_id,ids,p_reason);
end;
$$;

-- Reemplazo compatible de la RPC existente. Permite mover ítems no
-- ejecutados desde draft/review/approved; una autorización aprobada conserva
-- importe, aprobador y lote fuente en el propio ítem.
create or replace function private.move_payment_batch_items_internal(p_organization_id uuid,p_item_ids uuid[],p_scheduled_for date,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source record; target_id uuid; moved integer:=0; count_items integer; source_ids uuid[];
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
    and b.status in ('draft','review','approved') and not exists(select 1 from public.payment_executions e where e.payment_batch_item_id=i.id);
  if count_items<>cardinality(p_item_ids) then raise exception 'Only unexecuted draft, review or approved items can be rescheduled'; end if;
  perform set_config('app.payment_item_rpc','on',true);
  for source in select distinct b.* from public.payment_batches b join public.payment_batch_items i on i.payment_batch_id=b.id
    where b.organization_id=p_organization_id and i.id=any(p_item_ids)
  loop
    if source.scheduled_for=p_scheduled_for then continue; end if;
    select id into target_id from public.payment_batches b where b.organization_id=p_organization_id
      and b.status=source.status and b.scheduled_for=p_scheduled_for and b.currency_code=source.currency_code
      and b.bank_account_id is not distinct from source.bank_account_id
      and b.approved_by is not distinct from source.approved_by and b.approved_at is not distinct from source.approved_at
    order by b.created_at limit 1 for update;
    if target_id is null then
      insert into public.payment_batches(organization_id,bank_account_id,scheduled_for,currency_code,status,notes,submitted_at,approved_at,approved_by,created_by)
      values(p_organization_id,source.bank_account_id,p_scheduled_for,source.currency_code,source.status,
        coalesce(source.notes,'Reprogramación autorizada'),source.submitted_at,source.approved_at,source.approved_by,auth.uid()) returning id into target_id;
    end if;
    insert into public.payment_reschedule_events(organization_id,payment_batch_item_id,received_document_id,direct_payable_id,
      from_payment_batch_id,to_payment_batch_id,from_scheduled_for,to_scheduled_for,amount,reason,moved_by)
    select i.organization_id,i.id,i.received_document_id,i.direct_payable_id,source.id,target_id,source.scheduled_for,p_scheduled_for,
      i.authorized_amount,btrim(p_reason),auth.uid() from public.payment_batch_items i
      where i.organization_id=p_organization_id and i.payment_batch_id=source.id and i.id=any(p_item_ids);
    update public.payment_batch_items set payment_batch_id=target_id,
      authorization_source_batch_id=case when source.status='draft' then target_id else authorization_source_batch_id end
      where organization_id=p_organization_id and payment_batch_id=source.id and id=any(p_item_ids);
    get diagnostics count_items=row_count; moved:=moved+count_items;
  end loop;
  update public.payment_batches b set total_amount=coalesce((select sum(i.authorized_amount)
      from public.payment_batch_items i where i.payment_batch_id=b.id and i.authorization_status='authorized'),0)
    where b.organization_id=p_organization_id and (b.id=any(source_ids) or b.id in
      (select i.payment_batch_id from public.payment_batch_items i where i.id=any(p_item_ids)));
  delete from public.payment_batches b where b.organization_id=p_organization_id and b.id=any(source_ids)
    and b.status='draft' and not exists(select 1 from public.payment_batch_items i where i.payment_batch_id=b.id);
  return jsonb_build_object('moved_items',moved,'scheduled_for',p_scheduled_for,'source_batch_ids',source_ids);
end;
$$;

revoke all on function private.record_payment_batch_item_execution_internal(uuid,uuid,numeric,date,text,text,text,text,bigint,uuid) from public,anon;
grant execute on function private.record_payment_batch_item_execution_internal(uuid,uuid,numeric,date,text,text,text,text,bigint,uuid) to authenticated;
revoke all on function public.record_payment_batch_item_execution(uuid,uuid,numeric,date,text,text,text,text,bigint,uuid) from public,anon;
grant execute on function public.record_payment_batch_item_execution(uuid,uuid,numeric,date,text,text,text,text,bigint,uuid) to authenticated;
revoke all on function private.cancel_payment_batch_items_internal(uuid,uuid[],text) from public,anon;
grant execute on function private.cancel_payment_batch_items_internal(uuid,uuid[],text) to authenticated;
revoke all on function public.cancel_payment_batch_items(uuid,uuid[],text) from public,anon;
grant execute on function public.cancel_payment_batch_items(uuid,uuid[],text) to authenticated;
revoke all on function public.cancel_payment_batch(uuid,uuid,text) from public,anon;
grant execute on function public.cancel_payment_batch(uuid,uuid,text) to authenticated;
revoke all on function public.validate_payment_execution() from public,anon,authenticated;
revoke all on function public.sync_payment_execution_to_document() from public,anon,authenticated;
revoke all on function public.protect_payment_execution_identity() from public,anon,authenticated;
