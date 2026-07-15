import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationExpenseReadAccess,
  requireOrganizationFinanceAccess,
} from "@/lib/admin-access";

const taskStatuses = ["pending", "completed", "not_applicable"] as const;
const periodStatuses = ["open", "soft_closed", "closed", "locked"] as const;

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function monthEnd(periodStart: string) {
  const start = new Date(`${periodStart}T00:00:00Z`);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const [periodsResult, tasksResult, eventsResult, entriesResult, issuedResult, receivedResult, bankResult] = await Promise.all([
    context.supabase.from("financial_periods")
      .select("id, period_start, period_end, status, closed_at, closed_by, notes, created_at, updated_at")
      .eq("organization_id", organizationId).order("period_start", { ascending: false }).limit(36),
    context.supabase.from("financial_period_close_tasks")
      .select("id, financial_period_id, task_code, title, description, status, evidence_note, completed_at, completed_by, updated_at")
      .eq("organization_id", organizationId).order("task_code"),
    context.supabase.from("financial_period_close_events")
      .select("id, financial_period_id, from_status, to_status, reason, actor_id, created_at")
      .eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(100),
    context.supabase.from("accounting_entries")
      .select("id, financial_period_id, status").eq("organization_id", organizationId).limit(1_000),
    context.supabase.from("issued_documents")
      .select("id, issue_date, total_amount").eq("organization_id", organizationId).not("issue_date", "is", null).limit(2_000),
    context.supabase.from("received_documents")
      .select("id, issue_date, total_amount").eq("organization_id", organizationId).limit(2_000),
    context.supabase.from("bank_transactions")
      .select("id, booked_on, reconciliation_status").eq("organization_id", organizationId).limit(2_000),
  ]);

  if (periodsResult.error || tasksResult.error || eventsResult.error || entriesResult.error || issuedResult.error || receivedResult.error || bankResult.error) {
    return NextResponse.json({ error: "unable_to_load_financial_close" }, { status: 500 });
  }

  return NextResponse.json({
    role: context.user ? (await context.supabase.from("organization_memberships").select("role").eq("organization_id", organizationId).eq("user_id", context.user.id).single()).data?.role ?? null : null,
    periods: periodsResult.data ?? [],
    tasks: tasksResult.data ?? [],
    events: eventsResult.data ?? [],
    entries: entriesResult.data ?? [],
    issuedDocuments: issuedResult.data ?? [],
    receivedDocuments: receivedResult.data ?? [],
    bankTransactions: bankResult.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  if (!isUuid(organizationId) || typeof body?.action !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  if (body.action === "create_period") {
    if (!isDate(body.periodStart) || body.periodStart.slice(8) !== "01") return NextResponse.json({ error: "period_must_start_on_first_day" }, { status: 400 });
    const { data, error } = await context.supabase.from("financial_periods").insert({
      organization_id: organizationId,
      period_start: body.periodStart,
      period_end: monthEnd(body.periodStart),
      notes: typeof body.notes === "string" && body.notes.trim().length <= 2_000 ? body.notes.trim() || null : null,
    }).select("id, period_start, period_end, status").single();
    if (error || !data) return NextResponse.json({ error: "unable_to_create_financial_period" }, { status: 409 });
    return NextResponse.json({ period: data }, { status: 201 });
  }

  if (body.action === "update_task") {
    if (!isUuid(body.taskId) || !taskStatuses.includes(body.status as typeof taskStatuses[number])) return NextResponse.json({ error: "invalid_close_task" }, { status: 400 });
    const evidenceNote = typeof body.evidenceNote === "string" ? body.evidenceNote.trim() : "";
    if (evidenceNote.length > 2_000) return NextResponse.json({ error: "evidence_note_too_long" }, { status: 400 });
    const { data, error } = await context.supabase.from("financial_period_close_tasks")
      .update({ status: body.status, evidence_note: evidenceNote || null })
      .eq("id", body.taskId).eq("organization_id", organizationId)
      .select("id, status, evidence_note, completed_at, completed_by").single();
    if (error || !data) return NextResponse.json({ error: "unable_to_update_close_task" }, { status: 409 });
    return NextResponse.json({ task: data });
  }

  if (body.action === "transition") {
    if (!isUuid(body.periodId) || !periodStatuses.includes(body.targetStatus as typeof periodStatuses[number])) return NextResponse.json({ error: "invalid_period_transition" }, { status: 400 });
    const reason = typeof body.reason === "string" ? body.reason.trim() : null;
    if (reason && reason.length > 2_000) return NextResponse.json({ error: "reason_too_long" }, { status: 400 });
    const { data, error } = await context.supabase.rpc("transition_financial_period", {
      p_financial_period_id: body.periodId,
      p_target_status: body.targetStatus,
      p_reason: reason || null,
    });
    if (error || !data) return NextResponse.json({ error: "unable_to_transition_financial_period", detail: error?.message ?? null }, { status: 409 });
    return NextResponse.json({ period: data });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
