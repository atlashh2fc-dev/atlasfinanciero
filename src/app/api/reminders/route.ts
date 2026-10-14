import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Recordatorios vencidos de quien consulta. La base filtra por auth.uid():
// cada persona sólo ve y responde los suyos, en cualquier empresa.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { data, error } = await supabase.rpc("due_user_reminders");
  if (error) return NextResponse.json({ error: "unable_to_load_reminders" }, { status: 500 });
  return NextResponse.json({ reminders: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" && uuidPattern.test(body.id) ? body.id : null;
  const action = body?.action;
  if (!id || (action !== "approve" && action !== "snooze"))
    return NextResponse.json({ error: "invalid_reminder_action" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  if (action === "approve") {
    const { data, error } = await supabase.rpc("approve_user_reminder", { p_reminder_id: id });
    if (error || !data) return NextResponse.json({ error: "reminder_approval_not_available" }, { status: 409 });
    return NextResponse.json({ approvalRequestId: data });
  }

  const { data, error } = await supabase.rpc("acknowledge_user_reminder", { p_reminder_id: id });
  if (error || !data) return NextResponse.json({ error: "reminder_not_available" }, { status: 409 });
  return NextResponse.json({ nextRemindAt: data });
}
