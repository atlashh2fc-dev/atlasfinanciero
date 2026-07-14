import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const availableStatuses = ["ready", "issued", "skipped"] as const;
type CycleStatus = typeof availableStatuses[number];

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: NextRequest, context: { params: Promise<{ cycleId: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { cycleId } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  const status = body && typeof body === "object" ? (body as { status?: unknown }).status : null;
  const issuedDocumentId = body && typeof body === "object" ? (body as { issuedDocumentId?: unknown }).issuedDocumentId : null;
  if (!isUuid(cycleId) || !availableStatuses.includes(status as CycleStatus) || (status === "issued" && !isUuid(issuedDocumentId))) {
    return NextResponse.json({ error: "invalid_cycle_status" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const update = status === "issued"
    ? { status, issued_document_id: issuedDocumentId, issued_at: now, ready_at: now, completed_by: user.id }
    : status === "ready"
      ? { status, ready_at: now, completed_by: user.id }
      : { status, completed_by: user.id };

  const { data, error } = await supabase
    .from("billing_cycles")
    .update(update)
    .eq("id", cycleId)
    .select("id, status, ready_at, issued_at, issued_document_id")
    .single();

  if (error) return NextResponse.json({ error: "unable_to_update_billing_cycle" }, { status: 403 });
  return NextResponse.json({ cycle: data });
}
