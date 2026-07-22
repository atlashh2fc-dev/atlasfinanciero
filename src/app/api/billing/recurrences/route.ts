import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RecurrenceRequest = {
  organizationId?: unknown;
  counterpartyId?: unknown;
  name?: unknown;
  expectedNetAmount?: unknown;
  currencyCode?: unknown;
  reminderDaysBefore?: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readAmount(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", user.id);
  if (membershipsError) return NextResponse.json({ error: "unable_to_load_memberships" }, { status: 500 });

  const membership = (memberships ?? []).find((item) => item.organization_id === organizationId);
  if (!membership) return NextResponse.json({ error: "organization_membership_required" }, { status: 403 });

  const [organizations, counterparties, rules, cycles] = await Promise.all([
    supabase.from("organizations").select("id, legal_name").eq("id", organizationId).order("legal_name"),
    supabase.from("counterparties").select("id, organization_id, legal_name").eq("organization_id", organizationId).in("kind", ["customer", "both"]).eq("is_active", true).order("legal_name"),
    supabase.from("billing_recurrence_rules").select("id, organization_id, counterparty_id, name, expected_net_amount, currency_code, deadline_day, reminder_days_before, status").eq("organization_id", organizationId).order("name"),
    supabase.from("billing_cycles").select("id, organization_id, recurrence_rule_id, period_month, due_date, expected_net_amount, currency_code, status, issued_document_id").eq("organization_id", organizationId).order("due_date"),
  ]);

  if (organizations.error || counterparties.error || rules.error || cycles.error) {
    return NextResponse.json({ error: "unable_to_load_billing_operation" }, { status: 500 });
  }

  return NextResponse.json({
    memberships: membership ? [membership] : [],
    organizations: organizations.data ?? [],
    counterparties: counterparties.data ?? [],
    rules: rules.data ?? [],
    cycles: cycles.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as RecurrenceRequest | null;
  const organizationId = body?.organizationId;
  const counterpartyId = body?.counterpartyId;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const expectedNetAmount = readAmount(body?.expectedNetAmount);
  const currencyCode = typeof body?.currencyCode === "string" ? body.currencyCode.trim().toUpperCase() : "CLP";
  const reminderDaysBefore = Number(body?.reminderDaysBefore ?? 3);

  if (!isUuid(organizationId) || !isUuid(counterpartyId) || !name || name.length > 180 || expectedNetAmount === undefined || !/^[A-Z]{3}$/.test(currencyCode) || !Number.isInteger(reminderDaysBefore) || reminderDaysBefore < 1 || reminderDaysBefore > 15) {
    return NextResponse.json({ error: "invalid_recurrence" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("billing_recurrence_rules")
    .insert({
      organization_id: organizationId,
      counterparty_id: counterpartyId,
      name,
      expected_net_amount: expectedNetAmount,
      currency_code: currencyCode,
      deadline_day: 2,
      reminder_days_before: reminderDaysBefore,
      status: "active",
    })
    .select("id, organization_id, counterparty_id, name, expected_net_amount, currency_code, deadline_day, reminder_days_before, status")
    .single();

  if (error) return NextResponse.json({ error: "unable_to_create_recurrence" }, { status: 403 });

  const { error: refreshError } = await supabase.rpc("refresh_recurrent_billing_alerts", { p_organization_id: organizationId });
  if (refreshError) return NextResponse.json({ rule: data, warning: "rule_created_but_alert_refresh_failed" }, { status: 201 });

  return NextResponse.json({ rule: data }, { status: 201 });
}
