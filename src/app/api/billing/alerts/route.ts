import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const { data, error } = await supabase
    .from("billing_alert_inbox")
    .select("id, organization_id, alert_type, status, first_detected_at, last_detected_at, billing_cycle_id, period_month, due_date, cycle_status, recurrence_name, counterparty_name")
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .order("due_date", { ascending: true });

  if (error) return NextResponse.json({ error: "unable_to_load_billing_alerts" }, { status: 500 });
  return NextResponse.json({ alerts: data ?? [] });
}
