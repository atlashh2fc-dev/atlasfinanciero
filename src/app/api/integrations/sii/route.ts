import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationAdministrator, requireOrganizationExpenseReadAccess, requireOrganizationFinanceAccess } from "@/lib/admin-access";
import { parseRut, siiDte, type SiiDteAction, type SiiEnvironment } from "@/lib/sii/dte";

const registrationActions = new Set<SiiDteAction>(["ACD", "ERM", "RCD", "RFP", "RFT"]);

function bodyText(value: unknown, limit: number) {
  return typeof value === "string" && value.trim().length <= limit ? value.trim() || null : null;
}

function toDeadline(value: string | null) {
  if (!value) return null;
  const receipt = new Date(value);
  if (Number.isNaN(receipt.valueOf())) return null;
  receipt.setUTCDate(receipt.getUTCDate() + 8);
  return receipt.toISOString();
}

function receptionDate(raw: string) {
  const match = raw.match(/<(?:\w+:)?(?:fechaRecepcionSii|fechaRecepcion)[^>]*>([^<]+)</i);
  return match?.[1]?.trim() ?? null;
}

function actionWasAccepted(code: number | null, message: string | null) {
  if (code !== 0) return false;
  return !/(?:no\s+(?:es\s+)?posible|no\s+se\s+puede|rechaz|error|pasados?\s+\d+\s+d[ií]as|fuera\s+de\s+plazo)/i.test(message ?? "");
}

function decisionWindowClosed(message: string | null) {
  return /(?:pasados?\s+\d+\s+d[ií]as|fuera\s+de\s+plazo|no\s+(?:es\s+)?posible\s+registrar\s+(?:reclamos?|eventos?))/i.test(message ?? "");
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
  const [integration, events] = await Promise.all([
    context.supabase.from("sii_integrations").select("taxpayer_rut, environment, inbound_channel, inbound_address, is_enabled, configured_at").eq("organization_id", organizationId).maybeSingle(),
    context.supabase.from("sii_dte_events").select("id, received_document_id, action, reason, request_status, sii_response_code, sii_response_message, requested_at, completed_at").eq("organization_id", organizationId).order("requested_at", { ascending: false }).limit(500),
  ]);
  if (integration.error || events.error) return NextResponse.json({ error: "unable_to_load_sii_integration" }, { status: 500 });
  return NextResponse.json({ integration: integration.data, events: events.data ?? [], certificateConfigured: Boolean(process.env.SII_PRIVATE_KEY_PEM && process.env.SII_CERTIFICATE_PEM) });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!isUuid(body?.organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationAdministrator(body.organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  const taxpayerRut = bodyText(body.taxpayerRut, 12);
  const parsedRut = taxpayerRut ? parseRut(taxpayerRut) : null;
  const environment = body.environment === "production" || body.environment === "certification" ? body.environment : null;
  const inboundChannel = body.inboundChannel === "email" || body.inboundChannel === "provider" || body.inboundChannel === "manual" ? body.inboundChannel : null;
  const inboundAddress = body.inboundAddress === null || body.inboundAddress === undefined ? null : bodyText(body.inboundAddress, 254);
  if (!parsedRut || !environment || !inboundChannel || (body.inboundAddress !== null && body.inboundAddress !== undefined && !inboundAddress)) return NextResponse.json({ error: "invalid_sii_configuration" }, { status: 400 });
  const { data, error } = await context.supabase.from("sii_integrations").upsert({
    organization_id: body.organizationId,
    taxpayer_rut: parsedRut.formatted,
    environment,
    inbound_channel: inboundChannel,
    inbound_address: inboundAddress,
    is_enabled: Boolean(body.isEnabled),
    configured_by: context.user.id,
    configured_at: new Date().toISOString(),
  }, { onConflict: "organization_id" }).select("taxpayer_rut, environment, inbound_channel, inbound_address, is_enabled, configured_at").single();
  if (error) return NextResponse.json({ error: "unable_to_save_sii_configuration" }, { status: 409 });
  return NextResponse.json({ integration: data });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!isUuid(body?.organizationId) || !isUuid(body?.documentId) || typeof body?.operation !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(body.organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  const [{ data: integration, error: integrationError }, { data: document, error: documentError }] = await Promise.all([
    context.supabase.from("sii_integrations").select("environment, is_enabled").eq("organization_id", body.organizationId).maybeSingle(),
    context.supabase.from("received_documents").select("id, supplier_tax_id, sii_document_type, sii_folio").eq("id", body.documentId).eq("organization_id", body.organizationId).maybeSingle(),
  ]);
  if (integrationError || !integration?.is_enabled) return NextResponse.json({ error: "sii_integration_not_enabled" }, { status: 409 });
  if (documentError || !document?.supplier_tax_id || !document.sii_document_type || !document.sii_folio) return NextResponse.json({ error: "sii_document_identity_required" }, { status: 409 });
  const environment = integration.environment as SiiEnvironment;
  const documentType = Number(document.sii_document_type);
  const folio = Number(document.sii_folio);

  try {
    if (body.operation === "refresh") {
      const [history, receipt] = await Promise.all([
        siiDte.listEvents(environment, document.supplier_tax_id, documentType, folio),
        siiDte.receptionDate(environment, document.supplier_tax_id, documentType, folio),
      ]);
      const receivedAt = receptionDate(receipt.raw);
      await context.supabase.from("received_documents").update({
        sii_received_at: receivedAt,
        sii_response_deadline: toDeadline(receivedAt),
        sii_last_checked_at: new Date().toISOString(),
      }).eq("id", document.id).eq("organization_id", body.organizationId);
      return NextResponse.json({ history, receiptDate: receivedAt });
    }
    const action = body.action;
    if (typeof action !== "string" || !registrationActions.has(action as SiiDteAction) || body.confirm !== true) return NextResponse.json({ error: "sii_action_confirmation_required" }, { status: 400 });
    const reason = bodyText(body.reason, 2_000);
    if (["RCD", "RFP", "RFT"].includes(action) && !reason) return NextResponse.json({ error: "sii_claim_reason_required" }, { status: 400 });
    const { data: event, error: eventError } = await context.supabase.from("sii_dte_events").insert({
      organization_id: body.organizationId,
      received_document_id: document.id,
      action,
      reason,
      request_status: "pending",
      requested_by: context.user.id,
    }).select("id").single();
    if (eventError || !event) return NextResponse.json({ error: "unable_to_audit_sii_request" }, { status: 409 });
    try {
      const result = await siiDte.registerAction(environment, document.supplier_tax_id, documentType, folio, action as Exclude<SiiDteAction, "CNS">);
      const accepted = actionWasAccepted(result.code, result.message);
      await context.supabase.from("sii_dte_events").update({ request_status: accepted ? "completed" : "failed", sii_response_code: result.code, sii_response_message: result.message, completed_at: new Date().toISOString() }).eq("id", event.id).eq("organization_id", body.organizationId);
      if (accepted) {
        const siiEventStatus = action === "ACD" ? "accepted_content" : action === "ERM" ? "receipt_acknowledged" : "claimed";
        await context.supabase.from("received_documents").update({ sii_event_status: siiEventStatus, sii_last_checked_at: new Date().toISOString() }).eq("id", document.id).eq("organization_id", body.organizationId);
      } else if (decisionWindowClosed(result.message)) {
        await context.supabase.from("received_documents").update({ sii_event_status: "decision_window_closed", sii_last_checked_at: new Date().toISOString() }).eq("id", document.id).eq("organization_id", body.organizationId);
      }
      return NextResponse.json({ result, accepted });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "sii_request_failed";
      await context.supabase.from("sii_dte_events").update({ request_status: "failed", sii_response_message: message, completed_at: new Date().toISOString() }).eq("id", event.id).eq("organization_id", body.organizationId);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "sii_request_failed";
    return NextResponse.json({ error: message.startsWith("sii_") ? message : "sii_request_failed" }, { status: 502 });
  }
}
