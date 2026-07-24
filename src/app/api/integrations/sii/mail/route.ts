import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationAdministrator } from "@/lib/admin-access";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { syncPaymentProofMailbox, syncSiiMailbox } from "@/lib/sii/mail-import";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function clientSafeMailError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("AUTHENTICATIONFAILED")) return "El servidor rechazó las credenciales del buzón. Actualiza la clave de finanzas@geimser.cl en la integración.";
  if (message.includes("ENOTFOUND")) return "No fue posible encontrar el servidor de correo configurado.";
  return "No fue posible sincronizar el correo tributario. Intenta nuevamente o revisa la configuración.";
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { organizationId?: unknown } | null;
  if (!isUuid(body?.organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationAdministrator(body.organizationId);
  if (context.error) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "server_admin_key_required" }, { status: 503 });
  try {
    const admin = createAdminClient();
    const dte = await syncSiiMailbox(admin, body.organizationId, 3);
    return NextResponse.json(dte);
  } catch (error) {
    return NextResponse.json({ error: clientSafeMailError(error) }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "cron_authorization_required" }, { status: 401 });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "server_admin_key_required" }, { status: 503 });
  const admin = createAdminClient();
  const { data, error } = await admin.from("sii_integrations").select("organization_id").eq("is_enabled", true).eq("inbound_channel", "email");
  if (error) return NextResponse.json({ error: "unable_to_load_sii_mail_integrations" }, { status: 500 });
  const results = [];
  for (const integration of data ?? []) {
    const startedAt = new Date().toISOString();
    try {
      const dte = await syncSiiMailbox(admin, integration.organization_id);
      const paymentProofs = await syncPaymentProofMailbox(admin, integration.organization_id).catch((error) => {
        console.error("No fue posible procesar comprobantes de pago", error);
        return { scanned: 0, matched: 0, reviewRequired: 0, error: "payment_proof_sync_failed" };
      });
      const result = { organizationId: integration.organization_id, ok: true, ...dte, paymentProofs };
      const { error: runError } = await admin.from("sii_mail_sync_runs").insert({
        organization_id: integration.organization_id,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        run_status: "completed",
        dte_scanned: dte.scanned,
        dte_created: dte.created,
        dte_updated: dte.updated,
        dte_skipped: dte.skipped,
        invoice_files_attached: dte.filesAttached,
        payment_scanned: paymentProofs.scanned,
        payment_matched: paymentProofs.matched,
        payment_review_required: paymentProofs.reviewRequired,
        error_detail: "error" in paymentProofs ? paymentProofs.error : null,
      });
      if (runError) throw new Error("sii_mail_sync_run_record_failed");
      results.push(result);
    }
    catch (syncError) {
      const errorDetail = syncError instanceof Error ? syncError.message.slice(0, 500) : "sii_mail_sync_failed";
      await admin.from("sii_mail_sync_runs").insert({ organization_id: integration.organization_id, started_at: startedAt, completed_at: new Date().toISOString(), run_status: "failed", error_detail: errorDetail });
      results.push({ organizationId: integration.organization_id, ok: false, error: errorDetail });
    }
  }
  return NextResponse.json({ results, executedAt: new Date().toISOString() });
}
