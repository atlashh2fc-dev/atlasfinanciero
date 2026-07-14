-- Índices de las nuevas relaciones para evitar búsquedas completas al depurar, conciliar o borrar.
create index counterparty_contacts_organization_idx on public.counterparty_contacts (organization_id);
create index counterparty_contacts_created_by_idx on public.counterparty_contacts (created_by) where created_by is not null;
create index customer_purchase_order_billings_document_organization_idx on public.customer_purchase_order_billings (issued_document_id, organization_id);
create index customer_purchase_order_billings_organization_idx on public.customer_purchase_order_billings (organization_id);
create index customer_purchase_order_billings_created_by_idx on public.customer_purchase_order_billings (created_by) where created_by is not null;
create index customer_purchase_orders_created_by_idx on public.customer_purchase_orders (created_by) where created_by is not null;

-- Unificar políticas por acción: mismo permiso de negocio sin evaluación RLS duplicada.
drop policy "finance roles create counterparties" on public.counterparties;
drop policy "finance roles update counterparties" on public.counterparties;
drop policy "operations create counterparties" on public.counterparties;
drop policy "operations update counterparties" on public.counterparties;

create policy "business roles create counterparties" on public.counterparties
for insert to authenticated with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);
create policy "business roles update counterparties" on public.counterparties
for update to authenticated using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
) with check (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = counterparties.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'operations')
  )
);

drop policy "customer operators manage contacts" on public.counterparty_contacts;
create policy "business roles create counterparty contacts" on public.counterparty_contacts
for insert to authenticated with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = counterparty_contacts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);
create policy "business roles update counterparty contacts" on public.counterparty_contacts
for update to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = counterparty_contacts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
) with check (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = counterparty_contacts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);
create policy "business roles delete counterparty contacts" on public.counterparty_contacts
for delete to authenticated using (
  exists (select 1 from public.organization_memberships membership where membership.organization_id = counterparty_contacts.organization_id and membership.user_id = (select auth.uid()) and membership.role in ('administrator', 'finance', 'operations'))
);
