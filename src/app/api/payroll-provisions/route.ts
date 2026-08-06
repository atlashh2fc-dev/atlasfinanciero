import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationExpenseReadAccess,
  requireOrganizationFinanceAccess,
} from "@/lib/admin-access";
import {
  calculatePercentageAmount,
  payrollProvisionCategories,
  payrollProvisionTotal,
  summarizePayrollProvision,
} from "@/lib/payroll-provisions";

export const dynamic = "force-dynamic";

const categorySet = new Set<string>(payrollProvisionCategories);
const directionSet = new Set(["add", "deduct"]);
const calculationSet = new Set(["fixed", "percentage"]);

function isDate(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isPeriodMonth(value: unknown): value is string {
  return isDate(value) && value.endsWith("-01");
}

function cleanText(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if ((!result && required) || result.length > maxLength) return null;
  return result || null;
}

function positiveNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function asNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type ProvisionLine = {
  id: string;
  revision_id: string;
  source_type: "peoplework" | "manual";
  category: string;
  label: string;
  calculation_method: "source" | "fixed" | "percentage";
  direction: "add" | "deduct";
  calculation_rate: number | string | null;
  calculation_base: number | string | null;
  amount: number | string;
  cost_center_id: string | null;
  source_cost_center_code: string | null;
  source_cost_center_name: string | null;
  notes: string | null;
  created_at: string;
};

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const periodMonth = request.nextUrl.searchParams.get("periodMonth");
  if (!isUuid(organizationId) || !isPeriodMonth(periodMonth)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  const [provisionResult, centersResult, payrollResult, contractualSnapshotResult, membershipResult] = await Promise.all([
    context.supabase
      .from("payroll_provisions")
      .select("id, period_month, status, currency_code, posted_amount, actual_amount, actual_refreshed_at, reconciliation_entry_id, reconciled_at, notes, created_at, updated_at")
      .eq("organization_id", organizationId)
      .eq("period_month", periodMonth)
      .maybeSingle(),
    context.supabase
      .from("cost_centers")
      .select("id, code, name")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("code"),
    context.supabase
      .from("payroll_cost_lines")
      .select("sync_run_id, amount, data_basis, cost_center_code, cost_center_name")
      .eq("organization_id", organizationId)
      .eq("period_month", periodMonth),
    context.supabase
      .from("payroll_contractual_snapshots")
      .select("current_sync_run_id")
      .eq("organization_id", organizationId)
      .eq("fiscal_year", Number(periodMonth.slice(0, 4)))
      .maybeSingle(),
    context.supabase
      .from("organization_memberships")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", context.user?.id ?? "")
      .maybeSingle(),
  ]);
  if (provisionResult.error || centersResult.error || payrollResult.error || contractualSnapshotResult.error || membershipResult.error) {
    return NextResponse.json({ error: "unable_to_load_payroll_provision" }, { status: 500 });
  }

  const officialLines = (payrollResult.data ?? []).filter((line) => line.data_basis === "official_payroll");
  const officialActual = officialLines.length
    ? officialLines.reduce((total, line) => total + asNumber(line.amount), 0)
    : null;
  const contractualSourceTotal = (payrollResult.data ?? [])
    .filter((line) => line.data_basis === "contractual_estimate" && line.sync_run_id === contractualSnapshotResult.data?.current_sync_run_id)
    .reduce((total, line) => total + asNumber(line.amount), 0);
  const centerIdByCode = new Map((centersResult.data ?? []).map((center) => [center.code.trim().toLocaleUpperCase("es-CL"), center.id]));
  const officialActualLines = officialLines.map((line) => ({
    costCenterId: line.cost_center_code ? centerIdByCode.get(line.cost_center_code.trim().toLocaleUpperCase("es-CL")) ?? null : null,
    costCenterCode: line.cost_center_code,
    costCenterName: line.cost_center_name,
    amount: asNumber(line.amount),
  }));

  const provision = provisionResult.data;
  if (!provision) {
    return NextResponse.json({
      provision: null,
      revisions: [],
      currentRevision: null,
      workingRevision: null,
      lastPostedRevision: null,
      sourceIsStale: false,
      centers: centersResult.data ?? [],
      officialActual,
      officialActualLines,
      contractualSourceTotal,
      reportedLaborCost: officialActual === null ? null : { amount: officialActual, basis: "official" },
      comparison: null,
      canManage: ["administrator", "finance"].includes(membershipResult.data?.role ?? ""),
    });
  }

  const revisionsResult = await context.supabase
    .from("payroll_provision_revisions")
      .select("id, provision_id, as_of_date, status, total_amount, accounting_delta, accounting_entry_id, source_refreshed_at, source_sync_run_id, posted_at, notes, created_at, updated_at")
    .eq("organization_id", organizationId)
    .eq("provision_id", provision.id)
    .order("as_of_date", { ascending: false });
  if (revisionsResult.error) {
    return NextResponse.json({ error: "unable_to_load_payroll_provision_revisions" }, { status: 500 });
  }

  const revisionIds = (revisionsResult.data ?? []).map((revision) => revision.id);
  const linesResult = revisionIds.length
    ? await context.supabase
      .from("payroll_provision_lines")
      .select("id, revision_id, source_type, category, label, calculation_method, direction, calculation_rate, calculation_base, amount, cost_center_id, source_cost_center_code, source_cost_center_name, notes, created_at")
      .eq("organization_id", organizationId)
      .in("revision_id", revisionIds)
      .order("source_type", { ascending: false })
      .order("created_at")
    : { data: [], error: null };
  if (linesResult.error) {
    return NextResponse.json({ error: "unable_to_load_payroll_provision_lines" }, { status: 500 });
  }

  const linesByRevision = new Map<string, ProvisionLine[]>();
  for (const line of (linesResult.data ?? []) as ProvisionLine[]) {
    const current = linesByRevision.get(line.revision_id) ?? [];
    current.push(line);
    linesByRevision.set(line.revision_id, current);
  }
  const revisions = (revisionsResult.data ?? []).map((revision) => {
    const lines = linesByRevision.get(revision.id) ?? [];
    const summary = summarizePayrollProvision(lines);
    const calculatedTotal = payrollProvisionTotal(lines);
    return {
      ...revision,
      lines,
      summary,
      displayTotal: revision.status === "posted" ? asNumber(revision.total_amount) : calculatedTotal,
    };
  });
  const workingRevision = revisions.find((revision) => revision.status === "draft") ?? null;
  const lastPostedRevision = revisions.find((revision) => revision.status === "posted") ?? null;
  const currentRevision = workingRevision ?? lastPostedRevision;
  const comparisonAmount = lastPostedRevision?.displayTotal ?? null;
  const sourceIsStale = Boolean(workingRevision && workingRevision.source_sync_run_id !== contractualSnapshotResult.data?.current_sync_run_id);
  const reportedLaborCost = officialActual === null
    ? lastPostedRevision ? { amount: lastPostedRevision.displayTotal, basis: "posted_provision" } : null
    : { amount: officialActual, basis: "official" };

  return NextResponse.json({
    provision,
    revisions,
    currentRevision,
    workingRevision,
    lastPostedRevision,
    sourceIsStale,
    centers: centersResult.data ?? [],
    officialActual,
    officialActualLines,
    contractualSourceTotal,
    reportedLaborCost,
    comparison: officialActual === null || comparisonAmount === null ? null : {
      provisionAmount: comparisonAmount,
      actualAmount: officialActual,
      variance: officialActual - comparisonAmount,
      variancePercentage: comparisonAmount ? (officialActual - comparisonAmount) / comparisonAmount : null,
    },
    canManage: ["administrator", "finance"].includes(membershipResult.data?.role ?? ""),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  if (!body || !isUuid(organizationId) || typeof body.action !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }
  const supabase = context.supabase;

  if (body.action === "refresh_revision") {
    if (!isPeriodMonth(body.periodMonth) || !isDate(body.asOfDate)) {
      return NextResponse.json({ error: "invalid_revision_period" }, { status: 400 });
    }
    const { data, error } = await supabase.rpc("refresh_payroll_provision_revision", {
      p_organization_id: organizationId,
      p_period_month: body.periodMonth,
      p_as_of_date: body.asOfDate,
    });
    if (error || !data) {
      return NextResponse.json({ error: "unable_to_refresh_revision", detail: error?.message ?? null }, { status: 409 });
    }
    return NextResponse.json({ revision: data });
  }

  if (body.action === "add_line") {
    const revisionId = body.revisionId;
    const category = typeof body.category === "string" && categorySet.has(body.category) ? body.category : null;
    const direction = typeof body.direction === "string" && directionSet.has(body.direction) ? body.direction : null;
    const calculationMethod = typeof body.calculationMethod === "string" && calculationSet.has(body.calculationMethod) ? body.calculationMethod : null;
    const label = cleanText(body.label, 180, true);
    const notes = cleanText(body.notes, 1000);
    const costCenterId = body.costCenterId === null || body.costCenterId === "" ? null : body.costCenterId;
    if (!isUuid(revisionId) || !category || !direction || !calculationMethod || !label || (costCenterId !== null && !isUuid(costCenterId))) {
      return NextResponse.json({ error: "invalid_provision_line" }, { status: 400 });
    }

    const { data: revision, error: revisionError } = await supabase
      .from("payroll_provision_revisions")
      .select("id, status")
      .eq("id", revisionId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (revisionError || !revision) return NextResponse.json({ error: "revision_not_found" }, { status: 404 });
    if (revision.status !== "draft") return NextResponse.json({ error: "revision_not_editable" }, { status: 409 });

    let calculationRate: number | null = null;
    let calculationBase: number | null = null;
    let lineAmount: number | null = null;
    if (calculationMethod === "fixed") {
      lineAmount = positiveNumber(body.amount);
    } else {
      calculationRate = positiveNumber(body.calculationRate, 1000);
      if (calculationRate !== null) {
        let baseQuery = supabase
          .from("payroll_provision_lines")
          .select("amount")
          .eq("organization_id", organizationId)
          .eq("revision_id", revisionId)
          .eq("source_type", "peoplework");
        if (costCenterId) baseQuery = baseQuery.eq("cost_center_id", costCenterId);
        const { data: baseLines, error: baseError } = await baseQuery;
        if (baseError) return NextResponse.json({ error: "unable_to_calculate_line_base" }, { status: 500 });
        calculationBase = (baseLines ?? []).reduce((total, line) => total + asNumber(line.amount), 0);
        lineAmount = calculatePercentageAmount(calculationBase, calculationRate);
      }
    }
    if (lineAmount === null || lineAmount <= 0) {
      return NextResponse.json({ error: "invalid_provision_line_amount" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("payroll_provision_lines")
      .insert({
        organization_id: organizationId,
        revision_id: revisionId,
        source_type: "manual",
        category,
        label,
        calculation_method: calculationMethod,
        direction,
        calculation_rate: calculationRate,
        calculation_base: calculationBase,
        amount: lineAmount,
        cost_center_id: costCenterId,
        notes,
      })
      .select("id")
      .single();
    if (error || !data) {
      return NextResponse.json({ error: "unable_to_add_provision_line", detail: error?.message ?? null }, { status: 409 });
    }
    return NextResponse.json({ id: data.id }, { status: 201 });
  }

  if (body.action === "delete_line") {
    if (!isUuid(body.lineId)) return NextResponse.json({ error: "invalid_line" }, { status: 400 });
    const { error, count } = await supabase
      .from("payroll_provision_lines")
      .delete({ count: "exact" })
      .eq("id", body.lineId)
      .eq("organization_id", organizationId)
      .eq("source_type", "manual");
    if (error || !count) return NextResponse.json({ error: "unable_to_delete_provision_line" }, { status: 409 });
    return NextResponse.json({ deleted: true });
  }

  if (body.action === "update_revision_notes") {
    if (!isUuid(body.revisionId)) return NextResponse.json({ error: "invalid_revision" }, { status: 400 });
    const notes = cleanText(body.notes, 1000);
    const { error, count } = await supabase
      .from("payroll_provision_revisions")
      .update({ notes }, { count: "exact" })
      .eq("id", body.revisionId)
      .eq("organization_id", organizationId)
      .eq("status", "draft");
    if (error || !count) return NextResponse.json({ error: "unable_to_update_revision" }, { status: 409 });
    return NextResponse.json({ updated: true });
  }

  if (body.action === "discard_revision") {
    if (!isUuid(body.revisionId)) return NextResponse.json({ error: "invalid_revision" }, { status: 400 });
    const { data: revision } = await supabase
      .from("payroll_provision_revisions")
      .select("id")
      .eq("id", body.revisionId)
      .eq("organization_id", organizationId)
      .eq("status", "draft")
      .maybeSingle();
    if (!revision) return NextResponse.json({ error: "revision_not_editable" }, { status: 409 });
    const linesDelete = await supabase
      .from("payroll_provision_lines")
      .delete()
      .eq("revision_id", revision.id)
      .eq("organization_id", organizationId);
    if (linesDelete.error) return NextResponse.json({ error: "unable_to_discard_revision" }, { status: 409 });
    const revisionDelete = await supabase
      .from("payroll_provision_revisions")
      .delete()
      .eq("id", revision.id)
      .eq("organization_id", organizationId)
      .eq("status", "draft");
    if (revisionDelete.error) return NextResponse.json({ error: "unable_to_discard_revision" }, { status: 409 });
    return NextResponse.json({ discarded: true });
  }

  if (body.action === "post_revision") {
    if (!isUuid(body.revisionId)) return NextResponse.json({ error: "invalid_revision" }, { status: 400 });
    const { data, error } = await supabase.rpc("post_payroll_provision_revision", {
      p_organization_id: organizationId,
      p_revision_id: body.revisionId,
    });
    if (error || !data) {
      return NextResponse.json({ error: "unable_to_post_revision", detail: error?.message ?? null }, { status: 409 });
    }
    return NextResponse.json({ revision: data });
  }

  if (body.action === "save_official_actual") {
    if (!isPeriodMonth(body.periodMonth) || !Array.isArray(body.allocations) || body.allocations.length < 1 || body.allocations.length > 200) {
      return NextResponse.json({ error: "invalid_official_payroll" }, { status: 400 });
    }
    const allocations = body.allocations.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const input = item as Record<string, unknown>;
      const amount = positiveNumber(input.amount);
      const costCenterId = input.costCenterId === null || input.costCenterId === "" ? null : input.costCenterId;
      if (amount === null || (costCenterId !== null && !isUuid(costCenterId))) return [];
      return [{ costCenterId, amount }];
    });
    if (allocations.length !== body.allocations.length) {
      return NextResponse.json({ error: "invalid_official_payroll_line" }, { status: 400 });
    }
    const { data, error } = await supabase.rpc("replace_manual_official_payroll", {
      p_organization_id: organizationId,
      p_period_month: body.periodMonth,
      p_lines: allocations,
    });
    if (error || !data) {
      return NextResponse.json({ error: "unable_to_save_official_payroll", detail: error?.message ?? null }, { status: 409 });
    }
    return NextResponse.json({ officialPayroll: data });
  }

  if (body.action === "reconcile_actual") {
    if (!isUuid(body.provisionId)) return NextResponse.json({ error: "invalid_provision" }, { status: 400 });
    const { data, error } = await supabase.rpc("reconcile_payroll_provision_to_actual", {
      p_organization_id: organizationId,
      p_provision_id: body.provisionId,
    });
    if (error || !data) {
      return NextResponse.json({ error: "unable_to_reconcile_actual", detail: error?.message ?? null }, { status: 409 });
    }
    return NextResponse.json({ provision: data });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
