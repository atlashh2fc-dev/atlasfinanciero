import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const writeRoles = new Set(["administrator", "finance", "operations"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function readText(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length <= maxLength ? text || null : undefined;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { data, error } = await supabase
    .from("collection_followups")
    .select("id, organization_id, issued_document_id, status, responsible_name, next_action_on, promised_payment_date, note, created_at, updated_at")
    .eq("organization_id", organizationId)
    .order("next_action_on", { ascending: true, nullsFirst: false });
  if (error) return NextResponse.json({ error: "unable_to_load_collection_followups" }, { status: 500 });

  return NextResponse.json({ followups: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  const issuedDocumentId = body && typeof body === "object" ? (body as { issuedDocumentId?: unknown }).issuedDocumentId : null;
  const status = body && typeof body === "object" ? (body as { status?: unknown }).status : null;
  const responsibleName = body && typeof body === "object" ? readText((body as { responsibleName?: unknown }).responsibleName, 180) : null;
  const nextActionOn = body && typeof body === "object" ? readDate((body as { nextActionOn?: unknown }).nextActionOn) : null;
  const promisedPaymentDate = body && typeof body === "object" ? readDate((body as { promisedPaymentDate?: unknown }).promisedPaymentDate) : null;
  const note = body && typeof body === "object" ? readText((body as { note?: unknown }).note, 2000) : null;

  if (!isUuid(organizationId) || !isUuid(issuedDocumentId) || !["open", "committed", "resolved"].includes(typeof status === "string" ? status : "") || responsibleName === undefined || note === undefined) {
    return NextResponse.json({ error: "invalid_collection_followup" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { data: membership, error: membershipError } = await supabase
    .from("organization_memberships")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) return NextResponse.json({ error: "unable_to_read_membership" }, { status: 500 });
  if (!membership || !writeRoles.has(membership.role)) return NextResponse.json({ error: "collection_write_not_authorized" }, { status: 403 });

  const { data: document, error: documentError } = await supabase
    .from("issued_documents")
    .select("id")
    .eq("id", issuedDocumentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (documentError) return NextResponse.json({ error: "unable_to_read_document" }, { status: 500 });
  if (!document) return NextResponse.json({ error: "document_not_found" }, { status: 404 });

  const { data, error } = await supabase
    .from("collection_followups")
    .upsert({
      organization_id: organizationId,
      issued_document_id: issuedDocumentId,
      status,
      responsible_name: responsibleName,
      next_action_on: nextActionOn,
      promised_payment_date: promisedPaymentDate,
      note,
    }, { onConflict: "issued_document_id" })
    .select("id, organization_id, issued_document_id, status, responsible_name, next_action_on, promised_payment_date, note, created_at, updated_at")
    .single();
  if (error) return NextResponse.json({ error: "unable_to_save_collection_followup" }, { status: 500 });

  return NextResponse.json({ followup: data });
}
