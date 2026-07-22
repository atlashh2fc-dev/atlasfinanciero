-- Un finiquito es una cuenta por pagar, pero el acreedor operacional (la
-- persona desvinculada) debe quedar visible aunque se use un proveedor
-- genérico para agrupar esta clase de obligaciones.
alter table public.direct_payables
  add column if not exists beneficiary_name text;

alter table public.direct_payables
  drop constraint if exists direct_payables_category_check,
  add constraint direct_payables_category_check check (
    category in ('utilities', 'rent', 'taxes', 'insurance', 'subscriptions', 'termination', 'other')
  ),
  add constraint direct_payables_beneficiary_name_check check (
    beneficiary_name is null or length(btrim(beneficiary_name)) between 1 and 300
  );

create index if not exists direct_payables_organization_beneficiary_idx
  on public.direct_payables (organization_id, beneficiary_name)
  where beneficiary_name is not null;

create table public.direct_payable_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  direct_payable_id uuid not null,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 52428800),
  uploaded_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (direct_payable_id, organization_id)
    references public.direct_payables (id, organization_id) on delete cascade,
  check (length(btrim(file_name)) between 1 and 300),
  check (mime_type in ('application/pdf', 'image/jpeg', 'image/png'))
);

create index direct_payable_attachments_payable_idx
  on public.direct_payable_attachments (organization_id, direct_payable_id, created_at desc);

alter table public.direct_payable_attachments enable row level security;

create policy "expense readers read direct payable attachments"
on public.direct_payable_attachments for select to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = direct_payable_attachments.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations', 'auditor')
  )
);

create policy "finance manages direct payable attachments"
on public.direct_payable_attachments for all to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = direct_payable_attachments.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = direct_payable_attachments.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant select, insert, update, delete on public.direct_payable_attachments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('direct-payable-files', 'direct-payable-files', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "expense readers read direct payable objects"
on storage.objects for select to authenticated using (
  bucket_id = 'direct-payable-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations', 'auditor')
  )
);

create policy "finance uploads direct payable objects"
on storage.objects for insert to authenticated with check (
  bucket_id = 'direct-payable-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

create policy "finance deletes direct payable objects"
on storage.objects for delete to authenticated using (
  bucket_id = 'direct-payable-files'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

-- Después de enviar una cuenta a aprobación, sólo se puede corregir el
-- beneficiario. El resto del expediente sigue inmutable para no alterar una
-- decisión financiera ya en curso.
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
      if new.status = 'approved' and not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'purchase_order' and r.target_id = new.id and r.status = 'approved' and r.metadata->>'kind' = 'vendor_purchase_order') then raise exception 'Purchase order must be decided in approvals'; end if;
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
      if not exists (select 1 from public.approval_requests r where r.organization_id = new.organization_id and r.target_type = 'payment' and r.target_id = new.id and r.status = 'approved' and r.metadata->>'kind' = 'payment_batch') then raise exception 'Payment batch must be decided in approvals'; end if;
    elsif old.status = 'approved' and new.status = 'processing' then null;
    elsif old.status = 'processing' and new.status = 'paid' then
      if new.paid_at is null then raise exception 'Paid date is required'; end if;
    elsif old.status in ('draft', 'review', 'approved', 'processing') and new.status = 'cancelled' then
      if new.cancellation_reason is null then raise exception 'Cancellation reason is required'; end if;
    else raise exception 'Invalid payment batch transition'; end if;
  elsif tg_table_name = 'direct_payables' then
    if new.status = old.status then
      if old.status <> 'draft' then
        if new.beneficiary_name is distinct from old.beneficiary_name
          and (to_jsonb(new) - array['beneficiary_name', 'updated_at']) = (to_jsonb(old) - array['beneficiary_name', 'updated_at']) then
          null;
        else
          raise exception 'Only the beneficiary can be corrected after a direct payable is submitted';
        end if;
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

-- La interfaz permite a Operaciones completar y adjuntar respaldo a un
-- documento emitido; la política anterior permitía crear pero no actualizar,
-- provocando el fallo genérico al guardar un archivo.
alter policy "finance roles update issued documents"
on public.issued_documents
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
)
with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = issued_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);
