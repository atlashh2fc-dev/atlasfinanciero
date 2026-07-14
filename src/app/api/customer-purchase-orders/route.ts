import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const writeRoles = new Set(["administrator", "finance", "operations"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function text(value: unknown, maxLength: number, required = false) {
  if (value === null || value === undefined) return required ? null : null;
  if (typeof value !== "string") return null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function date(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function amount(value: unknown) {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

async function authorizedOrganization(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: unknown, userId: string, write = false) {
  if (!isUuid(organizationId)) return null;
  const { data, error } = await supabase.from("organization_memberships").select("organization_id, role").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
  if (error || !data || (write && !writeRoles.has(data.role))) return null;
  return data.organization_id;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const organizationId = await authorizedOrganization(supabase, request.nextUrl.searchParams.get("organizationId"), user.id);
  if (!organizationId) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const [{ data: purchaseOrders, error: ordersError }, { data: allocations, error: allocationsError }] = await Promise.all([
    supabase.from("customer_purchase_orders").select("id, purchase_order_number, customer_name, customer_tax_id, received_date, valid_until, net_amount, currency_code, notes, status").eq("organization_id", organizationId).order("received_date", { ascending: false }),
    supabase.from("customer_purchase_order_billings").select("id, purchase_order_id, issued_document_id, allocated_net_amount, created_at").eq("organization_id", organizationId).order("created_at", { ascending: false }),
  ]);
  if (ordersError || allocationsError) return NextResponse.json({ error: "unable_to_load_purchase_orders" }, { status: 500 });
  return NextResponse.json({ purchaseOrders: purchaseOrders ?? [], allocations: allocations ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = await authorizedOrganization(supabase, body?.organizationId, user.id, true);
  if (!organizationId) return NextResponse.json({ error: "organization_write_not_authorized" }, { status: 403 });

  if (body?.action === "purchase_order") {
    const purchaseOrderNumber = text(body.purchaseOrderNumber, 100, true);
    const customerName = text(body.customerName, 180, true);
    const receivedDate = date(body.receivedDate);
    const netAmount = amount(body.netAmount);
    if (!purchaseOrderNumber || !customerName || !receivedDate || !netAmount) return NextResponse.json({ error: "invalid_purchase_order" }, { status: 400 });
    const { data, error } = await supabase.from("customer_purchase_orders").insert({ organization_id: organizationId, purchase_order_number: purchaseOrderNumber, customer_name: customerName, customer_tax_id: text(body.customerTaxId, 40), received_date: receivedDate, valid_until: body.validUntil ? date(body.validUntil) : null, net_amount: netAmount, currency_code: "CLP", notes: text(body.notes, 2_000) }).select("id").single();
    if (error || !data) return NextResponse.json({ error: "unable_to_create_purchase_order" }, { status: 409 });
    return NextResponse.json({ id: data.id }, { status: 201 });
  }

  if (body?.action === "allocation") {
    const purchaseOrderId = body.purchaseOrderId;
    const issuedDocumentId = body.issuedDocumentId;
    const allocatedNetAmount = amount(body.allocatedNetAmount);
    if (!isUuid(purchaseOrderId) || !isUuid(issuedDocumentId) || !allocatedNetAmount) return NextResponse.json({ error: "invalid_purchase_order_allocation" }, { status: 400 });
    const [{ data: order }, { data: document }, { data: currentAllocations }] = await Promise.all([
      supabase.from("customer_purchase_orders").select("id, net_amount, status").eq("id", purchaseOrderId).eq("organization_id", organizationId).maybeSingle(),
      supabase.from("issued_documents").select("id, document_type, net_amount").eq("id", issuedDocumentId).eq("organization_id", organizationId).maybeSingle(),
      supabase.from("customer_purchase_order_billings").select("allocated_net_amount").eq("purchase_order_id", purchaseOrderId).eq("organization_id", organizationId),
    ]);
    const documentType = (document?.document_type ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const allocatedSoFar = (currentAllocations ?? []).reduce((total, item) => total + Number(item.allocated_net_amount ?? 0), 0);
    if (!order || order.status !== "open" || !document || !documentType.includes("factura") || documentType.includes("nota de credito") || allocatedNetAmount > Number(document.net_amount ?? 0) || allocatedSoFar + allocatedNetAmount > Number(order.net_amount)) return NextResponse.json({ error: "allocation_exceeds_available_balance" }, { status: 400 });
    const { error } = await supabase.from("customer_purchase_order_billings").insert({ organization_id: organizationId, purchase_order_id: purchaseOrderId, issued_document_id: issuedDocumentId, allocated_net_amount: allocatedNetAmount });
    if (error) return NextResponse.json({ error: "unable_to_allocate_purchase_order" }, { status: 409 });
    return NextResponse.json({ allocated: true }, { status: 201 });
  }

  return NextResponse.json({ error: "unsupported_purchase_order_action" }, { status: 400 });
}
