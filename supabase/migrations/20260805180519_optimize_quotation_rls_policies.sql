drop policy "operators manage quotation catalog" on public.quotation_catalog_items;
drop policy "operators manage sales quotes" on public.sales_quotes;

create policy "operators insert quotation catalog" on public.quotation_catalog_items
for insert to authenticated
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_items.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "operators update quotation catalog" on public.quotation_catalog_items
for update to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_items.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
))
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_items.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "operators delete quotation catalog" on public.quotation_catalog_items
for delete to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = quotation_catalog_items.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "operators insert sales quotes" on public.sales_quotes
for insert to authenticated
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sales_quotes.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "operators update sales quotes" on public.sales_quotes
for update to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sales_quotes.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
))
with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sales_quotes.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));

create policy "operators delete sales quotes" on public.sales_quotes
for delete to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = sales_quotes.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'operations')
));
