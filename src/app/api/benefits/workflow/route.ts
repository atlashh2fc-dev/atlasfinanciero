import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationProcurementAccess } from "@/lib/admin-access";

const classifications = new Set(["to_review", "eligible", "partial", "not_eligible", "monitoring"]);
const stages = new Set(["new", "collecting_documents", "internal_review", "ready_for_submission", "submitted", "waiting_result", "awarded", "not_selected", "withdrawn"]);
const documentStatuses = new Set(["not_started", "collecting", "complete", "observed", "not_required"]);

function text(value: unknown, maxLength: number) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && value.trim().length <= maxLength ? value.trim() : undefined;
}

function legacyStatus(stage: string) {
  if (stage === "ready_for_submission") return "ready_for_submission";
  if (stage === "submitted" || stage === "waiting_result") return "submitted";
  if (stage === "awarded") return "awarded";
  if (stage === "not_selected") return "not_selected";
  if (stage === "withdrawn") return "withdrawn";
  return "preparing";
}

async function workflowContext(organizationId: string | null) {
  if (!isUuid(organizationId)) return { error: "invalid_organization" as const, status: 400, supabase: null, user: null, membership: null };
  const context = await requireOrganizationProcurementAccess(organizationId);
  if (context.membership && !["administrator", "finance", "data_entry"].includes(context.membership.role)) return { error: "benefits_workflow_access_required" as const, status: 403, supabase: null, user: null, membership: null };
  return context;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const context = await workflowContext(organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });

  const [applicationsResult, eventsResult] = await Promise.all([
    context.supabase.from("benefits_applications").select("id, program_name, institution, official_url, status, responsible_name, classification, workflow_stage, document_status, deadline, notes, last_activity_at, updated_at").eq("organization_id", organizationId).order("last_activity_at", { ascending: false }),
    context.supabase.from("benefits_application_events").select("id, application_id, event_type, note, snapshot, created_at").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(100),
  ]);
  if (applicationsResult.error || eventsResult.error) return NextResponse.json({ error: "benefits_workflow_not_available" }, { status: 409 });
  return NextResponse.json({ applications: applicationsResult.data ?? [], events: eventsResult.data ?? [], role: context.membership?.role ?? null, currentUserId: context.user.id });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const applicationId = body?.applicationId;
  const context = await workflowContext(organizationId as string | null);
  if (context.error || !context.supabase || !context.user || !isUuid(organizationId) || !isUuid(applicationId)) return NextResponse.json({ error: context.error ?? "invalid_benefits_workflow" }, { status: context.status || 400 });

  const classification = body?.classification;
  const workflowStage = body?.workflowStage;
  const documentStatus = body?.documentStatus;
  const responsibleName = text(body?.responsibleName, 160);
  const note = text(body?.note, 2000);
  if (typeof classification !== "string" || !classifications.has(classification) || typeof workflowStage !== "string" || !stages.has(workflowStage) || typeof documentStatus !== "string" || !documentStatuses.has(documentStatus) || responsibleName === undefined || note === undefined) return NextResponse.json({ error: "invalid_benefits_workflow" }, { status: 400 });

  const now = new Date().toISOString();
  const update = {
    responsible_name: responsibleName,
    classification,
    workflow_stage: workflowStage,
    document_status: documentStatus,
    status: legacyStatus(workflowStage),
    last_activity_at: now,
  };
  const { error } = await context.supabase.from("benefits_applications").update(update).eq("id", applicationId).eq("organization_id", organizationId);
  if (error) return NextResponse.json({ error: "unable_to_update_benefits_workflow" }, { status: 409 });
  const { error: eventError } = await context.supabase.from("benefits_application_events").insert({ organization_id: organizationId, application_id: applicationId, note, snapshot: { ...update } });
  if (eventError) return NextResponse.json({ error: "unable_to_record_benefits_workflow" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
