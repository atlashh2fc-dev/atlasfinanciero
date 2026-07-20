-- Permite revertir una carga incompleta sin dejar una cartola huérfana en Storage.
create policy "finance delete bank statement objects" on storage.objects
for delete to authenticated using (
  bucket_id = 'bank-statements'
  and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id::text = split_part(name, '/', 1)
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
);
