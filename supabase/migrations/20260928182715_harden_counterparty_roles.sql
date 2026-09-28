-- Fichas únicas por RUT y roles acumulables.
--
-- Una misma empresa puede ser cliente y proveedor. Hasta ahora:
--   * El correo tributario y el RCV hacían upsert con onConflict
--     "organization_id,tax_id", que no calza con ningún índice único utilizable
--     (42P10); el error se ignoraba y los documentos quedaban sin ficha.
--     Además habrían sobrescrito "kind" y el RCV escribía el valor inválido
--     'client'.
--   * Crear un cliente con el RUT de un proveedor (o al revés) fallaba con
--     23505 o devolvía 409 en vez de sumar el rol.
--   * consolidate_customer_counterparties actualizaba public.sales_quotations
--     (la tabla real es sales_quotes), por lo que toda fusión de clientes
--     fallaba; ambas fusiones exigían el mismo rol y sólo movían algunas FK.
--
-- Esta migración:
--   1. Versiona normalized_tax_id (existente en producción desde la migración
--      remota 20260919002519) y su índice único.
--   2. Normaliza kind ('client' → 'customer') y lo restringe.
--   3. Elimina los índices únicos redundantes sobre el RUT sin normalizar.
--   4. Crea public.upsert_counterparty_role: alta o suma de rol por RUT
--      normalizado, sin pisar nombres.
--   5. Crea public.merge_counterparties: fusión genérica que mueve TODAS las
--      FK hacia public.counterparties, admite roles mixtos y une los roles.
--      Las fusiones de clientes y proveedores delegan en ella.

-- 1. RUT normalizado ---------------------------------------------------------

alter table public.counterparties
  add column if not exists normalized_tax_id text
  generated always as (
    nullif(upper(regexp_replace(coalesce(tax_id, ''), '[^0-9kK]', '', 'g')), '')
  ) stored;

-- Vínculo con la ficha del CRM (también creado por la migración remota).
alter table public.counterparties
  add column if not exists crm_entity_id uuid;
create index if not exists counterparties_crm_entity_id_idx
  on public.counterparties (crm_entity_id)
  where crm_entity_id is not null;

create unique index if not exists counterparties_organization_normalized_tax_id_key
  on public.counterparties (organization_id, normalized_tax_id)
  where normalized_tax_id is not null and merged_into_counterparty_id is null;

-- RUT canónico "12345678-K" o null si el cuerpo/dígito verificador no calzan.
create or replace function private.format_rut(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_clean text := upper(regexp_replace(coalesce(p_value, ''), '[^0-9kK]', '', 'g'));
  v_body text;
  v_dv text;
  v_total integer := 0;
  v_factor integer := 2;
  v_expected integer;
  v_index integer;
begin
  if length(v_clean) < 2 then
    return null;
  end if;
  v_body := ltrim(left(v_clean, -1), '0');
  v_dv := right(v_clean, 1);
  if v_body !~ '^[0-9]{7,8}$' then
    return null;
  end if;
  for v_index in reverse length(v_body)..1 loop
    v_total := v_total + substr(v_body, v_index, 1)::integer * v_factor;
    v_factor := case when v_factor = 7 then 2 else v_factor + 1 end;
  end loop;
  v_expected := 11 - (v_total % 11);
  if v_dv <> (case v_expected when 11 then '0' when 10 then 'K' else v_expected::text end) then
    return null;
  end if;
  return v_body || '-' || v_dv;
end;
$$;

-- Unión de roles: cliente + proveedor = both. 'client' se lee como cliente.
create or replace function private.counterparty_kind_union(p_first text, p_second text)
returns text
language sql
immutable
set search_path = ''
as $$
  with roles as (
    select case lower(btrim(value)) when 'client' then 'customer' else lower(btrim(value)) end as role
    from unnest(array[p_first, p_second]) as value
    where nullif(btrim(value), '') is not null
  )
  select case
    when exists (select 1 from roles where role = 'both')
      or (exists (select 1 from roles where role = 'customer') and exists (select 1 from roles where role = 'supplier'))
      then 'both'
    when exists (select 1 from roles where role = 'supplier') then 'supplier'
    else 'customer'
  end;
$$;

-- 2. Roles válidos -----------------------------------------------------------

update public.counterparties set kind = 'customer' where kind = 'client';

alter table public.counterparties drop constraint if exists counterparties_kind_check;
alter table public.counterparties
  add constraint counterparties_kind_check check (kind in ('customer', 'supplier', 'both'));

-- 3. Índices redundantes -----------------------------------------------------
-- Con el índice normalizado vigente, los índices sobre el RUT crudo sólo
-- estorban: uno ni siquiera excluye fichas consolidadas (impide que la ficha
-- canónica herede el RUT de una duplicada).
do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'counterparties'
      and indexname = 'counterparties_organization_normalized_tax_id_key'
  ) then
    drop index if exists public.counterparties_organization_tax_id_unique_idx;
    drop index if exists public.counterparties_organization_tax_id_key;
  end if;
end;
$$;

-- 4. Alta o suma de rol ------------------------------------------------------

-- Llamadas del servidor sin usuario (clave de servicio, cron del SII,
-- migraciones) o miembros con permiso para crear fichas del rol pedido.
create or replace function private.can_register_counterparty_role(p_organization_id uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      (select auth.uid()) is null
      and coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
        ''
      ) not in ('anon', 'authenticated')
    )
    or exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = (select auth.uid())
        and (
          membership.role::text in ('administrator', 'finance', 'operations')
          or (
            p_role = 'supplier'
            and membership.role::text = 'data_entry'
            and (
              membership.can_create_suppliers
              or membership.can_create_payment_proposals
              or membership.can_record_payment_transfers
            )
          )
        )
    );
$$;

revoke all on function private.can_register_counterparty_role(uuid, text) from public, anon;
grant execute on function private.can_register_counterparty_role(uuid, text) to authenticated, service_role;

create or replace function public.upsert_counterparty_role(
  p_organization_id uuid,
  p_tax_id text,
  p_legal_name text,
  p_role text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := case lower(btrim(coalesce(p_role, '')))
    when 'client' then 'customer'
    else lower(btrim(coalesce(p_role, '')))
  end;
  v_tax_id text := coalesce(private.format_rut(p_tax_id), nullif(btrim(p_tax_id), ''));
  v_key text;
  v_name text := nullif(btrim(p_legal_name), '');
  v_id uuid;
begin
  if v_role not in ('customer', 'supplier') then
    raise exception 'Invalid counterparty role' using errcode = '22023';
  end if;
  v_key := nullif(upper(regexp_replace(coalesce(v_tax_id, ''), '[^0-9kK]', '', 'g')), '');
  if p_organization_id is null or v_key is null then
    raise exception 'A tax id is required' using errcode = '22023';
  end if;
  if not private.can_register_counterparty_role(p_organization_id, v_role) then
    raise exception 'Not authorized to register counterparties' using errcode = '42501';
  end if;

  -- Nunca se sobrescriben nombres ni datos: sólo se suma el rol.
  insert into public.counterparties as existing (
    organization_id, legal_name, tax_id, kind, is_active, created_by
  ) values (
    p_organization_id, coalesce(v_name, v_tax_id), v_tax_id, v_role, true, auth.uid()
  )
  on conflict (organization_id, normalized_tax_id)
    where normalized_tax_id is not null and merged_into_counterparty_id is null
  do update set kind = private.counterparty_kind_union(existing.kind, excluded.kind)
    where existing.kind is distinct from private.counterparty_kind_union(existing.kind, excluded.kind)
  returning id into v_id;

  if v_id is null then
    select counterparty.id into v_id
    from public.counterparties counterparty
    where counterparty.organization_id = p_organization_id
      and counterparty.normalized_tax_id = v_key
      and counterparty.merged_into_counterparty_id is null;
  end if;
  return v_id;
end;
$$;

revoke all on function public.upsert_counterparty_role(uuid, text, text, text) from public, anon;
grant execute on function public.upsert_counterparty_role(uuid, text, text, text) to authenticated, service_role;

-- 5. Fusión genérica ---------------------------------------------------------

create or replace function public.merge_counterparties(
  p_organization_id uuid,
  p_canonical_id uuid,
  p_duplicate_ids uuid[],
  p_source text default 'counterparty_merge'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canonical public.counterparties;
  v_duplicate public.counterparties;
  v_duplicate_id uuid;
  v_duplicates uuid[] := '{}';
  v_kind text;
  v_canonical_name text;
  v_inherited_tax_id text;
  v_alias text;
  v_fk record;
  v_row record;
  v_trigger record;
  v_disabled text[];
  v_snapshot text;
  v_has_rows boolean;
  v_affected integer;
  v_updated_records integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_id_attnum smallint;
  -- Reglas de transición que impiden editar documentos enviados. Una fusión
  -- sólo cambia la ficha y sus nombres, así que se omiten mientras dura
  -- (ALTER TABLE es transaccional: nadie más ve los triggers desactivados).
  v_transition_guards constant text[] := array[
    'enforce_procure_to_pay_transition',
    'enforce_preinvoice_transition',
    'enforce_asset_financing_plan_transition'
  ];
begin
  if auth.uid() is null then
    if coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ) in ('anon', 'authenticated') then
      raise exception 'Authentication required' using errcode = '42501';
    end if;
  elsif not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role::text in ('administrator', 'finance')
  ) then
    raise exception 'Counterparty merge requires finance access' using errcode = '42501';
  end if;

  if p_canonical_id is null
    or coalesce(array_length(p_duplicate_ids, 1), 0) = 0
    or p_canonical_id = any(p_duplicate_ids)
  then
    raise exception 'A canonical counterparty and one or more distinct duplicates are required';
  end if;

  select * into v_canonical
  from public.counterparties
  where id = p_canonical_id
    and organization_id = p_organization_id
    and is_active
    and merged_into_counterparty_id is null
  for update;
  if not found then
    raise exception 'Canonical counterparty is not available';
  end if;
  v_kind := v_canonical.kind;

  foreach v_duplicate_id in array p_duplicate_ids loop
    select * into v_duplicate
    from public.counterparties
    where id = v_duplicate_id and organization_id = p_organization_id
    for update;
    if not found then
      raise exception 'A selected duplicate counterparty is not available';
    end if;
    -- Idempotente: una duplicada ya fusionada en esta misma ficha se omite.
    continue when v_duplicate.merged_into_counterparty_id = v_canonical.id;
    if v_duplicate.merged_into_counterparty_id is not null then
      raise exception 'A selected duplicate counterparty was already merged into another profile';
    end if;
    continue when v_duplicate.id = any(v_duplicates);
    v_duplicates := v_duplicates || v_duplicate.id;
    v_kind := private.counterparty_kind_union(v_kind, v_duplicate.kind);

    foreach v_alias in array array[v_duplicate.legal_name, coalesce(v_duplicate.trade_name, '')] loop
      if nullif(regexp_replace(lower(btrim(v_alias)), '[^[:alnum:]]+', '', 'g'), '') is not null then
        insert into public.counterparty_aliases (
          organization_id, canonical_counterparty_id, merged_counterparty_id,
          alias_name, normalized_alias, source, created_by
        ) values (
          p_organization_id, v_canonical.id, v_duplicate.id, btrim(v_alias),
          regexp_replace(lower(btrim(v_alias)), '[^[:alnum:]]+', '', 'g'),
          coalesce(nullif(btrim(p_source), ''), 'counterparty_merge'), auth.uid()
        )
        on conflict (organization_id, canonical_counterparty_id, normalized_alias)
        do update set merged_counterparty_id = excluded.merged_counterparty_id,
          source = excluded.source;
      end if;
    end loop;
  end loop;

  if coalesce(array_length(v_duplicates, 1), 0) = 0 then
    return jsonb_build_object(
      'canonical_counterparty_id', v_canonical.id,
      'canonical_name', coalesce(nullif(btrim(v_canonical.trade_name), ''), v_canonical.legal_name),
      'kind', v_canonical.kind,
      'merged_ids', '[]'::jsonb,
      'updated_records', 0,
      'conflicts', '[]'::jsonb
    );
  end if;

  -- Si la canónica no tiene RUT y las duplicadas comparten uno solo, lo hereda.
  if v_canonical.normalized_tax_id is null then
    select min(counterparty.tax_id) into v_inherited_tax_id
    from public.counterparties counterparty
    where counterparty.id = any(v_duplicates)
      and counterparty.normalized_tax_id is not null
    having count(distinct counterparty.normalized_tax_id) = 1;
  end if;
  v_canonical_name := coalesce(nullif(btrim(v_canonical.trade_name), ''), v_canonical.legal_name);

  -- Contactos: se combinan con los de la canónica (misma regla que antes).
  insert into public.counterparty_contacts as existing (
    organization_id, counterparty_id, contact_area, job_title, full_name,
    phone, email, is_primary, created_by
  )
  select distinct on (contact.contact_area, contact.full_name)
    contact.organization_id, v_canonical.id, contact.contact_area, contact.job_title,
    contact.full_name, contact.phone, contact.email, contact.is_primary, contact.created_by
  from public.counterparty_contacts contact
  where contact.organization_id = p_organization_id
    and contact.counterparty_id = any(v_duplicates)
  order by contact.contact_area, contact.full_name, contact.is_primary desc, contact.updated_at desc
  on conflict (counterparty_id, contact_area, full_name)
  do update set
    job_title = coalesce(excluded.job_title, existing.job_title),
    phone = coalesce(excluded.phone, existing.phone),
    email = coalesce(excluded.email, existing.email),
    is_primary = excluded.is_primary or existing.is_primary;
  delete from public.counterparty_contacts
  where organization_id = p_organization_id
    and counterparty_id = any(v_duplicates);

  -- Alias que ya apuntaban a una duplicada: los repetidos se descartan.
  delete from public.counterparty_aliases alias
  where alias.organization_id = p_organization_id
    and alias.canonical_counterparty_id = any(v_duplicates)
    and exists (
      select 1 from public.counterparty_aliases kept
      where kept.organization_id = alias.organization_id
        and kept.canonical_counterparty_id = v_canonical.id
        and kept.normalized_alias = alias.normalized_alias
    );

  select attnum into v_id_attnum
  from pg_attribute
  where attrelid = 'public.counterparties'::regclass and attname = 'id';

  -- Todas las FK hacia counterparties(id). Órdenes de compra y servicios
  -- primero: las validaciones de facturas y de asignaciones de costo exigen
  -- que su OC / servicio pertenezca a la misma ficha.
  for v_fk in
    select
      constraint_row.conrelid::regclass as table_name,
      namespace.nspname as schema_name,
      class.relname as relation_name,
      attribute.attname as column_name
    from pg_constraint constraint_row
    join pg_class class on class.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = class.relnamespace
    join pg_attribute attribute
      on attribute.attrelid = constraint_row.conrelid
     and attribute.attnum = constraint_row.conkey[array_position(constraint_row.confkey, v_id_attnum)]
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.counterparties'::regclass
      and array_position(constraint_row.confkey, v_id_attnum) is not null
      -- Historial de alias: conserva qué ficha se fusionó.
      and not (class.relname = 'counterparty_aliases' and attribute.attname = 'merged_counterparty_id')
    order by
      case class.relname
        when 'vendor_purchase_orders' then 0
        when 'customer_services' then 0
        else 1
      end,
      class.relname,
      attribute.attname
  loop
    execute format('select exists (select 1 from %s where %I = any($1))', v_fk.table_name, v_fk.column_name)
      into v_has_rows using v_duplicates;
    continue when not v_has_rows;

    v_disabled := '{}';
    for v_trigger in
      select trigger_row.tgname
      from pg_trigger trigger_row
      join pg_proc procedure_row on procedure_row.oid = trigger_row.tgfoid
      where trigger_row.tgrelid = v_fk.table_name
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
        and procedure_row.proname = any(v_transition_guards)
    loop
      execute format('alter table %s disable trigger %I', v_fk.table_name, v_trigger.tgname);
      v_disabled := v_disabled || v_trigger.tgname::text;
    end loop;

    -- Nombres denormalizados que acompañan a cada FK conocida.
    v_snapshot := case v_fk.schema_name || '.' || v_fk.relation_name || '.' || v_fk.column_name
      when 'public.received_documents.supplier_counterparty_id'
        then ', supplier_name = $3, supplier_tax_id = coalesce($4, supplier_tax_id)'
      when 'public.vendor_purchase_orders.supplier_counterparty_id'
        then ', supplier_name = $3, supplier_tax_id = coalesce($4, supplier_tax_id)'
      when 'public.direct_payables.supplier_counterparty_id' then ', supplier_name = $3'
      when 'public.purchase_requests.supplier_counterparty_id' then ', supplier_name = $3'
      when 'public.asset_financing_plans.supplier_counterparty_id' then ', supplier_name = $3'
      when 'public.issued_documents.counterparty_id'
        then ', client_name = $3, recipient_name = $5, recipient_tax_id = coalesce($4, recipient_tax_id)'
      when 'public.customer_purchase_orders.customer_counterparty_id'
        then ', customer_name = $3, customer_tax_id = coalesce($4, customer_tax_id)'
      else ''
    end;

    begin
      execute format('update %s set %I = $1%s where %I = any($2)',
        v_fk.table_name, v_fk.column_name, v_snapshot, v_fk.column_name)
        using v_canonical.id, v_duplicates, v_canonical_name,
          coalesce(v_canonical.tax_id, v_inherited_tax_id), v_canonical.legal_name;
      get diagnostics v_affected = row_count;
      v_updated_records := v_updated_records + v_affected;
    exception when unique_violation then
      -- Fila a fila: las que chocan con un registro equivalente de la
      -- canónica se quedan en la duplicada (consolidada) y se informan.
      for v_row in execute format(
        'select source.ctid as row_ctid, to_jsonb(source.*) ->> ''id'' as row_id from %s source where source.%I = any($1)',
        v_fk.table_name, v_fk.column_name)
        using v_duplicates
      loop
        begin
          execute format('update %s set %I = $1%s where ctid = $2',
            v_fk.table_name, v_fk.column_name, v_snapshot)
            using v_canonical.id, v_row.row_ctid, v_canonical_name,
              coalesce(v_canonical.tax_id, v_inherited_tax_id), v_canonical.legal_name;
          v_updated_records := v_updated_records + 1;
        exception when unique_violation then
          v_conflicts := v_conflicts || jsonb_build_object(
            'table', v_fk.relation_name, 'column', v_fk.column_name,
            'id', coalesce(v_row.row_id, v_row.row_ctid::text)
          );
        end;
      end loop;
    end;

    for v_trigger in select unnest(v_disabled) as tgname loop
      execute format('alter table %s enable trigger %I', v_fk.table_name, v_trigger.tgname);
    end loop;
  end loop;

  -- Instantáneas de lotes de pago (mismo criterio que la consolidación previa).
  if v_kind in ('supplier', 'both') then
    update public.payment_batch_items item
    set supplier_name_snapshot = v_canonical_name
    from public.received_documents document
    where item.organization_id = p_organization_id
      and item.received_document_id = document.id
      and document.organization_id = p_organization_id
      and document.supplier_counterparty_id = v_canonical.id
      and item.supplier_name_snapshot is distinct from v_canonical_name;
    update public.payment_batch_items item
    set supplier_name_snapshot = v_canonical_name
    from public.direct_payables payable
    where item.organization_id = p_organization_id
      and item.direct_payable_id = payable.id
      and payable.organization_id = p_organization_id
      and payable.supplier_counterparty_id = v_canonical.id
      and item.supplier_name_snapshot is distinct from v_canonical_name;
  end if;

  update public.counterparties
  set is_active = false,
      merged_into_counterparty_id = v_canonical.id,
      merged_at = now(),
      merged_by = auth.uid()
  where id = any(v_duplicates) and organization_id = p_organization_id;

  update public.counterparties
  set kind = v_kind,
      tax_id = coalesce(tax_id, v_inherited_tax_id)
  where id = v_canonical.id
    and (kind is distinct from v_kind or (tax_id is null and v_inherited_tax_id is not null));

  insert into public.audit_log (
    organization_id, actor_id, entity_type, entity_id, action, before_state, after_state
  ) values (
    p_organization_id, auth.uid(), 'counterparty', v_canonical.id,
    case p_source
      when 'customer_consolidation' then 'customer_consolidated'
      when 'supplier_consolidation' then 'supplier_consolidated'
      else 'counterparty_merged'
    end,
    jsonb_build_object(
      'duplicate_counterparty_ids', to_jsonb(v_duplicates),
      'canonical_kind', v_canonical.kind,
      'canonical_tax_id', v_canonical.tax_id
    ),
    jsonb_build_object(
      'canonical_name', v_canonical_name,
      'kind', v_kind,
      'tax_id', coalesce(v_canonical.tax_id, v_inherited_tax_id),
      'updated_records', v_updated_records,
      'conflicts', v_conflicts
    )
  );

  return jsonb_build_object(
    'canonical_counterparty_id', v_canonical.id,
    'canonical_name', v_canonical_name,
    'kind', v_kind,
    'merged_ids', to_jsonb(v_duplicates),
    'updated_records', v_updated_records,
    'conflicts', v_conflicts
  );
end;
$$;

revoke all on function public.merge_counterparties(uuid, uuid, uuid[], text) from public, anon;
grant execute on function public.merge_counterparties(uuid, uuid, uuid[], text) to authenticated, service_role;

-- Las fusiones por pantalla delegan en la fusión genérica (roles mixtos y
-- todas las FK). Conservan su firma y la forma de su respuesta.
create or replace function public.consolidate_customer_counterparties(
  p_organization_id uuid,
  p_canonical_counterparty_id uuid,
  p_duplicate_counterparty_ids uuid[]
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.merge_counterparties(
    p_organization_id, p_canonical_counterparty_id, p_duplicate_counterparty_ids, 'customer_consolidation'
  );
$$;

create or replace function public.consolidate_supplier_counterparties(
  p_organization_id uuid,
  p_canonical_counterparty_id uuid,
  p_duplicate_counterparty_ids uuid[]
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.merge_counterparties(
    p_organization_id, p_canonical_counterparty_id, p_duplicate_counterparty_ids, 'supplier_consolidation'
  );
$$;

revoke all on function public.consolidate_customer_counterparties(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.consolidate_customer_counterparties(uuid, uuid, uuid[]) to authenticated;
revoke all on function public.consolidate_supplier_counterparties(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.consolidate_supplier_counterparties(uuid, uuid, uuid[]) to authenticated;
