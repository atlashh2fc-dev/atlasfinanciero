import { createHash } from "crypto";
import { XMLParser } from "fast-xml-parser";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { SupabaseClient } from "@supabase/supabase-js";

type ImportedLine = {
  lineNumber: number;
  itemCode: string | null;
  description: string;
  quantity: number | null;
  unitName: string | null;
  unitPrice: number | null;
  discountAmount: number;
  surchargeAmount: number;
  lineTotal: number;
};

type ParsedDte = {
  documentType: number;
  documentLabel: string;
  folio: number;
  issueDate: string;
  dueDate: string | null;
  supplierName: string;
  supplierTaxId: string;
  netAmount: number;
  vatAmount: number;
  additionalTaxAmount: number;
  totalAmount: number;
  purchaseOrderReference: string | null;
  lines: ImportedLine[];
};

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false });

function item(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function list(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(item).filter((value): value is Record<string, unknown> => Boolean(value));
}

function findDte(value: unknown): Record<string, unknown> | null {
  const candidate = item(value);
  if (!candidate) return null;
  if (item(candidate.Documento)) return candidate;
  for (const child of Object.values(candidate)) {
    const found = findDte(child);
    if (found) return found;
  }
  return null;
}

function text(value: unknown) {
  const valueItem = Array.isArray(value) ? value[0] : value;
  return typeof valueItem === "string" || typeof valueItem === "number" ? String(valueItem).trim() : "";
}

function numberValue(value: unknown) {
  const parsed = Number(text(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateValue(value: unknown) {
  const candidate = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function documentLabel(type: number) {
  return ({ 33: "Factura", 34: "Factura Exenta", 43: "Liquidación Factura", 52: "Guía de despacho", 56: "Nota de débito", 61: "Nota de crédito" } as Record<number, string>)[type] ?? `DTE ${type}`;
}

function parseDte(xml: Buffer): ParsedDte {
  const parsed = parser.parse(xml.toString("utf8")) as Record<string, unknown>;
  const dte = findDte(parsed.DTE) ?? findDte(parsed);
  const document = item(dte?.Documento);
  const header = item(document?.Encabezado);
  const id = item(header?.IdDoc);
  const issuer = item(header?.Emisor);
  const totals = item(header?.Totales);
  if (!document || !id || !issuer || !totals) throw new Error("sii_xml_structure_invalid");
  const documentType = Math.trunc(numberValue(id.TipoDTE));
  const folio = Math.trunc(numberValue(id.Folio));
  const issueDate = dateValue(id.FchEmis);
  const supplierTaxId = text(issuer.RUTEmisor);
  const supplierName = text(issuer.RznSoc) || text(issuer.RznSocEmisor);
  if (!documentType || !folio || !issueDate || !supplierTaxId || !supplierName) throw new Error("sii_xml_identity_invalid");
  const references = list(document.Referencia);
  const purchaseOrderReference = references.map((reference) => text(reference.FolioRef)).find(Boolean) ?? null;
  const lines = list(document.Detalle).map((detail, index) => ({
    lineNumber: Math.trunc(numberValue(detail.NroLinDet)) || index + 1,
    itemCode: text(detail.CdgItem && item(detail.CdgItem)?.VlrCodigo) || null,
    description: text(detail.NmbItem) || "Ítem sin descripción",
    quantity: text(detail.QtyItem) ? numberValue(detail.QtyItem) : null,
    unitName: text(detail.UnmdItem) || null,
    unitPrice: text(detail.PrcItem) ? numberValue(detail.PrcItem) : null,
    discountAmount: numberValue(detail.DescuentoMonto),
    surchargeAmount: numberValue(detail.RecargoMonto),
    lineTotal: numberValue(detail.MontoItem),
  }));
  return {
    documentType,
    documentLabel: documentLabel(documentType),
    folio,
    issueDate,
    dueDate: dateValue(id.FchVenc),
    supplierName,
    supplierTaxId,
    netAmount: numberValue(totals.MntNeto),
    vatAmount: numberValue(totals.IVA),
    additionalTaxAmount: numberValue(totals.MntImp),
    totalAmount: numberValue(totals.MntTotal),
    purchaseOrderReference,
    lines,
  };
}

function mailConfig() {
  const host = process.env.SII_IMAP_HOST;
  const user = process.env.SII_IMAP_USER;
  const pass = process.env.SII_IMAP_PASSWORD;
  const port = Number(process.env.SII_IMAP_PORT ?? "993");
  if (!host || !user || !pass || !Number.isInteger(port)) throw new Error("sii_mail_not_configured");
  return { host, user, pass, port };
}

async function importXml(admin: SupabaseClient, organizationId: string, xml: Buffer, messageId: string, attachmentIndex: number) {
  const dte = parseDte(xml);
  const checksum = createHash("sha256").update(xml).digest("hex");
  const [{ data: byChecksum }, { data: byIdentity }, { data: byDocumentNumber }] = await Promise.all([
    admin.from("received_documents").select("id").eq("organization_id", organizationId).eq("sii_xml_sha256", checksum).maybeSingle(),
    admin.from("received_documents").select("id").eq("organization_id", organizationId).eq("supplier_tax_id", dte.supplierTaxId).eq("sii_document_type", dte.documentType).eq("sii_folio", dte.folio).maybeSingle(),
    admin.from("received_documents").select("id").eq("organization_id", organizationId).eq("supplier_tax_id", dte.supplierTaxId).eq("document_number", String(dte.folio)).is("sii_document_type", null).maybeSingle(),
  ]);
  const existingId = byChecksum?.id ?? byIdentity?.id ?? byDocumentNumber?.id ?? null;
  const { data: counterparty } = await admin.from("counterparties").upsert({
    organization_id: organizationId,
    legal_name: dte.supplierName,
    trade_name: dte.supplierName,
    tax_id: dte.supplierTaxId,
    kind: "supplier",
  }, { onConflict: "organization_id,tax_id" }).select("id").single();
  const storagePath = `${organizationId}/sii/${checksum}.xml`;
  await admin.storage.from("received-document-files").upload(storagePath, xml, { contentType: "application/xml", upsert: false }).catch(() => null);
  const documentData = {
    organization_id: organizationId,
    supplier_counterparty_id: counterparty?.id ?? null,
    supplier_name: dte.supplierName,
    supplier_tax_id: dte.supplierTaxId,
    document_number: String(dte.folio),
    issue_date: dte.issueDate,
    document_type: dte.documentLabel,
    net_amount: dte.netAmount,
    vat_amount: dte.vatAmount,
    additional_tax_amount: dte.additionalTaxAmount,
    total_amount: dte.totalAmount,
    due_date: dte.dueDate,
    due_month: dte.dueDate ? new Intl.DateTimeFormat("es-CL", { month: "long" }).format(new Date(`${dte.dueDate}T12:00:00`)).replace(/^./, (letter) => letter.toUpperCase()) : null,
    payment_status: "Pendiente de revisión",
    source_file_name: `sii-mail-${messageId.slice(0, 150)}`,
    source_sheet_name: "IMAP",
    source_row: attachmentIndex,
    sii_document_type: dte.documentType,
    sii_folio: dte.folio,
    sii_xml_path: storagePath,
    sii_xml_sha256: checksum,
    sii_mail_message_id: messageId,
    sii_purchase_order_reference: dte.purchaseOrderReference,
  };
  const result = existingId
    ? await admin.from("received_documents").update(documentData).eq("id", existingId).eq("organization_id", organizationId).select("id").single()
    : await admin.from("received_documents").insert(documentData).select("id").single();
  if (result.error || !result.data) throw new Error("sii_document_upsert_failed");
  await admin.from("received_document_lines").delete().eq("received_document_id", result.data.id).eq("organization_id", organizationId);
  if (dte.lines.length) await admin.from("received_document_lines").insert(dte.lines.map((line) => ({
    organization_id: organizationId,
    received_document_id: result.data.id,
    line_number: line.lineNumber,
    item_code: line.itemCode,
    description: line.description,
    quantity: line.quantity,
    unit_name: line.unitName,
    unit_price: line.unitPrice,
    discount_amount: line.discountAmount,
    surcharge_amount: line.surchargeAmount,
    line_total: line.lineTotal,
  })));
  return existingId ? "updated" : "created";
}

export async function syncSiiMailbox(admin: SupabaseClient, organizationId: string) {
  const config = mailConfig();
  const client = new ImapFlow({ host: config.host, port: config.port, secure: true, auth: { user: config.user, pass: config.pass }, logger: false });
  let created = 0;
  let updated = 0;
  let scanned = 0;
  let stage = "connect";
  try {
    await client.connect();
    stage = "open_inbox";
    const lock = await client.getMailboxLock("INBOX");
    try {
      stage = "search_unseen";
      const searched = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(searched) ? searched.slice(-25) : [];
      stage = "fetch_messages";
      for await (const message of client.fetch(uids, { uid: true, source: true, envelope: true }, { uid: true })) {
        scanned += 1;
        if (!message.source) continue;
        stage = "parse_message";
        const mail = await simpleParser(message.source, {});
        const messageId = mail.messageId || `uid-${message.uid}`;
        let imported = 0;
        for (const [index, attachment] of (mail.attachments ?? []).entries()) {
          const isXml = attachment.contentType.includes("xml") || attachment.filename?.toLowerCase().endsWith(".xml");
          if (!isXml) continue;
          stage = "import_xml";
          const outcome = await importXml(admin, organizationId, attachment.content, messageId, index + 1);
          if (outcome === "created") created += 1;
          else updated += 1;
          imported += 1;
        }
        if (imported) {
          stage = "mark_seen";
          await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  } catch (error) {
    const imapError = error as Error & { code?: string; responseText?: string; response?: string };
    const message = imapError instanceof Error ? imapError.message : String(error);
    const detail = [imapError.code, imapError.responseText, imapError.response]
      .filter((value): value is string => typeof value === "string" && Boolean(value))
      .join(" · ");
    throw new Error(`sii_imap_${stage}: ${message}${detail ? ` (${detail})` : ""}`);
  } finally {
    await client.logout().catch(() => undefined);
  }
  return { scanned, created, updated };
}
