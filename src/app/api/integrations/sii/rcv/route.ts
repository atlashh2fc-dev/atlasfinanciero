import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationAdministrator } from "@/lib/admin-access";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { syncRcv } from "@/lib/sii/rcv-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

function clientSafeError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "sii_integration_not_enabled") return "Primero habilita la integración SII.";
  if (message === "sii_rcv_requires_production") return "El Registro de Compras y Ventas sólo existe en el ambiente de producción del SII. Cambia el ambiente de la integración.";
  if (message === "sii_certificate_not_configured") return "Falta el certificado tributario para consultar el SII.";
  if (message === "sii_rcv_invalid_period") return "El período debe tener formato AAAAMM.";
  if (message.startsWith("sii_rcv_error:")) return `El SII rechazó la consulta: ${message.slice(14)}`;
  if (message === "sii_rcv_timeout" || message === "sii_network_timeout") return "El SII tardó demasiado en responder. Inténtalo nuevamente.";
  return "No fue posible sincronizar el Registro de Compras y Ventas. Revisa la configuración y la bitácora.";
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { organizationId?: unknown; period?: unknown } | null;
  if (!isUuid(body?.organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationAdministrator(body.organizationId);
  if (context.error) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "server_admin_key_required" }, { status: 503 });
  const period = typeof body.period === "string" && body.period.trim() ? [body.period.trim()] : undefined;
  try {
    const admin = createAdminClient();
    const result = await syncRcv(admin, body.organizationId, "manual", period);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: clientSafeError(error) }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "cron_authorization_required" }, { status: 401 });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "server_admin_key_required" }, { status: 503 });
  const admin = createAdminClient();
  const { data, error } = await admin.from("sii_integrations")
    .select("organization_id")
    .eq("is_enabled", true)
    .eq("environment", "production");
  if (error) return NextResponse.json({ error: "unable_to_load_sii_integrations" }, { status: 500 });
  const results = [];
  for (const integration of data ?? []) {
    try {
      const result = await syncRcv(admin, integration.organization_id, "cron");
      results.push({ organizationId: integration.organization_id, ok: true, ...result });
    } catch (syncError) {
      results.push({
        organizationId: integration.organization_id,
        ok: false,
        error: syncError instanceof Error ? syncError.message.slice(0, 500) : "sii_rcv_sync_failed",
      });
    }
  }
  return NextResponse.json({ results, executedAt: new Date().toISOString() });
}
