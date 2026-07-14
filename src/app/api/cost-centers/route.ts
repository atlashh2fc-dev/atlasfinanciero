import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

type Action = "create_center" | "assign_worker" | "link_customer";

function bodyValue(body: unknown, key: string) {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : null;
}

function validDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function percentage(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
  const supabase = context.supabase;
  const [centersResult, peopleResult, customersResult, assignmentsResult, linksResult] = await Promise.all([
    supabase.from("cost_centers").select("id, code, name, is_active").eq("organization_id", organizationId).order("code"),
    supabase.from("payroll_people").select("id, full_name, is_active").eq("organization_id", organizationId).eq("provider", "peoplework").order("full_name"),
    supabase.from("counterparties").select("id, legal_name, trade_name, tax_id").eq("organization_id", organizationId).in("kind", ["customer", "both"]).eq("is_active", true).order("legal_name"),
    supabase.from("payroll_person_cost_center_assignments").select("id, person_id, cost_center_id, allocation_percentage, effective_from, effective_to").eq("organization_id", organizationId).order("effective_from", { ascending: false }),
    supabase.from("cost_center_customer_links").select("id, cost_center_id, counterparty_id, allocation_percentage, effective_from, effective_to").eq("organization_id", organizationId).order("effective_from", { ascending: false }),
  ]);
  if (centersResult.error || peopleResult.error || customersResult.error || assignmentsResult.error || linksResult.error) return NextResponse.json({ error: "unable_to_load_cost_centers" }, { status: 500 });
  return NextResponse.json({ centers: centersResult.data ?? [], people: peopleResult.data ?? [], customers: customersResult.data ?? [], assignments: assignmentsResult.data ?? [], customerLinks: linksResult.data ?? [] });
}

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const organizationId = bodyValue(body, "organizationId");
  const action = bodyValue(body, "action");
  if (!isUuid(organizationId) || typeof action !== "string" || !["create_center", "assign_worker", "link_customer"].includes(action)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
  const supabase = context.supabase;

  if ((action as Action) === "create_center") {
    const code = bodyValue(body, "code"); const name = bodyValue(body, "name");
    if (typeof code !== "string" || !code.trim() || code.trim().length > 40 || typeof name !== "string" || !name.trim() || name.trim().length > 160) return NextResponse.json({ error: "invalid_center" }, { status: 400 });
    const { data, error } = await supabase.from("cost_centers").insert({ organization_id: organizationId, code: code.trim().toUpperCase(), name: name.trim() }).select("id, code, name, is_active").single();
    if (error) return NextResponse.json({ error: "unable_to_create_center" }, { status: 422 });
    return NextResponse.json({ center: data }, { status: 201 });
  }

  const costCenterId = bodyValue(body, "costCenterId");
  const allocationPercentage = percentage(bodyValue(body, "allocationPercentage"));
  const effectiveFrom = validDate(bodyValue(body, "effectiveFrom"));
  const effectiveTo = bodyValue(body, "effectiveTo") ? validDate(bodyValue(body, "effectiveTo")) : null;
  if (!isUuid(costCenterId) || allocationPercentage === null || !effectiveFrom || (bodyValue(body, "effectiveTo") && !effectiveTo) || (effectiveTo && effectiveTo < effectiveFrom)) return NextResponse.json({ error: "invalid_assignment" }, { status: 400 });

  if ((action as Action) === "assign_worker") {
    const personId = bodyValue(body, "personId");
    if (!isUuid(personId)) return NextResponse.json({ error: "invalid_person" }, { status: 400 });
    const { error } = await supabase.from("payroll_person_cost_center_assignments").insert({ organization_id: organizationId, person_id: personId, cost_center_id: costCenterId, allocation_percentage: allocationPercentage, effective_from: effectiveFrom, effective_to: effectiveTo });
    if (error) return NextResponse.json({ error: "unable_to_assign_worker" }, { status: 422 });
    return NextResponse.json({ assigned: true }, { status: 201 });
  }

  const counterpartyId = bodyValue(body, "counterpartyId");
  if (!isUuid(counterpartyId)) return NextResponse.json({ error: "invalid_customer" }, { status: 400 });
  const { error } = await supabase.from("cost_center_customer_links").insert({ organization_id: organizationId, cost_center_id: costCenterId, counterparty_id: counterpartyId, allocation_percentage: allocationPercentage, effective_from: effectiveFrom, effective_to: effectiveTo });
  if (error) return NextResponse.json({ error: "unable_to_link_customer" }, { status: 422 });
  return NextResponse.json({ linked: true }, { status: 201 });
}
