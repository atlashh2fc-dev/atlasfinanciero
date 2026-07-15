import { NextRequest, NextResponse } from "next/server";
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
  return NextResponse.json({ requests: requests.data ?? [], policies: policies.data ?? [], membership: context.membership });
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
