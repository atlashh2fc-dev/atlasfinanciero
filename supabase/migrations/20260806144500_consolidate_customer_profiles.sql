-- Consolida fichas de clientes conservando las fichas antiguas como alias
-- auditables. Los documentos emitidos adoptan de inmediato la ficha canónica;
-- servicios y archivos históricos siguen accesibles mediante related_ids.
create or replace function public.consolidate_customer_counterparties(
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
  alias_value text;
  canonical_name text;
  updated_records integer := 0;
  affected integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance')
  ) then
    raise exception 'Customer consolidation requires finance access';
  end if;
  if p_canonical_counterparty_id is null
    or coalesce(array_length(p_duplicate_counterparty_ids, 1), 0) = 0
    or p_canonical_counterparty_id = any(p_duplicate_counterparty_ids)
  then
    raise exception 'A canonical customer and distinct duplicates are required';
  end if;

  select * into canonical_row
  from public.counterparties
  where id = p_canonical_counterparty_id
    and organization_id = p_organization_id
    and is_active
    and merged_into_counterparty_id is null
    and kind in ('customer', 'both')
  for update;
  if not found then raise exception 'Canonical customer is not available'; end if;
  canonical_name := coalesce(nullif(btrim(canonical_row.trade_name), ''), canonical_row.legal_name);

  foreach duplicate_id in array p_duplicate_counterparty_ids loop
    select * into duplicate_row
    from public.counterparties
    where id = duplicate_id
      and organization_id = p_organization_id
      and is_active
      and merged_into_counterparty_id is null
      and kind in ('customer', 'both')
    for update;
    if not found then raise exception 'A selected duplicate customer is not available'; end if;

    foreach alias_value in array array[
      duplicate_row.legal_name,
      coalesce(duplicate_row.trade_name, '')
    ] loop
      if nullif(btrim(alias_value), '') is not null then
        insert into public.counterparty_aliases (
          organization_id,
          canonical_counterparty_id,
          merged_counterparty_id,
          alias_name,
          normalized_alias,
          source,
          created_by
        ) values (
          p_organization_id,
          canonical_row.id,
          duplicate_row.id,
          alias_value,
          regexp_replace(lower(btrim(alias_value)), '[^[:alnum:]]+', '', 'g'),
          'customer_consolidation',
          auth.uid()
        )
        on conflict (organization_id, canonical_counterparty_id, normalized_alias)
        do update set
          merged_counterparty_id = excluded.merged_counterparty_id,
          source = excluded.source;
      end if;
    end loop;

    update public.issued_documents
    set counterparty_id = canonical_row.id,
        client_name = canonical_name,
        recipient_name = canonical_row.legal_name,
        recipient_tax_id = canonical_row.tax_id
    where organization_id = p_organization_id
      and counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count;
    updated_records := updated_records + affected;

    update public.customer_purchase_orders
    set customer_counterparty_id = canonical_row.id,
        customer_name = canonical_name,
        customer_tax_id = canonical_row.tax_id
    where organization_id = p_organization_id
      and customer_counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count;
    updated_records := updated_records + affected;

    insert into public.counterparty_contacts as existing (
      organization_id,
      counterparty_id,
      contact_area,
      job_title,
      full_name,
      phone,
      email,
      is_primary,
      created_by
    )
    select
      contact.organization_id,
      canonical_row.id,
      contact.contact_area,
      contact.job_title,
      contact.full_name,
      contact.phone,
      contact.email,
      contact.is_primary,
      contact.created_by
    from public.counterparty_contacts contact
    where contact.organization_id = p_organization_id
      and contact.counterparty_id = duplicate_row.id
    on conflict (counterparty_id, contact_area, full_name)
    do update set
      job_title = coalesce(excluded.job_title, existing.job_title),
      phone = coalesce(excluded.phone, existing.phone),
      email = coalesce(excluded.email, existing.email),
      is_primary = excluded.is_primary or existing.is_primary;

    delete from public.counterparty_contacts
    where organization_id = p_organization_id
      and counterparty_id = duplicate_row.id;

    update public.customer_files
    set counterparty_id = canonical_row.id
    where organization_id = p_organization_id
      and counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count;
    updated_records := updated_records + affected;

    update public.commercial_opportunities
    set counterparty_id = canonical_row.id
    where organization_id = p_organization_id
      and counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count;
    updated_records := updated_records + affected;

    update public.commercial_contracts
    set counterparty_id = canonical_row.id
    where organization_id = p_organization_id
      and counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count;
    updated_records := updated_records + affected;

    update public.commercial_projects
    set counterparty_id = canonical_row.id
    where organization_id = p_organization_id
      and counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count;
    updated_records := updated_records + affected;

    update public.sales_quotations
    set counterparty_id = canonical_row.id
    where organization_id = p_organization_id
      and counterparty_id = duplicate_row.id;
    get diagnostics affected = row_count;
    updated_records := updated_records + affected;

    update public.counterparties
    set is_active = false,
        merged_into_counterparty_id = canonical_row.id,
        merged_at = now(),
        merged_by = auth.uid()
    where id = duplicate_row.id
      and organization_id = p_organization_id;
  end loop;

  insert into public.audit_log (
    organization_id,
    actor_id,
    entity_type,
    entity_id,
    action,
    before_state,
    after_state
  ) values (
    p_organization_id,
    auth.uid(),
    'counterparty',
    canonical_row.id,
    'customer_consolidated',
    jsonb_build_object('duplicate_counterparty_ids', p_duplicate_counterparty_ids),
    jsonb_build_object('canonical_name', canonical_name, 'updated_records', updated_records)
  );

  return jsonb_build_object(
    'canonical_counterparty_id', canonical_row.id,
    'canonical_name', canonical_name,
    'updated_records', updated_records
  );
end;
$$;

revoke all on function public.consolidate_customer_counterparties(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.consolidate_customer_counterparties(uuid, uuid, uuid[]) to authenticated;
