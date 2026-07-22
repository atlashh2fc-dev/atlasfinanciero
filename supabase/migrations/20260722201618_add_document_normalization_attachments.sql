-- Las facturas recibidas importadas históricamente pueden no tener folio ni
-- archivo. Estas columnas permiten normalizarlas sin alterar su origen.
alter table public.received_documents
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime_type text,
  add column if not exists attachment_size bigint;

create unique index if not exists received_documents_attachment_path_key
  on public.received_documents (attachment_path)
  where attachment_path is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('received-document-files', 'received-document-files', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "expense readers read received document objects"
on storage.objects for select to authenticated using (
  bucket_id = 'received-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

create policy "finance uploads received document objects"
on storage.objects for insert to authenticated with check (
  bucket_id = 'received-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance deletes received document objects"
on storage.objects for delete to authenticated using (
  bucket_id = 'received-document-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

-- Completar folio y adjuntar la factura no modifica monto, proveedor, estado
-- ni aprobación. Se permite esa corrección documental aun después del envío.
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
    elsif old.status = 'processing' and new.status = 'paid' then
      if new.paid_at is null then raise exception 'Paid date is required'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'processing') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid payment batch transition'; end if;
  elsif tg_table_name = 'direct_payables' then
    if new.status = old.status then
      if old.status <> 'draft' and (to_jsonb(new) - array['updated_at', 'beneficiary_name', 'invoice_number']) is distinct from (to_jsonb(old) - array['updated_at', 'beneficiary_name', 'invoice_number']) then
        raise exception 'Only beneficiary or invoice number can be corrected after direct payable submission';
      end if;
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
