import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const requestRoles = new Set(["administrator", "finance", "operations"]);
const targetTypes = new Set(["preinvoice", "payment", "purchase_order"]);
const decisions = new Set(["approved", "rejected"]);
const currencies = new Set(["CLP", "USD", "UF"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function cleanText(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function validAmount(value: unknown) {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function metadataRequesterName(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).requester_name;
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && !isEmail(name) ? name : null;
}

async function organizationContext(organizationId: unknown) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "authentication_required" as const, status: 401, supabase: null, membership: null };
  if (!isUuid(organizationId)) return { error: "invalid_organization" as const, status: 400, supabase: null, membership: null };

  const { data: membership, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return { error: "unable_to_read_membership" as const, status: 500, supabase: null, membership: null };
  if (!membership) return { error: "organization_access_required" as const, status: 403, supabase: null, membership: null };
  return { error: null, status: 200, supabase, membership };
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const context = await organizationContext(organizationId);
  if (context.error || !context.supabase || !organizationId) return NextResponse.json({ error: context.error }, { status: context.status });

  const [requests, policies] = await Promise.all([
    context.supabase
      .from("approval_requests")
      .select("id, approval_policy_id, target_type, target_id, title, description, amount, currency_code, status, requested_by, submitted_at, completed_at, metadata, approval_policies(name), approval_steps(id, step_number, required_role, assigned_to, status, decided_by, decided_at, decision_comment)")
      .eq("organization_id", organizationId)
      .eq("status", "submitted")
      .order("submitted_at", { ascending: false }),
    context.supabase
      .from("approval_policies")
      .select("id, name, target_type, required_role, minimum_amount, maximum_amount, currency_code, is_active")
      .eq("organization_id", organizationId)
      .order("name"),
  ]);

  if (requests.error || policies.error) return NextResponse.json({ error: "unable_to_load_approvals" }, { status: 500 });
  const approvalRequests = requests.data ?? [];
  const directPayableIds = approvalRequests
    .filter((approval) => approval.target_type === "payment" && approval.metadata?.kind === "direct_payable")
    .map((approval) => approval.target_id);
  const directPayablesResult = directPayableIds.length
    ? await context.supabase
      .from("direct_payables")
      .select("id, supplier_name, beneficiary_name, invoice_number, category, category_detail, description, issue_date, due_date, notes, cost_center_id")
      .eq("organization_id", organizationId)
      .in("id", directPayableIds)
    : { data: [], error: null };
  if (directPayablesResult.error) return NextResponse.json({ error: "unable_to_load_approvals" }, { status: 500 });
  const attachmentsResult = directPayableIds.length
    ? await context.supabase
      .from("direct_payable_attachments")
      .select("id, direct_payable_id, file_name, storage_path")
      .eq("organization_id", organizationId)
      .in("direct_payable_id", directPayableIds)
    : { data: [], error: null };
  if (attachmentsResult.error) return NextResponse.json({ error: "unable_to_load_approvals" }, { status: 500 });
  const attachmentsByPayable = new Map<string, { id: string; fileName: string; signedUrl: string | null }[]>();
  await Promise.all((attachmentsResult.data ?? []).map(async (attachment) => {
    const { data } = await context.supabase.storage
      .from("direct-payable-files")
      .createSignedUrl(attachment.storage_path, 60);
    const list = attachmentsByPayable.get(attachment.direct_payable_id) ?? [];
    list.push({ id: attachment.id, fileName: attachment.file_name, signedUrl: data?.signedUrl ?? null });
    attachmentsByPayable.set(attachment.direct_payable_id, list);
  }));
  const centerIds = [...new Set((directPayablesResult.data ?? []).map((payable) => payable.cost_center_id).filter((id): id is string => Boolean(id)))];
  const centersResult = centerIds.length
    ? await context.supabase.from("cost_centers").select("id, code, name").eq("organization_id", organizationId).in("id", centerIds)
    : { data: [], error: null };
  if (centersResult.error) return NextResponse.json({ error: "unable_to_load_approvals" }, { status: 500 });
  const centersById = new Map((centersResult.data ?? []).map((center) => [center.id, { code: center.code, name: center.name }]));
  const directPayablesById = new Map((directPayablesResult.data ?? []).map((payable) => [payable.id, {
    supplier_name: payable.supplier_name,
    beneficiary_name: payable.beneficiary_name,
    invoice_number: payable.invoice_number,
    category: payable.category,
    category_detail: payable.category_detail,
    description: payable.description,
    issue_date: payable.issue_date,
    due_date: payable.due_date,
    notes: payable.notes,
    cost_center: payable.cost_center_id ? centersById.get(payable.cost_center_id) ?? null : null,
    attachments: attachmentsByPayable.get(payable.id) ?? [],
  }]));
  const requesterIds = [...new Set(approvalRequests.map((approval) => approval.requested_by).filter((id): id is string => Boolean(id)))];
  const requesterNames = new Map<string, string>();

  if (requesterIds.length && hasSupabaseAdminKey()) {
    const { data: profiles } = await createAdminClient()
      .from("profiles")
      .select("id, full_name")
      .in("id", requesterIds);
    for (const profile of profiles ?? []) {
      const name = profile.full_name?.trim();
      if (name) requesterNames.set(profile.id, name);
    }
  }

  const enrichedRequests = approvalRequests.map((approval) => {
    const directPayable = approval.metadata?.kind === "direct_payable" ? directPayablesById.get(approval.target_id) ?? null : null;
    return {
      ...approval,
      description: approval.description || directPayable?.description || null,
      metadata: directPayable ? { ...approval.metadata, direct_payable: directPayable } : approval.metadata,
      requested_by_name: approval.requested_by
        ? requesterNames.get(approval.requested_by) ?? metadataRequesterName(approval.metadata) ?? "Nombre no registrado"
        : "Sistema",
    };
  });

  return NextResponse.json({ requests: enrichedRequests, policies: policies.data ?? [], membership: context.membership });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await organizationContext(body.organizationId);
  if (context.error || !context.supabase || !context.membership) return NextResponse.json({ error: context.error }, { status: context.status });
  const action = body.action;

  if (action === "create") {
    if (!requestRoles.has(context.membership.role)) return NextResponse.json({ error: "approval_request_not_authorized" }, { status: 403 });
    const targetType = typeof body.targetType === "string" && targetTypes.has(body.targetType) ? body.targetType : null;
    const targetId = body.targetId;
    const policyId = body.approvalPolicyId;
    const title = cleanText(body.title, 240, true);
    const description = cleanText(body.description, 2000);
    const amount = validAmount(body.amount);
    const currencyCode = typeof body.currencyCode === "string" && currencies.has(body.currencyCode) ? body.currencyCode : "CLP";
    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {};
    if (!targetType || !isUuid(targetId) || !isUuid(policyId) || !title || amount === null) return NextResponse.json({ error: "invalid_approval_request" }, { status: 400 });

    const { data, error } = await context.supabase
      .from("approval_requests")
      .insert({
        organization_id: body.organizationId,
        approval_policy_id: policyId,
        target_type: targetType,
        target_id: targetId,
        title,
        description,
        amount,
        currency_code: currencyCode,
        metadata,
      })
      .select("id")
      .single();
    if (error || !data) return NextResponse.json({ error: "unable_to_create_approval_request" }, { status: 409 });
    return NextResponse.json({ id: data.id }, { status: 201 });
  }

  if (action === "decide") {
    const stepId = body.stepId;
    const decision = typeof body.decision === "string" && decisions.has(body.decision) ? body.decision : null;
    const comment = cleanText(body.comment, 2000);
    if (!isUuid(stepId) || !decision) return NextResponse.json({ error: "invalid_approval_decision" }, { status: 400 });
    const { data, error } = await context.supabase.rpc("record_approval_decision", {
      p_step_id: stepId,
      p_decision: decision,
      p_comment: comment,
    });
    if (error || !data) return NextResponse.json({ error: "approval_decision_not_authorized" }, { status: 403 });
    return NextResponse.json({ id: data });
  }

  return NextResponse.json({ error: "unsupported_approval_action" }, { status: 400 });
}
