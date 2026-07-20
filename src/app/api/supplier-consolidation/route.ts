import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

type ConsolidationBody = {
  organizationId?: unknown;
  canonicalCounterpartyId?: unknown;
  duplicateCounterpartyIds?: unknown;
};

type Supplier = {
  id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string | null;
  kind: string;
};

function displayName(supplier: Supplier) {
  return supplier.trade_name?.trim() || supplier.legal_name;
}

function normalize(value: string) {
  return value
    .toLocaleLowerCase("es-CL")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(spa|ltda|limitada|eirl|sa)$/u, "");
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId))
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const { data, error } = await context.supabase
    .from("counterparties")
    .select("id, legal_name, trade_name, tax_id, kind")
    .eq("organization_id", organizationId)
    .in("kind", ["supplier", "both"])
    .eq("is_active", true)
    .is("merged_into_counterparty_id", null)
    .order("legal_name");
  if (error) return NextResponse.json({ error: "unable_to_load_suppliers" }, { status: 500 });

  const suppliers = (data ?? []) as Supplier[];
  const grouped = new Map<string, Supplier[]>();
  for (const supplier of suppliers) {
    const key = normalize(displayName(supplier));
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), supplier]);
  }
  const candidates = [...grouped.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      key,
      members: members.map((supplier) => ({
        id: supplier.id,
        name: displayName(supplier),
        legalName: supplier.legal_name,
        taxId: supplier.tax_id,
      })),
    }));

  return NextResponse.json({
    suppliers: suppliers.map((supplier) => ({
      id: supplier.id,
      name: displayName(supplier),
      legalName: supplier.legal_name,
      taxId: supplier.tax_id,
    })),
    candidates,
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ConsolidationBody | null;
  const organizationId = body?.organizationId;
  const canonicalCounterpartyId = body?.canonicalCounterpartyId;
  const duplicateCounterpartyIds = Array.isArray(body?.duplicateCounterpartyIds)
    ? body.duplicateCounterpartyIds
    : [];
  if (
    !isUuid(organizationId) ||
    !isUuid(canonicalCounterpartyId) ||
    !duplicateCounterpartyIds.length ||
    !duplicateCounterpartyIds.every(isUuid) ||
    duplicateCounterpartyIds.includes(canonicalCounterpartyId)
  ) return NextResponse.json({ error: "invalid_consolidation" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const { data, error } = await context.supabase.rpc("consolidate_supplier_counterparties", {
    p_organization_id: organizationId,
    p_canonical_counterparty_id: canonicalCounterpartyId,
    p_duplicate_counterparty_ids: [...new Set(duplicateCounterpartyIds)],
  });
  if (error || !data)
    return NextResponse.json({ error: "unable_to_consolidate_suppliers" }, { status: 409 });
  return NextResponse.json({ consolidation: data });
}
