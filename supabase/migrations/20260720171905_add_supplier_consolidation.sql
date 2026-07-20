-- Una consolidación nunca elimina la ficha anterior: la deja inactiva, enlazada
-- a su ficha canónica y conserva sus nombres previos como alias auditables.
alter table public.counterparties
  add column merged_into_counterparty_id uuid,
  add column merged_at timestamptz,
  add column merged_by uuid references auth.users(id) on delete set null,
  add constraint counterparties_merged_into_organization_fkey
    foreign key (merged_into_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  add constraint counterparties_merge_metadata_check
    check (
      (merged_into_counterparty_id is null and merged_at is null)
      or (merged_into_counterparty_id is not null and merged_at is not null)
    );

create table public.counterparty_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  canonical_counterparty_id uuid not null,
  merged_counterparty_id uuid,
  alias_name text not null,
  normalized_alias text not null,
  source text not null default 'supplier_consolidation',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (organization_id, canonical_counterparty_id, normalized_alias),
  foreign key (canonical_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  foreign key (merged_counterparty_id, organization_id)
    references public.counterparties (id, organization_id) on delete restrict,
  check (length(btrim(alias_name)) > 0),
  check (length(btrim(normalized_alias)) > 0)
);

create index counterparties_merged_into_idx
  on public.counterparties (organization_id, merged_into_counterparty_id)
  where merged_into_counterparty_id is not null;
create index counterparty_aliases_lookup_idx
  on public.counterparty_aliases (organization_id, normalized_alias);

alter table public.counterparty_aliases enable row level security;
create policy "finance and audit read counterparty aliases"
on public.counterparty_aliases for select to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = counterparty_aliases.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance', 'auditor')
));
create policy "finance manages counterparty aliases"
on public.counterparty_aliases for all to authenticated
using (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = counterparty_aliases.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
)) with check (exists (
  select 1 from public.organization_memberships membership
  where membership.organization_id = counterparty_aliases.organization_id
    and membership.user_id = (select auth.uid())
    and membership.role in ('administrator', 'finance')
));
grant select, insert, update, delete on public.counterparty_aliases to authenticated;

create or replace function public.consolidate_supplier_counterparties(
  p_organization_id uuid,
  p_canonical_counterparty_id uuid,
  p_duplicate_counterparty_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_row public.counterparties;
  duplicate_row public.counterparties;
  duplicate_id uuid;
  canonical_name text;
  normalized_alias text;
  affected integer;
  updated_records integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance')
  ) then raise exception 'Supplier consolidation requires finance access'; end if;
  if p_canonical_counterparty_id is null
     or coalesce(array_length(p_duplicate_counterparty_ids, 1), 0) = 0
     or p_canonical_counterparty_id = any(p_duplicate_counterparty_ids) then
    raise exception 'A canonical supplier and one or more distinct duplicates are required';
  end if;

  select * into canonical_row from public.counterparties
  where id = p_canonical_counterparty_id
    and organization_id = p_organization_id
    and is_active
    and merged_into_counterparty_id is null
    and kind in ('supplier', 'both')
  for update;
  if not found then raise exception 'Canonical supplier is not available'; end if;
  canonical_name := coalesce(nullif(btrim(canonical_row.trade_name), ''), canonical_row.legal_name);

  foreach duplicate_id in array p_duplicate_counterparty_ids loop
    select * into duplicate_row from public.counterparties
    where id = duplicate_id
      and organization_id = p_organization_id
      and is_active
      and merged_into_counterparty_id is null
      and kind in ('supplier', 'both')
    for update;
    if not found then raise exception 'A selected duplicate supplier is not available'; end if;

    foreach normalized_alias in array array[
      duplicate_row.legal_name,
      coalesce(duplicate_row.trade_name, '')
    ] loop
      if nullif(btrim(normalized_alias), '') is not null then
        insert into public.counterparty_aliases (
          organization_id, canonical_counterparty_id, merged_counterparty_id,
          alias_name, normalized_alias, created_by
        ) values (
          p_organization_id, canonical_row.id, duplicate_row.id,
          normalized_alias,
          regexp_replace(lower(btrim(normalized_alias)), '[^[:alnum:]]+', '', 'g'),
          auth.uid()
        ) on conflict (organization_id, canonical_counterparty_id, normalized_alias)
          do update set merged_counterparty_id = excluded.merged_counterparty_id;
      end if;
    end loop;

    update public.received_documents
    set supplier_counterparty_id = canonical_row.id, supplier_name = canonical_name,
        supplier_tax_id = canonical_row.tax_id
    where organization_id = p_organization_id and supplier_counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count; updated_records := updated_records + affected;

    update public.direct_payables
    set supplier_counterparty_id = canonical_row.id, supplier_name = canonical_name
    where organization_id = p_organization_id and supplier_counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count; updated_records := updated_records + affected;

    update public.purchase_requests
    set supplier_counterparty_id = canonical_row.id, supplier_name = canonical_name
    where organization_id = p_organization_id and supplier_counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count; updated_records := updated_records + affected;

    update public.vendor_purchase_orders
    set supplier_counterparty_id = canonical_row.id, supplier_name = canonical_name,
        supplier_tax_id = canonical_row.tax_id
    where organization_id = p_organization_id and supplier_counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count; updated_records := updated_records + affected;

    update public.asset_financing_plans
    set supplier_counterparty_id = canonical_row.id, supplier_name = canonical_name
    where organization_id = p_organization_id and supplier_counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count; updated_records := updated_records + affected;

    update public.counterparties
    set is_active = false, merged_into_counterparty_id = canonical_row.id,
        merged_at = now(), merged_by = auth.uid()
    where id = duplicate_row.id and organization_id = p_organization_id;
  end loop;

  update public.received_documents document
  set supplier_name = canonical_name, supplier_tax_id = canonical_row.tax_id
  where document.organization_id = p_organization_id
    and document.supplier_counterparty_id = canonical_row.id;
  get diagnostics affected = row_count; updated_records := updated_records + affected;
  update public.direct_payables payable
  set supplier_name = canonical_name
  where payable.organization_id = p_organization_id
    and payable.supplier_counterparty_id = canonical_row.id;
  get diagnostics affected = row_count; updated_records := updated_records + affected;
  update public.purchase_requests request
  set supplier_name = canonical_name
  where request.organization_id = p_organization_id
    and request.supplier_counterparty_id = canonical_row.id;
  get diagnostics affected = row_count; updated_records := updated_records + affected;
  update public.vendor_purchase_orders order_row
  set supplier_name = canonical_name, supplier_tax_id = canonical_row.tax_id
  where order_row.organization_id = p_organization_id
    and order_row.supplier_counterparty_id = canonical_row.id;
  get diagnostics affected = row_count; updated_records := updated_records + affected;
  update public.asset_financing_plans plan
  set supplier_name = canonical_name
  where plan.organization_id = p_organization_id
    and plan.supplier_counterparty_id = canonical_row.id;
  get diagnostics affected = row_count; updated_records := updated_records + affected;

  update public.payment_batch_items item
  set supplier_name_snapshot = canonical_name
  from public.received_documents document
  where item.organization_id = p_organization_id
    and item.received_document_id = document.id
    and document.organization_id = p_organization_id
    and document.supplier_counterparty_id = canonical_row.id;
  update public.payment_batch_items item
  set supplier_name_snapshot = canonical_name
  from public.direct_payables payable
  where item.organization_id = p_organization_id
    and item.direct_payable_id = payable.id
    and payable.organization_id = p_organization_id
    and payable.supplier_counterparty_id = canonical_row.id;

  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    p_organization_id, auth.uid(), 'counterparty', canonical_row.id, 'supplier_consolidated',
    jsonb_build_object('duplicate_counterparty_ids', p_duplicate_counterparty_ids),
    jsonb_build_object('canonical_name', canonical_name, 'updated_records', updated_records)
  );
  return jsonb_build_object('canonical_counterparty_id', canonical_row.id, 'canonical_name', canonical_name, 'updated_records', updated_records);
end;
$$;

revoke all on function public.consolidate_supplier_counterparties(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.consolidate_supplier_counterparties(uuid, uuid, uuid[]) to authenticated;

-- Sincronización inicial: toda relación que ya apunta a una ficha de proveedor
-- adopta su nombre y RUT canónicos, sin borrar ningún documento ni cuenta.
update public.received_documents document
set supplier_name = coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name),
    supplier_tax_id = counterparty.tax_id
from public.counterparties counterparty
where counterparty.id = document.supplier_counterparty_id
  and counterparty.organization_id = document.organization_id
  and counterparty.kind in ('supplier', 'both')
  and (document.supplier_name is distinct from coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name)
    or document.supplier_tax_id is distinct from counterparty.tax_id);
update public.direct_payables payable
set supplier_name = coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name)
from public.counterparties counterparty
where counterparty.id = payable.supplier_counterparty_id
  and counterparty.organization_id = payable.organization_id
  and counterparty.kind in ('supplier', 'both')
  and payable.supplier_name is distinct from coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name);
update public.purchase_requests request
set supplier_name = coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name)
from public.counterparties counterparty
where counterparty.id = request.supplier_counterparty_id
  and counterparty.organization_id = request.organization_id
  and counterparty.kind in ('supplier', 'both')
  and request.supplier_name is distinct from coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name);
update public.vendor_purchase_orders order_row
set supplier_name = coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name), supplier_tax_id = counterparty.tax_id
from public.counterparties counterparty
where counterparty.id = order_row.supplier_counterparty_id
  and counterparty.organization_id = order_row.organization_id
  and counterparty.kind in ('supplier', 'both')
  and (order_row.supplier_name is distinct from coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name)
    or order_row.supplier_tax_id is distinct from counterparty.tax_id);
update public.asset_financing_plans plan
set supplier_name = coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name)
from public.counterparties counterparty
where counterparty.id = plan.supplier_counterparty_id
  and counterparty.organization_id = plan.organization_id
  and counterparty.kind in ('supplier', 'both')
  and plan.supplier_name is distinct from coalesce(nullif(btrim(counterparty.trade_name), ''), counterparty.legal_name);
