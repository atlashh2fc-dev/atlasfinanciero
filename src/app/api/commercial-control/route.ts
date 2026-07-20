import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const writeRoles = new Set(["administrator", "finance", "operations"]);
const stages = new Set(["lead", "qualified", "proposal", "negotiation", "won", "lost"]);
const contractStatuses = new Set(["draft", "active", "expiring", "closed", "cancelled"]);
const projectStatuses = new Set(["planning", "active", "on_hold", "completed", "cancelled"]);
const activityTypes = new Set(["call", "meeting", "email", "task", "note"]);
const frequencies = new Set(["monthly", "quarterly", "annual", "one_time"]);
const currencies = new Set(["CLP", "UF", "USD"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function clean(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime()) ? value : undefined;
}

function optionalNumber(value: unknown, min = 0, max = 999_999_999_999) {
  if (value === null || value === undefined || value === "") return 0;
  const result = Number(value);
  return Number.isFinite(result) && result >= min && result <= max ? result : undefined;
}

async function membership(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: unknown, userId: string, write = false) {
  if (!isUuid(organizationId)) return null;
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data || (write && !writeRoles.has(data.role))) return null;
  return data.organization_id;
}

async function belongsToCustomer(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "commercial_opportunities" | "commercial_contracts",
  id: unknown,
  organizationId: string,
  counterpartyId: string,
) {
  if (!isUuid(id)) return id === null || id === undefined || id === "";
  const { data } = await supabase.from(table).select("id").eq("id", id).eq("organization_id", organizationId).eq("counterparty_id", counterpartyId).maybeSingle();
  return Boolean(data);
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const organizationId = await membership(supabase, request.nextUrl.searchParams.get("organizationId"), user.id);
  if (!organizationId) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const [customers, centers, opportunities, contracts, projects, activities] = await Promise.all([
    supabase.from("counterparties").select("id, legal_name, trade_name, tax_id").eq("organization_id", organizationId).in("kind", ["customer", "both"]).eq("is_active", true).order("legal_name"),
    supabase.from("cost_centers").select("id, code, name").eq("organization_id", organizationId).eq("is_active", true).order("code"),
    supabase.from("commercial_opportunities").select("id, counterparty_id, title, stage, expected_amount, currency_code, probability, expected_close_on, next_action_on, source, lost_reason, description, owner_user_id, created_at, updated_at").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    supabase.from("commercial_contracts").select("id, counterparty_id, opportunity_id, contract_code, name, status, total_amount, currency_code, starts_on, ends_on, renewal_notice_on, billing_frequency, responsible_user_id, notes, created_at, updated_at").eq("organization_id", organizationId).order("ends_on", { ascending: true, nullsFirst: false }),
    supabase.from("commercial_projects").select("id, counterparty_id, contract_id, opportunity_id, cost_center_id, project_code, name, status, revenue_budget, expense_budget, currency_code, starts_on, ends_on, manager_user_id, notes, created_at, updated_at").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    supabase.from("commercial_activities").select("id, opportunity_id, activity_type, subject, notes, due_on, completed_on, assigned_to, created_at, updated_at").eq("organization_id", organizationId).order("due_on", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }),
  ]);
  if ([customers, centers, opportunities, contracts, projects, activities].some((result) => result.error)) return NextResponse.json({ error: "unable_to_load_commercial_control" }, { status: 500 });
  return NextResponse.json({ customers: customers.data ?? [], centers: centers.data ?? [], opportunities: opportunities.data ?? [], contracts: contracts.data ?? [], projects: projects.data ?? [], activities: activities.data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = await membership(supabase, body?.organizationId, user.id, true);
  if (!organizationId) return NextResponse.json({ error: "organization_write_not_authorized" }, { status: 403 });
  const input = body?.record as Record<string, unknown> | null;
  if (!input) return NextResponse.json({ error: "invalid_commercial_record" }, { status: 400 });

  if (body?.action === "save_opportunity") {
    const title = clean(input.title, 250, true);
    const counterpartyId = isUuid(input.counterpartyId) ? input.counterpartyId : null;
    const stage = typeof input.stage === "string" && stages.has(input.stage) ? input.stage : null;
    const expectedAmount = optionalNumber(input.expectedAmount);
    const probability = optionalNumber(input.probability, 0, 100);
    const expectedCloseOn = optionalDate(input.expectedCloseOn);
    const nextActionOn = optionalDate(input.nextActionOn);
    const currencyCode = typeof input.currencyCode === "string" && currencies.has(input.currencyCode) ? input.currencyCode : null;
    if (!title || !counterpartyId || !stage || expectedAmount === undefined || probability === undefined || expectedCloseOn === undefined || nextActionOn === undefined || !currencyCode) return NextResponse.json({ error: "invalid_opportunity" }, { status: 400 });
    const values = { organization_id: organizationId, counterparty_id: counterpartyId, title, stage, expected_amount: expectedAmount, currency_code: currencyCode, probability, expected_close_on: expectedCloseOn, next_action_on: nextActionOn, source: clean(input.source, 120), lost_reason: stage === "lost" ? clean(input.lostReason, 1000) : null, description: clean(input.description, 4000), owner_user_id: user.id };
    const query = isUuid(input.id) ? supabase.from("commercial_opportunities").update(values).eq("id", input.id).eq("organization_id", organizationId) : supabase.from("commercial_opportunities").insert(values);
    const { data, error } = await query.select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "unable_to_save_opportunity" }, { status: 409 });
    return NextResponse.json({ id: data.id });
  }

  if (body?.action === "save_contract") {
    const counterpartyId = isUuid(input.counterpartyId) ? input.counterpartyId : null;
    const contractCode = clean(input.contractCode, 80, true);
    const name = clean(input.name, 250, true);
    const status = typeof input.status === "string" && contractStatuses.has(input.status) ? input.status : null;
    const totalAmount = optionalNumber(input.totalAmount);
    const startsOn = optionalDate(input.startsOn);
    const endsOn = optionalDate(input.endsOn);
    const renewalNoticeOn = optionalDate(input.renewalNoticeOn);
    const currencyCode = typeof input.currencyCode === "string" && currencies.has(input.currencyCode) ? input.currencyCode : null;
    const billingFrequency = typeof input.billingFrequency === "string" && frequencies.has(input.billingFrequency) ? input.billingFrequency : null;
    if (!counterpartyId || !contractCode || !name || !status || totalAmount === undefined || startsOn === undefined || endsOn === undefined || renewalNoticeOn === undefined || !currencyCode || !billingFrequency || (startsOn && endsOn && endsOn < startsOn) || !(await belongsToCustomer(supabase, "commercial_opportunities", input.opportunityId, organizationId, counterpartyId))) return NextResponse.json({ error: "invalid_contract" }, { status: 400 });
    const values = { organization_id: organizationId, counterparty_id: counterpartyId, opportunity_id: isUuid(input.opportunityId) ? input.opportunityId : null, contract_code: contractCode, name, status, total_amount: totalAmount, currency_code: currencyCode, starts_on: startsOn, ends_on: endsOn, renewal_notice_on: renewalNoticeOn, billing_frequency: billingFrequency, responsible_user_id: user.id, notes: clean(input.notes, 4000) };
    const query = isUuid(input.id) ? supabase.from("commercial_contracts").update(values).eq("id", input.id).eq("organization_id", organizationId) : supabase.from("commercial_contracts").insert(values);
    const { data, error } = await query.select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "unable_to_save_contract" }, { status: 409 });
    return NextResponse.json({ id: data.id });
  }

  if (body?.action === "save_project") {
    const counterpartyId = isUuid(input.counterpartyId) ? input.counterpartyId : null;
    const projectCode = clean(input.projectCode, 80, true);
    const name = clean(input.name, 250, true);
    const status = typeof input.status === "string" && projectStatuses.has(input.status) ? input.status : null;
    const revenueBudget = optionalNumber(input.revenueBudget);
    const expenseBudget = optionalNumber(input.expenseBudget);
    const startsOn = optionalDate(input.startsOn);
    const endsOn = optionalDate(input.endsOn);
    const currencyCode = typeof input.currencyCode === "string" && currencies.has(input.currencyCode) ? input.currencyCode : null;
    if (!counterpartyId || !projectCode || !name || !status || revenueBudget === undefined || expenseBudget === undefined || startsOn === undefined || endsOn === undefined || !currencyCode || (startsOn && endsOn && endsOn < startsOn) || !(await belongsToCustomer(supabase, "commercial_opportunities", input.opportunityId, organizationId, counterpartyId)) || !(await belongsToCustomer(supabase, "commercial_contracts", input.contractId, organizationId, counterpartyId))) return NextResponse.json({ error: "invalid_project" }, { status: 400 });
    const values = { organization_id: organizationId, counterparty_id: counterpartyId, contract_id: isUuid(input.contractId) ? input.contractId : null, opportunity_id: isUuid(input.opportunityId) ? input.opportunityId : null, cost_center_id: isUuid(input.costCenterId) ? input.costCenterId : null, project_code: projectCode, name, status, revenue_budget: revenueBudget, expense_budget: expenseBudget, currency_code: currencyCode, starts_on: startsOn, ends_on: endsOn, manager_user_id: user.id, notes: clean(input.notes, 4000) };
    const query = isUuid(input.id) ? supabase.from("commercial_projects").update(values).eq("id", input.id).eq("organization_id", organizationId) : supabase.from("commercial_projects").insert(values);
    const { data, error } = await query.select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "unable_to_save_project" }, { status: 409 });
    return NextResponse.json({ id: data.id });
  }

  if (body?.action === "save_activity") {
    const opportunityId = isUuid(input.opportunityId) ? input.opportunityId : null;
    const activityType = typeof input.activityType === "string" && activityTypes.has(input.activityType) ? input.activityType : null;
    const subject = clean(input.subject, 250, true);
    const dueOn = optionalDate(input.dueOn);
    if (!opportunityId || !activityType || !subject || dueOn === undefined) return NextResponse.json({ error: "invalid_activity" }, { status: 400 });
    const { data: opportunity } = await supabase.from("commercial_opportunities").select("id").eq("id", opportunityId).eq("organization_id", organizationId).maybeSingle();
    if (!opportunity) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
    const values = { organization_id: organizationId, opportunity_id: opportunityId, activity_type: activityType, subject, notes: clean(input.notes, 4000), due_on: dueOn, completed_on: input.completedOn === true ? new Date().toISOString().slice(0, 10) : null, assigned_to: user.id };
    const query = isUuid(input.id) ? supabase.from("commercial_activities").update(values).eq("id", input.id).eq("organization_id", organizationId) : supabase.from("commercial_activities").insert(values);
    const { data, error } = await query.select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "unable_to_save_activity" }, { status: 409 });
    return NextResponse.json({ id: data.id });
  }

  return NextResponse.json({ error: "unsupported_commercial_action" }, { status: 400 });
}
