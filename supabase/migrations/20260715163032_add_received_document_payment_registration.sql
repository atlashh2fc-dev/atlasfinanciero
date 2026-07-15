alter table public.received_documents
  add column payment_reference text,
  add column payment_notes text,
  add column payment_recorded_at timestamptz,
  add column payment_recorded_by uuid references auth.users(id) on delete set null;

create or replace function public.audit_received_document_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    new.organization_id,
    auth.uid(),
    'received_document',
    new.id,
    'update',
    to_jsonb(old),
    to_jsonb(new)
  );
  return new;
end;
$$;

create trigger received_documents_audit_changes
after update on public.received_documents
for each row execute function public.audit_received_document_changes();

create policy "finance roles update received documents"
on public.received_documents
for update to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = received_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = received_documents.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);

grant update on public.received_documents to authenticated;
revoke all on function public.audit_received_document_changes() from public, anon, authenticated;
