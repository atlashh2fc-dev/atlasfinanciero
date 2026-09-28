// Alta de fichas de clientes/proveedores por RUT. Una misma empresa puede ser
// cliente y proveedor: la ficha es única por RUT normalizado y el rol se suma
// ("both"), nunca se reemplaza ni se degrada.
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalTaxId, rutKey } from "@/lib/rut";

export type CounterpartyRole = "customer" | "supplier";
export type CounterpartyKind = CounterpartyRole | "both";

export type CounterpartyByRut = {
  id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string | null;
  kind: CounterpartyKind;
  is_active: boolean;
};

export function unionKind(current: string | null | undefined, role: CounterpartyRole): CounterpartyKind {
  if (current === "both") return "both";
  const normalized = current === "client" ? "customer" : current;
  return normalized && normalized !== role && (normalized === "customer" || normalized === "supplier") ? "both" : role;
}

/**
 * Crea la ficha o suma el rol a la existente con el mismo RUT normalizado
 * (RPC public.upsert_counterparty_role). Nunca sobrescribe nombres.
 */
export async function upsertCounterpartyRole(
  client: SupabaseClient,
  organizationId: string,
  taxId: string,
  legalName: string,
  role: CounterpartyRole,
) {
  const { data, error } = await client.rpc("upsert_counterparty_role", {
    p_organization_id: organizationId,
    p_tax_id: canonicalTaxId(taxId),
    p_legal_name: legalName.trim(),
    p_role: role,
  });
  return { id: typeof data === "string" ? data : null, error };
}

/** Ficha vigente (no consolidada) con el mismo RUT normalizado, sin importar su rol. */
export async function findCounterpartyByRut(client: SupabaseClient, organizationId: string, taxId: string | null | undefined) {
  const key = rutKey(taxId);
  if (!key) return { data: null as CounterpartyByRut | null, error: null };
  const { data, error } = await client
    .from("counterparties")
    .select("id, legal_name, trade_name, tax_id, kind, is_active")
    .eq("organization_id", organizationId)
    .eq("normalized_tax_id", key)
    .is("merged_into_counterparty_id", null)
    .maybeSingle();
  return { data: (data as CounterpartyByRut | null) ?? null, error };
}

/**
 * Para sincronizaciones del SII (cliente de servicio): registra el rol y, si
 * la RPC falla, al menos reutiliza la ficha existente por RUT para no dejar
 * documentos huérfanos. El error siempre se registra.
 */
export async function syncCounterpartyRole(
  admin: SupabaseClient,
  organizationId: string,
  taxId: string,
  name: string | null | undefined,
  role: CounterpartyRole,
) {
  const legalName = name?.trim() || canonicalTaxId(taxId) || taxId;
  const { id, error } = await upsertCounterpartyRole(admin, organizationId, taxId, legalName, role);
  if (id) return id;
  console.error("No fue posible registrar la ficha del SII", { role, error });
  const { data: existing } = await findCounterpartyByRut(admin, organizationId, taxId);
  return existing?.id ?? null;
}
