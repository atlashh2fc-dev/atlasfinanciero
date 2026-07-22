grant delete on public.organizations to authenticated;

create policy "platform administrators delete organizations"
on public.organizations
for delete to authenticated
using (private.is_platform_administrator());
