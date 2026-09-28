-- Limpieza de fichas duplicadas (idempotente; sin UUID fijos).
--
-- La importación del pre-pipeline (20260723114000) creó clientes sólo con
-- nombre ("Bodenor", "Braincorp"…) para empresas que ya tenían ficha con RUT.
-- Aquí se fusionan en su ficha con RUT mediante public.merge_counterparties,
-- que mueve oportunidades, documentos y cualquier otra FK, deja la duplicada
-- inactiva como alias auditable y une los roles (People Work y Siptel eran
-- proveedores con RUT y quedan como cliente y proveedor).
--
-- Además se vinculan documentos sin ficha por RUT normalizado y se deja el RUT
-- en formato canónico "12345678-K" cuando es válido.
--
-- Decisiones del usuario incluidas: "Barba - Hernan" se fusiona en "Barba
-- Abogado"; "Factoring" y "Remuneraciones" no son empresas y se desactivan
-- (Remuneraciones pierde el RUT ficticio 11111111; sus cuentas por pagar de
-- finiquitos conservan el vínculo); APORTA, NUNEZ & HIJOS y V Y M LIMITADA
-- pasan de both a customer. V Y M LIMITADA / V Y M SPA NO se fusionan.

-- 1. Duplicadas sólo con nombre → ficha con RUT ------------------------------
do $$
declare
  v_pair record;
  v_result jsonb;
begin
  for v_pair in
    with targets (duplicate_name, canonical_tax_key) as (
      values
        ('bodenor', '995932008'),        -- BODENOR FLEX CENTER SA
        ('braincorp', '771078893'),      -- BRAINCORP OP SPA
        ('ggelectrics', '768593132'),    -- GG Electric (76.859.313-2)
        ('linksolutions', '777374451'),  -- GRUPO LS SPA
        ('peoplework', '776151165'),     -- PEOPLEWORK SPA
        ('siptel', '760766267')          -- SIPTEL CHILE SA
    )
    select
      canonical.organization_id,
      canonical.id as canonical_id,
      array_agg(duplicate.id order by duplicate.created_at) as duplicate_ids
    from targets
    join public.counterparties canonical
      on canonical.normalized_tax_id = targets.canonical_tax_key
     and canonical.merged_into_counterparty_id is null
     and canonical.is_active
    join public.counterparties duplicate
      on duplicate.organization_id = canonical.organization_id
     and duplicate.id <> canonical.id
     and regexp_replace(lower(btrim(duplicate.legal_name)), '[^[:alnum:]]+', '', 'g') = targets.duplicate_name
     and duplicate.normalized_tax_id is null
     and duplicate.merged_into_counterparty_id is null
     and duplicate.kind in ('customer', 'client')
    group by canonical.organization_id, canonical.id
  loop
    v_result := public.merge_counterparties(
      v_pair.organization_id, v_pair.canonical_id, v_pair.duplicate_ids, 'customer_consolidation'
    );
    raise notice 'Fusión de fichas: %', v_result;
  end loop;
end;
$$;

-- 1b. "Barba - Hernan" y "Barba Abogado" son la misma persona -------------
do $$
declare
  v_pair record;
begin
  for v_pair in
    select canonical.organization_id, canonical.id as canonical_id, array_agg(duplicate.id) as duplicate_ids
    from public.counterparties canonical
    join public.counterparties duplicate
      on duplicate.organization_id = canonical.organization_id
     and regexp_replace(lower(btrim(duplicate.legal_name)), '[^[:alnum:]]+', '', 'g') = 'barbahernan'
     and duplicate.normalized_tax_id is null
     and duplicate.merged_into_counterparty_id is null
    where regexp_replace(lower(btrim(canonical.legal_name)), '[^[:alnum:]]+', '', 'g') = 'barbaabogado'
      and canonical.merged_into_counterparty_id is null
      and canonical.is_active
    group by canonical.organization_id, canonical.id
  loop
    raise notice 'Fusión de fichas: %', public.merge_counterparties(
      v_pair.organization_id, v_pair.canonical_id, v_pair.duplicate_ids, 'customer_consolidation'
    );
  end loop;
end;
$$;

-- 1c. Fichas que no son empresas ------------------------------------------
-- "Factoring" (cliente sin RUT del pre-pipeline): se desactiva; su
-- oportunidad comercial queda vinculada.
update public.counterparties
set is_active = false
where regexp_replace(lower(btrim(legal_name)), '[^[:alnum:]]+', '', 'g') = 'factoring'
  and normalized_tax_id is null
  and kind = 'customer'
  and merged_into_counterparty_id is null
  and is_active;

-- "Remuneraciones" (trade name "Finiquitos") es una cuenta de gasto, no un
-- proveedor: sin RUT ficticio y desactivada. Sus cuentas por pagar ya
-- aprobadas conservan la ficha y el nombre, y se pueden pagar igual.
update public.counterparties
set tax_id = null,
    is_active = false
where lower(btrim(legal_name)) = 'remuneraciones'
  and normalized_tax_id = '11111111'
  and kind = 'supplier'
  and merged_into_counterparty_id is null;

-- 2. Documentos sin ficha: se vinculan por RUT normalizado -------------------
update public.received_documents document
set supplier_counterparty_id = counterparty.id
from public.counterparties counterparty
where document.supplier_counterparty_id is null
  and counterparty.organization_id = document.organization_id
  and counterparty.merged_into_counterparty_id is null
  and counterparty.normalized_tax_id
    = nullif(upper(regexp_replace(coalesce(document.supplier_tax_id, ''), '[^0-9kK]', '', 'g')), '');

update public.issued_documents document
set counterparty_id = counterparty.id
from public.counterparties counterparty
where document.counterparty_id is null
  and counterparty.organization_id = document.organization_id
  and counterparty.merged_into_counterparty_id is null
  and counterparty.normalized_tax_id
    = nullif(upper(regexp_replace(coalesce(document.recipient_tax_id, ''), '[^0-9kK]', '', 'g')), '');

-- Una ficha con documentos del otro rol suma ese rol (nunca se degrada).
update public.counterparties counterparty
set kind = 'both'
where counterparty.merged_into_counterparty_id is null
  and (
    (counterparty.kind = 'customer' and exists (
      select 1 from public.received_documents document
      where document.supplier_counterparty_id = counterparty.id
    ))
    or (counterparty.kind = 'supplier' and exists (
      select 1 from public.issued_documents document
      where document.counterparty_id = counterparty.id
    ))
  );

-- Clientes que figuraban como cliente y proveedor sin serlo (decisión del
-- usuario). Va después de la suma de roles por documentos; ninguno tiene
-- documentos recibidos, así que no se vuelve a promover.
update public.counterparties
set kind = 'customer'
where kind = 'both'
  and merged_into_counterparty_id is null
  and normalized_tax_id in ('762659948', '760976601', '768594732');

-- 3. RUT en formato canónico -------------------------------------------------
-- Sólo RUT con dígito verificador válido ("Remuneraciones" 11111111 queda
-- igual) y sin chocar con otra ficha o documento equivalente.
update public.counterparties counterparty
set tax_id = private.format_rut(counterparty.tax_id)
where private.format_rut(counterparty.tax_id) is not null
  and counterparty.tax_id is distinct from private.format_rut(counterparty.tax_id)
  and not exists (
    select 1 from public.counterparties other
    where other.organization_id = counterparty.organization_id
      and other.id <> counterparty.id
      and other.merged_into_counterparty_id is null
      and other.normalized_tax_id = replace(private.format_rut(counterparty.tax_id), '-', '')
  );

update public.received_documents document
set supplier_tax_id = private.format_rut(document.supplier_tax_id)
where private.format_rut(document.supplier_tax_id) is not null
  and document.supplier_tax_id is distinct from private.format_rut(document.supplier_tax_id)
  and not exists (
    select 1 from public.received_documents other
    where other.organization_id = document.organization_id
      and other.id <> document.id
      and other.supplier_tax_id = private.format_rut(document.supplier_tax_id)
      and other.sii_document_type is not distinct from document.sii_document_type
      and other.sii_folio is not distinct from document.sii_folio
  );

update public.issued_documents document
set recipient_tax_id = private.format_rut(document.recipient_tax_id)
where private.format_rut(document.recipient_tax_id) is not null
  and document.recipient_tax_id is distinct from private.format_rut(document.recipient_tax_id);
