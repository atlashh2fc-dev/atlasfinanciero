import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const { data, error } = await supabase.rpc("refresh_recurrent_billing_alerts", { p_organization_id: organizationId });
  if (error) return NextResponse.json({ error: "unable_to_refresh_billing_alerts" }, { status: error.code === "P0001" ? 403 : 500 });

  return NextResponse.json({ result: data });
}
