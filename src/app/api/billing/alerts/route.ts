import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { data, error } = await supabase
    .from("billing_alert_inbox")
    .select("id, organization_id, alert_type, status, first_detected_at, last_detected_at, billing_cycle_id, period_month, due_date, cycle_status, recurrence_name, counterparty_name")
    .eq("status", "open")
    .order("due_date", { ascending: true });

  if (error) return NextResponse.json({ error: "unable_to_load_billing_alerts" }, { status: 500 });
  return NextResponse.json({ alerts: data ?? [] });
}
