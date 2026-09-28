-- Flujo documental persistente de compras.
--
-- Hasta ahora la relación nota de crédito → factura y guía → factura se
-- calculaba en pantalla con heurísticas (monto, fecha, texto "ANULA FACTURA"),
-- no quedaba guardada, no era buscable ni auditable, y la referencia a OC del
-- DTE se tomaba del primer folio referenciado aunque fuera otro documento.
--
-- Esta migración guarda cada vínculo con su origen y nivel de confianza:
--   dte_reference   : sección <Referencia> del XML del SII (automático).
--   notes_reference : folio explícito en la observación, p. ej.
--                     "ANULA FACTURA 3654", "DEVOLUCION FACTURA 6443 / 6442".
--   amount_rule     : coincidencia por proveedor y monto (guías de un mes que
--                     suman una factura, o NC sin folio con monto único).
--   manual          : creado o confirmado por una persona.
-- Un vínculo rechazado por una persona no se vuelve a crear automáticamente.

alter table public.received_documents
  add column if not exists sii_references jsonb not null default '[]'::jsonb;

comment on column public.received_documents.sii_references is
  'Referencias del DTE (<Referencia>): [{"type": 801, "folio": "4500123", "date": "2026-01-31", "code": 1, "reason": "..."}].';

create table public.received_document_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Documento "hijo": NC, ND, guía, o la factura que referencia una OC.
  source_document_id uuid not null,
  -- Factura a la que se aplica la NC/ND o que cobra la guía. Null mientras la
  -- factura referenciada no exista en el sistema.
  target_document_id uuid,
  vendor_purchase_order_id uuid,
  link_type text not null check (
    link_type in ('credit_note', 'debit_note', 'dispatch_guide', 'purchase_order')
  ),
  reference_folio text,
  reference_document_type integer,
  origin text not null check (
    origin in ('dte_reference', 'notes_reference', 'amount_rule', 'manual')
  ),
  status text not null default 'confirmed' check (
    status in ('confirmed', 'suggested', 'rejected')
  ),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (source_document_id, organization_id)
    references public.received_documents (id, organization_id) on delete cascade,
  foreign key (target_document_id, organization_id)
    references public.received_documents (id, organization_id) on delete cascade,
  foreign key (vendor_purchase_order_id, organization_id)
    references public.vendor_purchase_orders (id, organization_id) on delete set null (vendor_purchase_order_id),
  check (source_document_id is distinct from target_document_id),
  check (
    case link_type
      when 'purchase_order' then target_document_id is null
        and (vendor_purchase_order_id is not null or nullif(btrim(reference_folio), '') is not null)
      else vendor_purchase_order_id is null
        and (target_document_id is not null or nullif(btrim(reference_folio), '') is not null)
    end
  )
);

create unique index received_document_links_target_key
  on public.received_document_links (source_document_id, link_type, target_document_id)
  where target_document_id is not null;
create unique index received_document_links_reference_key
  on public.received_document_links (source_document_id, link_type, reference_folio)
  where target_document_id is null and reference_folio is not null;
create index received_document_links_target_idx
  on public.received_document_links (target_document_id) where target_document_id is not null;
create index received_document_links_pending_reference_idx
  on public.received_document_links (organization_id, reference_folio)
  where target_document_id is null;
create index received_document_links_purchase_order_idx
  on public.received_document_links (vendor_purchase_order_id) where vendor_purchase_order_id is not null;

alter table public.received_document_links enable row level security;
grant select on public.received_document_links to authenticated;
grant update (status, reviewed_by, reviewed_at) on public.received_document_links to authenticated;

create policy "finance and audit read received document links"
on public.received_document_links for select to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = received_document_links.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance', 'auditor')
  )
);

create policy "payment operators read received document links"
on public.received_document_links for select to authenticated
using ((select private.has_payment_capability(received_document_links.organization_id, 'any')));

create policy "platform administrators read received document links"
on public.received_document_links for select to authenticated
using (private.is_platform_administrator());

create policy "finance reviews received document links"
on public.received_document_links for update to authenticated
using (
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = received_document_links.organization_id
      and membership.user_id = (select auth.uid())
      and membership.role in ('administrator', 'finance')
  )
)
with check (status in ('confirmed', 'rejected'));

-- Normalizadores compartidos con received_documents_business_identity_key.
create or replace function private.received_document_supplier_key(
  p_tax_id text, p_counterparty_id uuid, p_name text
) returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(
    nullif(ltrim(regexp_replace(upper(btrim(p_tax_id)), '[^0-9K]', '', 'g'), '0'), ''),
    p_counterparty_id::text,
    regexp_replace(upper(btrim(p_name)), '[[:space:]]+', ' ', 'g')
  );
$$;

create or replace function private.received_document_kind(p_document_type text, p_sii_type integer)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_sii_type = 61 then 'credit_note'
    when p_sii_type = 56 then 'debit_note'
    when p_sii_type = 52 then 'dispatch_guide'
    when p_sii_type in (33, 34, 30, 32, 43, 45, 46) then 'invoice'
    else case
      when translate(lower(coalesce(p_document_type, '')), 'áéíóúüñ', 'aeiouun') ~ 'nota\s+(de\s+)?credito' then 'credit_note'
      when translate(lower(coalesce(p_document_type, '')), 'áéíóúüñ', 'aeiouun') ~ 'nota\s+(de\s+)?debito' then 'debit_note'
      when translate(lower(coalesce(p_document_type, '')), 'áéíóúüñ', 'aeiouun') ~ 'guia' then 'dispatch_guide'
      when translate(lower(coalesce(p_document_type, '')), 'áéíóúüñ', 'aeiouun') ~ 'factura|liquidacion' then 'invoice'
      else 'other'
    end
  end;
$$;

create or replace function private.normalize_folio(p_folio text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_folio is null or btrim(p_folio) = '' then null
    when regexp_replace(p_folio, '[\s.]', '', 'g') ~ '^[0-9]+$'
      then coalesce(nullif(ltrim(regexp_replace(p_folio, '[\s.]', '', 'g'), '0'), ''), '0')
    else lower(btrim(p_folio))
  end;
$$;

-- Folios de factura mencionados en la observación de una NC/ND:
-- "ANULA FACTURA 3654", "DEVOLUCION FACTURA 6443 / 6442", "ABONO FACTURA N° 6442".
create or replace function private.invoice_folios_in_notes(p_notes text)
returns setof text
language sql immutable
set search_path = ''
as $$
  select distinct private.normalize_folio(match[1])
  from regexp_matches(
    coalesce(
      substring(
        translate(lower(coalesce(p_notes, '')), 'áéíóúüñ', 'aeiouun')
        from 'factura?s?\s*(?:electronica\s*)?(?:n[°º.o]*\s*)?((?:[0-9][0-9.]*(?:\s*(?:/|,|y|-)\s*)?)+)'
      ),
      ''
    ),
    '([0-9][0-9.]{2,})',
    'g'
  ) as match;
$$;

-- Recalcula los vínculos automáticos de un documento, tanto cuando actúa como
-- "hijo" (NC, ND, guía, factura con OC) como cuando es la factura destino que
-- acaba de llegar y resuelve referencias pendientes.
create or replace function private.sync_received_document_links(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.received_documents%rowtype;
  v_kind text;
  v_supplier text;
  v_folio text;
  v_link_type text;
  v_reference record;
  v_target uuid;
  v_candidates uuid[];
  v_guides uuid[];
begin
  select * into v_doc from public.received_documents where id = p_document_id;
  if not found then
    return;
  end if;

  v_kind := private.received_document_kind(v_doc.document_type, v_doc.sii_document_type);
  v_supplier := private.received_document_supplier_key(
    v_doc.supplier_tax_id, v_doc.supplier_counterparty_id, v_doc.supplier_name
  );
  v_folio := private.normalize_folio(coalesce(v_doc.sii_folio::text, v_doc.document_number));

  -- Los vínculos automáticos se reconstruyen; los manuales y los rechazados
  -- (decisión humana) se conservan.
  delete from public.received_document_links link
  where link.source_document_id = v_doc.id
    and link.origin <> 'manual'
    and link.status <> 'rejected';

  -- 1. Referencias oficiales del DTE.
  for v_reference in
    select
      nullif(btrim(reference ->> 'folio'), '') as folio,
      case when (reference ->> 'type') ~ '^[0-9]+$' then (reference ->> 'type')::integer end as type
    from jsonb_array_elements(
      case when jsonb_typeof(v_doc.sii_references) = 'array' then v_doc.sii_references else '[]'::jsonb end
    ) reference
  loop
    continue when v_reference.folio is null;

    if v_reference.type = 801 then
      insert into public.received_document_links (
        organization_id, source_document_id, vendor_purchase_order_id, link_type,
        reference_folio, reference_document_type, origin, created_by
      )
      select
        v_doc.organization_id, v_doc.id,
        (
          select purchase_order.id from public.vendor_purchase_orders purchase_order
          where purchase_order.organization_id = v_doc.organization_id
            and private.normalize_folio(purchase_order.purchase_order_number) = private.normalize_folio(v_reference.folio)
          limit 1
        ),
        'purchase_order', btrim(v_reference.folio), 801, 'dte_reference', null
      on conflict do nothing;
    elsif v_kind in ('credit_note', 'debit_note') and v_reference.type in (33, 34, 30, 32, 43, 45, 46, 56) then
      select document.id into v_target
      from public.received_documents document
      where document.organization_id = v_doc.organization_id
        and document.id <> v_doc.id
        and private.received_document_supplier_key(document.supplier_tax_id, document.supplier_counterparty_id, document.supplier_name) = v_supplier
        and private.normalize_folio(coalesce(document.sii_folio::text, document.document_number)) = private.normalize_folio(v_reference.folio)
        and private.received_document_kind(document.document_type, document.sii_document_type) in ('invoice', 'debit_note')
      order by document.issue_date desc
      limit 1;
      insert into public.received_document_links (
        organization_id, source_document_id, target_document_id, link_type,
        reference_folio, reference_document_type, origin, created_by
      ) values (
        v_doc.organization_id, v_doc.id, v_target, v_kind,
        private.normalize_folio(v_reference.folio), v_reference.type, 'dte_reference', null
      )
      on conflict do nothing;
    elsif v_kind = 'invoice' and v_reference.type = 52 then
      -- La factura cita la guía: el vínculo se guarda desde la guía.
      insert into public.received_document_links (
        organization_id, source_document_id, target_document_id, link_type,
        reference_folio, reference_document_type, origin, created_by
      )
      select v_doc.organization_id, guide.id, v_doc.id, 'dispatch_guide',
        v_folio, v_doc.sii_document_type, 'dte_reference', null
      from public.received_documents guide
      where guide.organization_id = v_doc.organization_id
        and private.received_document_supplier_key(guide.supplier_tax_id, guide.supplier_counterparty_id, guide.supplier_name) = v_supplier
        and private.received_document_kind(guide.document_type, guide.sii_document_type) = 'dispatch_guide'
        and private.normalize_folio(coalesce(guide.sii_folio::text, guide.document_number)) = private.normalize_folio(v_reference.folio)
        and not exists (
          select 1 from public.received_document_links existing
          where existing.source_document_id = guide.id
            and existing.link_type = 'dispatch_guide'
            and (existing.status = 'rejected' and existing.target_document_id = v_doc.id
              or existing.status = 'confirmed' and existing.origin in ('dte_reference', 'manual'))
        )
      on conflict do nothing;
    end if;
  end loop;

  -- 2. Folio de factura escrito en la observación de una NC/ND.
  if v_kind in ('credit_note', 'debit_note')
    and not exists (
      select 1 from public.received_document_links link
      where link.source_document_id = v_doc.id and link.link_type = v_kind and link.status <> 'rejected'
    )
  then
    insert into public.received_document_links (
      organization_id, source_document_id, target_document_id, link_type,
      reference_folio, origin, created_by
    )
    select
      v_doc.organization_id, v_doc.id,
      (
        select document.id from public.received_documents document
        where document.organization_id = v_doc.organization_id
          and document.id <> v_doc.id
          and private.received_document_supplier_key(document.supplier_tax_id, document.supplier_counterparty_id, document.supplier_name) = v_supplier
          and private.normalize_folio(coalesce(document.sii_folio::text, document.document_number)) = referenced.folio
          and private.received_document_kind(document.document_type, document.sii_document_type) in ('invoice', 'debit_note')
        order by document.issue_date desc
        limit 1
      ),
      v_kind, referenced.folio, 'notes_reference', null
    from private.invoice_folios_in_notes(v_doc.notes) as referenced(folio)
    where referenced.folio is not null
      and referenced.folio is distinct from v_folio
    on conflict do nothing;
  end if;

  -- 3. NC/ND sin folio referenciado: una única factura del mismo proveedor con
  --    el mismo monto, emitida antes y dentro de 180 días, queda sugerida.
  if v_kind in ('credit_note', 'debit_note')
    and not exists (
      select 1 from public.received_document_links link
      where link.source_document_id = v_doc.id and link.link_type = v_kind
    )
  then
    select array_agg(document.id) into v_candidates
    from public.received_documents document
    where document.organization_id = v_doc.organization_id
      and private.received_document_supplier_key(document.supplier_tax_id, document.supplier_counterparty_id, document.supplier_name) = v_supplier
      and private.received_document_kind(document.document_type, document.sii_document_type) = 'invoice'
      and abs(document.total_amount - v_doc.total_amount) < 1
      and document.issue_date between v_doc.issue_date - 180 and v_doc.issue_date
      and not exists (
        select 1 from public.received_document_links used
        where used.target_document_id = document.id
          and used.link_type = v_kind
          and used.status = 'confirmed'
      );
    if coalesce(array_length(v_candidates, 1), 0) = 1 then
      insert into public.received_document_links (
        organization_id, source_document_id, target_document_id, link_type,
        origin, status, created_by
      ) values (
        v_doc.organization_id, v_doc.id, v_candidates[1], v_kind, 'amount_rule', 'suggested', null
      )
      on conflict do nothing;
    end if;
  end if;

  -- 4. Guía con valor: se vincula a la factura del mismo proveedor que cobra
  --    exactamente su monto (1 a 1) o la suma de las guías del mes (factura
  --    consolidada, p. ej. combustible). Se recalcula desde la factura.
  if v_kind = 'dispatch_guide' then
    select array_agg(document.id) into v_candidates
    from public.received_documents document
    where document.organization_id = v_doc.organization_id
      and private.received_document_supplier_key(document.supplier_tax_id, document.supplier_counterparty_id, document.supplier_name) = v_supplier
      and private.received_document_kind(document.document_type, document.sii_document_type) = 'invoice'
      and v_doc.total_amount > 0
      and abs(document.total_amount - v_doc.total_amount) < 1
      and document.issue_date between v_doc.issue_date - 15 and v_doc.issue_date + 15;
    if coalesce(array_length(v_candidates, 1), 0) = 1
      and not exists (
        select 1 from public.received_document_links existing
        where existing.source_document_id = v_doc.id and existing.link_type = 'dispatch_guide'
      )
    then
      insert into public.received_document_links (
        organization_id, source_document_id, target_document_id, link_type, origin, created_by
      ) values (
        v_doc.organization_id, v_doc.id, v_candidates[1], 'dispatch_guide', 'amount_rule', null
      )
      on conflict do nothing;
    end if;

    -- Los vínculos creados desde la factura (referencia DTE o suma mensual)
    -- se borraron arriba; se reconstruyen recalculando las facturas cercanas.
    if not exists (
      select 1 from public.received_document_links existing
      where existing.source_document_id = v_doc.id and existing.link_type = 'dispatch_guide'
        and existing.status <> 'rejected'
    ) then
      perform private.sync_received_document_links(invoice.id)
      from public.received_documents invoice
      where invoice.organization_id = v_doc.organization_id
        and private.received_document_supplier_key(invoice.supplier_tax_id, invoice.supplier_counterparty_id, invoice.supplier_name) = v_supplier
        and private.received_document_kind(invoice.document_type, invoice.sii_document_type) = 'invoice'
        and invoice.issue_date between v_doc.issue_date and v_doc.issue_date + 45;
    end if;
  end if;

  if v_kind = 'invoice' then
    -- 5a. Resuelve NC/ND o guías que ya citaban este folio antes de que la
    --     factura existiera en el sistema.
    update public.received_document_links link
    set target_document_id = v_doc.id
    from public.received_documents source
    where link.organization_id = v_doc.organization_id
      and link.target_document_id is null
      and link.link_type in ('credit_note', 'debit_note', 'dispatch_guide')
      and link.reference_folio = v_folio
      and source.id = link.source_document_id
      and private.received_document_supplier_key(source.supplier_tax_id, source.supplier_counterparty_id, source.supplier_name) = v_supplier;

    -- 5b. Guías sin vincular del mismo proveedor emitidas en los 45 días previos
    --     cuya suma por mes calendario coincide con el total de esta factura.
    select grouped.guide_ids into v_guides
    from (
      select array_agg(guide.id order by guide.issue_date) as guide_ids, sum(guide.total_amount) as total
      from public.received_documents guide
      where guide.organization_id = v_doc.organization_id
        and private.received_document_supplier_key(guide.supplier_tax_id, guide.supplier_counterparty_id, guide.supplier_name) = v_supplier
        and private.received_document_kind(guide.document_type, guide.sii_document_type) = 'dispatch_guide'
        and guide.total_amount > 0
        and guide.issue_date between v_doc.issue_date - 45 and v_doc.issue_date
        and not exists (
          select 1 from public.received_document_links existing
          where existing.source_document_id = guide.id
            and existing.link_type = 'dispatch_guide'
            and (existing.status <> 'rejected' or existing.target_document_id = v_doc.id)
        )
      group by date_trunc('month', guide.issue_date)
    ) grouped
    where abs(grouped.total - v_doc.total_amount) < 1
      and cardinality(grouped.guide_ids) > 1
    order by cardinality(grouped.guide_ids) desc
    limit 1;

    if coalesce(array_length(v_guides, 1), 0) > 1 then
      insert into public.received_document_links (
        organization_id, source_document_id, target_document_id, link_type, origin, created_by
      )
      select v_doc.organization_id, guide_id, v_doc.id, 'dispatch_guide', 'amount_rule', null
      from unnest(v_guides) as guide_id
      on conflict do nothing;
    end if;
  end if;
end;
$$;

revoke all on function private.sync_received_document_links(uuid) from public;

create or replace function private.sync_received_document_links_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sync_received_document_links(new.id);
  return null;
end;
$$;

create trigger received_documents_sync_links
after insert or update of
  document_number, document_type, notes, sii_references, sii_document_type, sii_folio,
  supplier_tax_id, supplier_counterparty_id, supplier_name, total_amount, issue_date
on public.received_documents
for each row execute function private.sync_received_document_links_trigger();

-- Vinculación manual o confirmación de una sugerencia desde la interfaz.
create or replace function public.link_received_documents(
  p_source_document_id uuid,
  p_target_document_id uuid,
  p_link_type text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_link_id uuid;
begin
  select source.organization_id into v_organization_id
  from public.received_documents source
  join public.received_documents target
    on target.id = p_target_document_id and target.organization_id = source.organization_id
  where source.id = p_source_document_id;
  if v_organization_id is null then
    raise exception 'Documents not found in the same organization';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = v_organization_id
      and membership.user_id = auth.uid()
      and membership.role in ('administrator', 'finance')
  ) then
    raise exception 'Only finance can link documents';
  end if;
  if p_link_type not in ('credit_note', 'debit_note', 'dispatch_guide') then
    raise exception 'Unsupported link type';
  end if;

  -- Un documento hijo apunta a una sola factura por tipo de vínculo.
  update public.received_document_links
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
  where source_document_id = p_source_document_id
    and link_type = p_link_type
    and target_document_id is distinct from p_target_document_id
    and status <> 'rejected';

  insert into public.received_document_links (
    organization_id, source_document_id, target_document_id, link_type,
    origin, status, reviewed_by, reviewed_at
  ) values (
    v_organization_id, p_source_document_id, p_target_document_id, p_link_type,
    'manual', 'confirmed', auth.uid(), now()
  )
  on conflict (source_document_id, link_type, target_document_id)
    where target_document_id is not null
  do update set status = 'confirmed', origin = 'manual',
    reviewed_by = auth.uid(), reviewed_at = now()
  returning id into v_link_id;
  return v_link_id;
end;
$$;

revoke all on function public.link_received_documents(uuid, uuid, text) from public;
grant execute on function public.link_received_documents(uuid, uuid, text) to authenticated;

-- Carga inicial sobre todos los documentos existentes: primero NC/ND y guías
-- (hijos), luego facturas para resolver referencias y agrupar guías del mes.
do $$
declare
  v_document record;
begin
  for v_document in
    select id
    from public.received_documents
    order by
      case private.received_document_kind(document_type, sii_document_type)
        when 'invoice' then 1 else 0
      end,
      issue_date,
      id
  loop
    perform private.sync_received_document_links(v_document.id);
  end loop;
end;
$$;
