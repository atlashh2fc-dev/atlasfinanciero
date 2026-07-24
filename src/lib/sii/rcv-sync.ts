// Sincroniza el Registro de Compras y Ventas del SII hacia la zona de staging
// (sii_rcv_entries) y luego concilia contra los documentos operacionales.
// Regla de datos del proyecto: la fuente manda. Cada fila del SII se conserva
// cruda; el merge vincula o crea documentos, y ante montos distintos marca la
// discrepancia sin sobrescribir valores existentes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchRcvPeriod, type RcvEntry, type RcvOperation } from "@/lib/sii/rcv";

export type RcvSyncTrigger = "cron" | "manual";

export type RcvSyncResult = {
  runId: string | null;
  periods: string[];
  purchasesFetched: number;
  salesFetched: number;
  entriesCreated: number;
  entriesUpdated: number;
  purchasesLinked: number;
  purchasesCreated: number;
  salesLinked: number;
  salesCreated: number;
  discrepancies: number;
};

const DOCUMENT_LABELS: Record<number, string> = {
  33: "Factura",
  34: "Factura Exenta",
  39: "Boleta",
  41: "Boleta Exenta",
  43: "Liquidación Factura",
  46: "Factura de Compra",
  52: "Guía de despacho",
  56: "Nota de débito",
  61: "Nota de crédito",
  110: "Factura de Exportación",
  111: "Nota de Débito de Exportación",
  112: "Nota de Crédito de Exportación",
};

function documentLabel(type: number) {
  return DOCUMENT_LABELS[type] ?? `DTE ${type}`;
}

// Período tributario actual y anterior en horario de Chile: los documentos del
// cierre de mes siguen apareciendo en el RCV durante los primeros días del
// período siguiente.
export function defaultPeriods(reference = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit" });
  const [{ value: year }, , { value: month }] = formatter.formatToParts(reference);
  const current = new Date(Date.UTC(Number(year), Number(month) - 1, 15));
  const previous = new Date(Date.UTC(Number(year), Number(month) - 2, 15));
  const label = (date: Date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return [label(previous), label(current)];
}

function toDeadline(receptionDate: string | null) {
  if (!receptionDate) return null;
  const receipt = new Date(receptionDate);
  if (Number.isNaN(receipt.valueOf())) return null;
  receipt.setUTCDate(receipt.getUTCDate() + 8);
  return receipt.toISOString();
}

function eventStatus(receptorEvent: string | null) {
  if (!receptorEvent) return null;
  const value = receptorEvent.trim();
  if (/^ACD$/i.test(value) || /acepta/i.test(value)) return "accepted_content";
  if (/^ERM$/i.test(value) || /acuse/i.test(value)) return "receipt_acknowledged";
  if (/^(RCD|RFP|RFT)$/i.test(value) || /reclam/i.test(value)) return "claimed";
  return null;
}

function amountsDiffer(existing: number | string | null | undefined, reported: number | null) {
  if (reported === null || existing === null || existing === undefined) return false;
  return Math.abs(Number(existing) - reported) > 1;
}

async function upsertCounterparty(admin: SupabaseClient, organizationId: string, taxId: string, name: string | null, kind: "supplier" | "client") {
  const legalName = name?.trim() || taxId;
  const { data } = await admin.from("counterparties").upsert({
    organization_id: organizationId,
    legal_name: legalName,
    trade_name: legalName,
    tax_id: taxId,
    kind,
  }, { onConflict: "organization_id,tax_id" }).select("id").single();
  return data?.id ?? null;
}

async function stageEntry(admin: SupabaseClient, organizationId: string, runId: string, operation: "purchase" | "sale", period: string, entry: RcvEntry) {
  const identity = {
    organization_id: organizationId,
    operation,
    counterpart_tax_id: entry.counterpartTaxId,
    document_type: entry.documentType,
    folio: entry.folio,
  };
  const { data: existing } = await admin.from("sii_rcv_entries")
    .select("id, received_document_id, issued_document_id, match_status")
    .match(identity).maybeSingle();
  const values = {
    ...identity,
    period,
    estado_contab: "REGISTRO",
    counterpart_name: entry.counterpartName,
    issue_date: entry.issueDate,
    reception_date: entry.receptionDate,
    acknowledgment_date: entry.acknowledgmentDate,
    receptor_event: entry.receptorEvent,
    exempt_amount: entry.exemptAmount,
    net_amount: entry.netAmount,
    vat_amount: entry.vatAmount,
    other_taxes_amount: entry.otherTaxesAmount,
    total_amount: entry.totalAmount,
    source_payload: entry.raw,
    last_seen_run_id: runId,
  };
  if (existing) {
    const { error } = await admin.from("sii_rcv_entries").update(values).eq("id", existing.id);
    if (error) throw new Error("sii_rcv_stage_failed");
    return { id: existing.id, created: false, receivedDocumentId: existing.received_document_id as string | null, issuedDocumentId: existing.issued_document_id as string | null };
  }
  const { data: inserted, error } = await admin.from("sii_rcv_entries")
    .insert({ ...values, first_seen_run_id: runId })
    .select("id").single();
  if (error || !inserted) throw new Error("sii_rcv_stage_failed");
  return { id: inserted.id as string, created: true, receivedDocumentId: null, issuedDocumentId: null };
}

async function mergePurchase(admin: SupabaseClient, organizationId: string, entryId: string, period: string, entry: RcvEntry, knownDocumentId: string | null) {
  const digits = entry.counterpartTaxId.replace(/\D/g, "");
  let documentId = knownDocumentId;
  if (!documentId) {
    const { data: candidates } = await admin.from("received_documents")
      .select("id, supplier_tax_id, total_amount")
      .eq("organization_id", organizationId)
      .eq("sii_document_type", entry.documentType)
      .eq("sii_folio", entry.folio);
    documentId = (candidates ?? []).find((row) => (row.supplier_tax_id ?? "").replace(/\D/g, "") === digits)?.id ?? null;
  }

  if (documentId) {
    const { data: current } = await admin.from("received_documents").select("id, total_amount, sii_event_status").eq("id", documentId).maybeSingle();
    if (!current) return { outcome: "unmatched" as const };
    const mismatch = amountsDiffer(current.total_amount, entry.totalAmount);
    await admin.from("received_documents").update({
      sii_received_at: entry.receptionDate,
      sii_response_deadline: toDeadline(entry.receptionDate),
      sii_event_status: eventStatus(entry.receptorEvent) ?? current.sii_event_status,
      sii_last_checked_at: new Date().toISOString(),
    }).eq("id", documentId).eq("organization_id", organizationId);
    await admin.from("sii_rcv_entries").update({
      received_document_id: documentId,
      match_status: mismatch ? "amount_mismatch" : "linked",
      match_detail: mismatch ? `El SII informa total ${entry.totalAmount}; el documento registra ${current.total_amount}. Revisar antes de corregir.` : null,
    }).eq("id", entryId);
    return { outcome: mismatch ? ("amount_mismatch" as const) : ("linked" as const) };
  }

  if (!entry.issueDate) {
    await admin.from("sii_rcv_entries").update({ match_status: "unmatched", match_detail: "El SII no informó fecha de emisión; se requiere revisión manual antes de crear el documento." }).eq("id", entryId);
    return { outcome: "unmatched" as const };
  }
  const counterpartyId = await upsertCounterparty(admin, organizationId, entry.counterpartTaxId, entry.counterpartName, "supplier");
  const { data: created, error } = await admin.from("received_documents").insert({
    organization_id: organizationId,
    supplier_counterparty_id: counterpartyId,
    supplier_name: entry.counterpartName ?? entry.counterpartTaxId,
    supplier_tax_id: entry.counterpartTaxId,
    document_number: String(entry.folio),
    issue_date: entry.issueDate,
    document_type: documentLabel(entry.documentType),
    net_amount: entry.netAmount ?? 0,
    vat_amount: entry.vatAmount ?? 0,
    additional_tax_amount: entry.otherTaxesAmount ?? 0,
    total_amount: entry.totalAmount ?? 0,
    payment_status: "Pendiente de revisión",
    source_file_name: `sii-rcv-${entry.counterpartTaxId}-${entry.documentType}-${entry.folio}`,
    source_sheet_name: `RCV ${period}`,
    source_row: 0,
    sii_document_type: entry.documentType,
    sii_folio: entry.folio,
    sii_received_at: entry.receptionDate,
    sii_response_deadline: toDeadline(entry.receptionDate),
    sii_event_status: eventStatus(entry.receptorEvent),
    sii_last_checked_at: new Date().toISOString(),
  }).select("id").single();
  if (error || !created) {
    await admin.from("sii_rcv_entries").update({ match_status: "unmatched", match_detail: `No fue posible crear el documento recibido desde el RCV${error ? `: ${error.message.slice(0, 200)}` : "."}` }).eq("id", entryId);
    return { outcome: "unmatched" as const };
  }
  await admin.from("sii_rcv_entries").update({ received_document_id: created.id, match_status: "created", match_detail: null }).eq("id", entryId);
  return { outcome: "created" as const };
}

async function mergeSale(admin: SupabaseClient, organizationId: string, entryId: string, period: string, entry: RcvEntry, knownDocumentId: string | null) {
  const digits = entry.counterpartTaxId.replace(/\D/g, "");
  let documentId = knownDocumentId;
  let mismatch = false;
  if (!documentId) {
    const { data: byIdentity } = await admin.from("issued_documents")
      .select("id, total_amount")
      .eq("organization_id", organizationId)
      .eq("sii_document_type", entry.documentType)
      .eq("sii_folio", entry.folio)
      .maybeSingle();
    documentId = byIdentity?.id ?? null;
    mismatch = byIdentity ? amountsDiffer(byIdentity.total_amount, entry.totalAmount) : false;
    if (!documentId) {
      const { data: byNumber } = await admin.from("issued_documents")
        .select("id, recipient_tax_id, total_amount, sii_document_type")
        .eq("organization_id", organizationId)
        .eq("document_number", String(entry.folio))
        .is("sii_folio", null);
      const candidates = (byNumber ?? []).filter((row) => {
        const rowDigits = (row.recipient_tax_id ?? "").replace(/\D/g, "");
        return rowDigits ? rowDigits === digits : !amountsDiffer(row.total_amount, entry.totalAmount);
      });
      if (candidates.length === 1) {
        documentId = candidates[0].id;
        mismatch = amountsDiffer(candidates[0].total_amount, entry.totalAmount);
        // Consolida la identidad SII en el documento existente para el futuro.
        await admin.from("issued_documents").update({ sii_document_type: entry.documentType, sii_folio: entry.folio }).eq("id", documentId).eq("organization_id", organizationId);
      } else if (candidates.length > 1) {
        await admin.from("sii_rcv_entries").update({ match_status: "unmatched", match_detail: "Más de un documento emitido coincide con este folio; resolver manualmente." }).eq("id", entryId);
        return { outcome: "unmatched" as const };
      }
    }
  }

  if (documentId) {
    await admin.from("sii_rcv_entries").update({
      issued_document_id: documentId,
      match_status: mismatch ? "amount_mismatch" : "linked",
      match_detail: mismatch ? `El SII informa total ${entry.totalAmount}; el documento emitido registra otro monto. Revisar antes de corregir.` : null,
    }).eq("id", entryId);
    return { outcome: mismatch ? ("amount_mismatch" as const) : ("linked" as const) };
  }

  if (!entry.issueDate) {
    await admin.from("sii_rcv_entries").update({ match_status: "unmatched", match_detail: "El SII no informó fecha de emisión; se requiere revisión manual antes de crear el documento." }).eq("id", entryId);
    return { outcome: "unmatched" as const };
  }
  const counterpartyId = await upsertCounterparty(admin, organizationId, entry.counterpartTaxId, entry.counterpartName, "client");
  const { data: created, error } = await admin.from("issued_documents").insert({
    organization_id: organizationId,
    counterparty_id: counterpartyId,
    document_number: String(entry.folio),
    issue_date: entry.issueDate,
    document_type: documentLabel(entry.documentType),
    client_name: entry.counterpartName,
    recipient_name: entry.counterpartName,
    recipient_tax_id: entry.counterpartTaxId,
    net_amount: entry.netAmount,
    vat_amount: entry.vatAmount,
    total_amount: entry.totalAmount,
    // issued_documents restringe los estados permitidos; las notas de crédito
    // llegan con su estado propio.
    payment_status: entry.documentType === 61 || entry.documentType === 112 ? "Nota de crédito" : "Pendiente",
    source_file_name: `sii-rcv-${entry.counterpartTaxId}-${entry.documentType}-${entry.folio}`,
    source_sheet_name: `RCV ${period}`,
    source_row: 0,
    sii_document_type: entry.documentType,
    sii_folio: entry.folio,
  }).select("id").single();
  if (error || !created) {
    await admin.from("sii_rcv_entries").update({ match_status: "unmatched", match_detail: `No fue posible crear el documento emitido desde el RCV${error ? `: ${error.message.slice(0, 200)}` : "."}` }).eq("id", entryId);
    return { outcome: "unmatched" as const };
  }
  await admin.from("sii_rcv_entries").update({ issued_document_id: created.id, match_status: "created", match_detail: null }).eq("id", entryId);
  return { outcome: "created" as const };
}

export async function syncRcv(admin: SupabaseClient, organizationId: string, trigger: RcvSyncTrigger, requestedPeriods?: string[]): Promise<RcvSyncResult> {
  const { data: integration, error: integrationError } = await admin.from("sii_integrations")
    .select("taxpayer_rut, environment, is_enabled")
    .eq("organization_id", organizationId).maybeSingle();
  if (integrationError) throw new Error("sii_rcv_integration_unavailable");
  if (!integration?.is_enabled) throw new Error("sii_integration_not_enabled");
  if (integration.environment !== "production") throw new Error("sii_rcv_requires_production");
  const periods = requestedPeriods?.length ? requestedPeriods : defaultPeriods();
  if (periods.some((period) => !/^\d{6}$/.test(period))) throw new Error("sii_rcv_invalid_period");

  const { data: run, error: runError } = await admin.from("sii_rcv_sync_runs").insert({
    organization_id: organizationId,
    trigger_source: trigger,
    periods,
    run_status: "completed",
    completed_at: null,
  }).select("id").single();
  if (runError || !run) throw new Error("sii_rcv_run_record_failed");

  const result: RcvSyncResult = {
    runId: run.id,
    periods,
    purchasesFetched: 0,
    salesFetched: 0,
    entriesCreated: 0,
    entriesUpdated: 0,
    purchasesLinked: 0,
    purchasesCreated: 0,
    salesLinked: 0,
    salesCreated: 0,
    discrepancies: 0,
  };

  try {
    let sharedToken: string | undefined;
    for (const period of periods) {
      for (const operation of ["COMPRA", "VENTA"] satisfies RcvOperation[]) {
        const { token, entries } = await fetchRcvPeriod(integration.taxpayer_rut, period, operation, sharedToken);
        sharedToken = token;
        if (operation === "COMPRA") result.purchasesFetched += entries.length;
        else result.salesFetched += entries.length;
        for (const entry of entries) {
          const staged = await stageEntry(admin, organizationId, run.id, operation === "COMPRA" ? "purchase" : "sale", period, entry);
          if (staged.created) result.entriesCreated += 1;
          else result.entriesUpdated += 1;
          const merge = operation === "COMPRA"
            ? await mergePurchase(admin, organizationId, staged.id, period, entry, staged.receivedDocumentId)
            : await mergeSale(admin, organizationId, staged.id, period, entry, staged.issuedDocumentId);
          if (merge.outcome === "amount_mismatch") result.discrepancies += 1;
          else if (operation === "COMPRA" && merge.outcome === "linked") result.purchasesLinked += 1;
          else if (operation === "COMPRA" && merge.outcome === "created") result.purchasesCreated += 1;
          else if (operation === "VENTA" && merge.outcome === "linked") result.salesLinked += 1;
          else if (operation === "VENTA" && merge.outcome === "created") result.salesCreated += 1;
        }
      }
    }
    await admin.from("sii_rcv_sync_runs").update({
      completed_at: new Date().toISOString(),
      run_status: "completed",
      purchase_entries_fetched: result.purchasesFetched,
      sale_entries_fetched: result.salesFetched,
      entries_created: result.entriesCreated,
      entries_updated: result.entriesUpdated,
      purchases_linked: result.purchasesLinked,
      purchases_created: result.purchasesCreated,
      sales_linked: result.salesLinked,
      sales_created: result.salesCreated,
      discrepancies: result.discrepancies,
    }).eq("id", run.id);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : "sii_rcv_sync_failed";
    await admin.from("sii_rcv_sync_runs").update({
      completed_at: new Date().toISOString(),
      run_status: "failed",
      purchase_entries_fetched: result.purchasesFetched,
      sale_entries_fetched: result.salesFetched,
      entries_created: result.entriesCreated,
      entries_updated: result.entriesUpdated,
      error_detail: detail,
    }).eq("id", run.id);
    throw error;
  }
}
