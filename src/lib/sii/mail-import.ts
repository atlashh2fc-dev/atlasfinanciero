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

type PayableMatch = {
  documentId: string | null;
  status: "matched" | "review_required";
  reason: string;
};

type PaymentCandidate = {
  id: string;
  document_number: string | null;
  supplier_tax_id: string | null;
  total_amount: number | string;
  payment_proof_path: string | null;
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

function imapClient(config: ReturnType<typeof mailConfig>) {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 20_000,
    logger: false,
  });
}

function normalizedDigits(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

function containsExactNumber(haystack: string, value: string) {
  const normalized = normalizedDigits(value).replace(/^0+/, "");
  if (!normalized || normalized.length < 3) return false;
  return new RegExp(`(?:^|\\D)0*${normalized}(?=\\D|$)`).test(haystack);
}

function containsAmount(haystack: string, value: number | string) {
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const formatted = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(amount);
  return haystack.includes(String(amount)) || haystack.includes(formatted) || haystack.includes(`$${formatted}`);
}

function paymentEmail(text: string) {
  return /(?:comprobante|confirmaci[oó]n|transferencia|pagad[oa]|pago|abono|deposito|dep[oó]sito|cartola)/i.test(text);
}

function matchPaymentProof(documents: PaymentCandidate[], searchable: string): PayableMatch {
  const byFolio = documents.filter((document) => document.document_number && containsExactNumber(searchable, document.document_number));
  if (byFolio.length === 1) {
    const document = byFolio[0];
    if (document.payment_proof_path) return { documentId: null, status: "review_required", reason: "La factura identificada ya tiene un comprobante adjunto." };
    return { documentId: document.id, status: "matched", reason: "Coincidencia exacta por folio de factura." };
  }
  if (byFolio.length > 1) return { documentId: null, status: "review_required", reason: "El folio indicado coincide con más de una cuenta por pagar." };

  const byRutAndAmount = documents.filter((document) => {
    const rut = normalizedDigits(document.supplier_tax_id);
    return rut.length >= 8 && containsExactNumber(searchable, rut) && containsAmount(searchable, document.total_amount);
  });
  if (byRutAndAmount.length === 1) {
    const document = byRutAndAmount[0];
    if (document.payment_proof_path) return { documentId: null, status: "review_required", reason: "La factura identificada ya tiene un comprobante adjunto." };
    return { documentId: document.id, status: "matched", reason: "Coincidencia por RUT de proveedor y monto exacto." };
  }
  if (byRutAndAmount.length > 1) return { documentId: null, status: "review_required", reason: "RUT y monto coinciden con más de una cuenta por pagar." };
  return { documentId: null, status: "review_required", reason: "No se encontró una coincidencia inequívoca con una cuenta por pagar." };
}

function attachmentExtension(filename: string | undefined, mimeType: string) {
  const extension = filename?.split(".").pop()?.toLowerCase();
  if (extension && ["pdf", "jpg", "jpeg", "png"].includes(extension)) return extension === "jpeg" ? "jpg" : extension;
  return mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
}

function paymentProofAttachment(contentType: string, filename: string | undefined, size: number) {
  const mimeType = contentType.toLowerCase().split(";")[0];
  return size > 0 && size <= 52_428_800 && (
    mimeType === "application/pdf" || mimeType === "image/jpeg" || mimeType === "image/png" || /\.(pdf|jpe?g|png)$/i.test(filename ?? "")
  );
}

function dteXmlAttachment(contentType: string, filename: string | undefined) {
  const mimeType = contentType.toLowerCase().split(";")[0].trim();
  return filename?.toLowerCase().endsWith(".xml")
    || mimeType === "application/xml"
    || mimeType === "text/xml"
    || mimeType.endsWith("+xml");
}

function invoiceFileAttachment(contentType: string, filename: string | undefined, size: number) {
  return paymentProofAttachment(contentType, filename, size);
}

function matchingInvoiceFile(dte: ParsedDte, attachments: { contentType: string; filename?: string; content: Buffer; size?: number }[]) {
  const files = attachments.filter((attachment) => invoiceFileAttachment(attachment.contentType, attachment.filename, attachment.size ?? attachment.content.length));
  if (files.length === 1) return files[0];
  return files.find((attachment) => {
    const name = `${attachment.filename ?? ""}`.replace(/\D/g, "");
    return name.includes(String(dte.folio)) || name.includes(normalizedDigits(dte.supplierTaxId));
  }) ?? null;
}

async function attachInvoiceFile(admin: SupabaseClient, organizationId: string, documentId: string, attachment: { contentType: string; filename?: string; content: Buffer; size?: number }) {
  const fileType = attachment.contentType.toLowerCase();
  const fileName = attachment.filename?.toLowerCase() ?? "";
  const mimeType = fileType.includes("pdf") || fileName.endsWith(".pdf")
    ? "application/pdf"
    : fileType.includes("png") || fileName.endsWith(".png") ? "image/png" : "image/jpeg";
  const checksum = createHash("sha256").update(attachment.content).digest("hex");
  const storagePath = `${organizationId}/sii/pdfs/${checksum}.${attachmentExtension(attachment.filename, mimeType)}`;
  const { error: uploadError } = await admin.storage.from("received-document-files").upload(storagePath, attachment.content, { contentType: mimeType, upsert: false });
  if (uploadError && !/already exists/i.test(uploadError.message)) throw new Error("sii_invoice_file_storage_failed");
  const { error: updateError } = await admin.from("received_documents").update({
    attachment_path: storagePath,
    attachment_name: (attachment.filename || `factura-${checksum.slice(0, 12)}.${attachmentExtension(attachment.filename, mimeType)}`).slice(0, 300),
    attachment_mime_type: mimeType,
    attachment_size: attachment.size ?? attachment.content.length,
  }).eq("id", documentId).eq("organization_id", organizationId);
  if (updateError) throw new Error("sii_invoice_file_attach_failed");
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
  return { outcome: existingId ? "updated" as const : "created" as const, documentId: result.data.id, dte };
}

export async function syncSiiMailbox(admin: SupabaseClient, organizationId: string, messageLimit = 25) {
  const config = mailConfig();
  const client = imapClient(config);
  let created = 0;
  let updated = 0;
  let scanned = 0;
  let skipped = 0;
  let filesAttached = 0;
  let stage = "connect";
  try {
    await client.connect();
    stage = "open_inbox";
    const lock = await client.getMailboxLock("INBOX");
    try {
      stage = "search_unseen";
      const searched = await client.search({ seen: false }, { uid: true });
      const candidates = Array.isArray(searched) ? searched.slice(-100) : [];
      const headers: { uid: number; messageId: string }[] = [];
      for await (const message of client.fetch(candidates, { uid: true, envelope: true }, { uid: true })) {
        headers.push({ uid: message.uid, messageId: (message.envelope?.messageId || `uid-${message.uid}`).slice(0, 500) });
      }
      const { data: processed, error: processedError } = headers.length
        ? await admin.from("sii_mail_processed_messages").select("message_id").eq("organization_id", organizationId).in("message_id", headers.map((header) => header.messageId))
        : { data: [], error: null };
      if (processedError) throw new Error("sii_mail_processed_messages_load_failed");
      const alreadyProcessed = new Set((processed ?? []).map((row) => row.message_id));
      const uids = headers.filter((header) => !alreadyProcessed.has(header.messageId)).slice(-Math.max(1, Math.min(messageLimit, 25))).map((header) => header.uid);
      stage = "fetch_messages";
      for await (const message of client.fetch(uids, { uid: true, source: true, envelope: true }, { uid: true })) {
        scanned += 1;
        if (!message.source) continue;
        const messageId = (message.envelope?.messageId || `uid-${message.uid}`).slice(0, 500);
        let imported = 0;
        let processingStatus: "imported" | "ignored" | "failed" = "ignored";
        let detail: string | null = null;
        let emailSubject: string | null = null;
        let senderName: string | null = null;
        let senderAddress: string | null = null;
        let receivedAt: string | null = null;
        let attachmentCount = 0;
        let dteAttachmentCount = 0;
        try {
          stage = "parse_message";
          const mail = await simpleParser(message.source, {});
          const xmlAttachments = (mail.attachments ?? []).filter((attachment) => dteXmlAttachment(attachment.contentType, attachment.filename));
          const sender = mail.from?.value[0];
          emailSubject = mail.subject?.slice(0, 1000) || null;
          senderName = sender?.name?.slice(0, 500) || null;
          senderAddress = sender?.address?.slice(0, 500) || null;
          receivedAt = mail.date?.toISOString() ?? null;
          attachmentCount = mail.attachments?.length ?? 0;
          dteAttachmentCount = xmlAttachments.length;
          for (const [index, attachment] of xmlAttachments.entries()) {
            try {
              stage = "import_xml";
              const result = await importXml(admin, organizationId, attachment.content, messageId, index + 1);
              if (result.outcome === "created") created += 1;
              else updated += 1;
              const invoiceFile = matchingInvoiceFile(result.dte, (mail.attachments ?? []) as { contentType: string; filename?: string; content: Buffer; size?: number }[]);
              if (invoiceFile) {
                try {
                  stage = "attach_invoice_file";
                  await attachInvoiceFile(admin, organizationId, result.documentId, invoiceFile);
                  filesAttached += 1;
                } catch (fileError) {
                  console.error("No fue posible adjuntar el PDF recibido", fileError);
                }
              }
              imported += 1;
            } catch (importError) {
              skipped += 1;
              detail = "XML sin una factura recibida válida";
              console.error("Se omitió un XML que no corresponde a una factura recibida", importError);
            }
          }
          if (!xmlAttachments.length) detail = "Correo sin DTE";
          processingStatus = imported ? "imported" : "ignored";
        } catch (messageError) {
          skipped += 1;
          processingStatus = "failed";
          detail = messageError instanceof Error ? messageError.message.slice(0, 500) : "No fue posible leer el correo";
          console.error("No fue posible procesar un correo tributario", messageError);
        }
        stage = "record_message";
        const { error: recordError } = await admin.from("sii_mail_processed_messages").upsert({
          organization_id: organizationId,
          message_id: messageId,
          imap_uid: message.uid,
          processing_status: processingStatus,
          detail,
          email_subject: emailSubject,
          sender_name: senderName,
          sender_address: senderAddress,
          received_at: receivedAt,
          attachment_count: attachmentCount,
          dte_attachment_count: dteAttachmentCount,
          processed_at: new Date().toISOString(),
        }, { onConflict: "organization_id,message_id" });
        if (recordError) throw new Error("sii_mail_processed_message_record_failed");
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
  return { scanned, created, updated, skipped, filesAttached };
}

export async function syncPaymentProofMailbox(admin: SupabaseClient, organizationId: string, messageLimit = 50) {
  const config = mailConfig();
  const client = imapClient(config);
  let scanned = 0;
  let matched = 0;
  let reviewRequired = 0;
  let stage = "connect";
  try {
    await client.connect();
    stage = "open_inbox";
    const lock = await client.getMailboxLock("INBOX");
    try {
      stage = "load_payables";
      const { data: documents, error: documentsError } = await admin
        .from("received_documents")
        .select("id, document_number, supplier_tax_id, total_amount, payment_proof_path")
        .eq("organization_id", organizationId)
        .not("document_number", "is", null);
      if (documentsError) throw new Error("payment_proof_payables_load_failed");
      stage = "search_unseen";
      const searched = await client.search({ seen: false }, { uid: true });
      const candidates = Array.isArray(searched) ? searched.slice(-100) : [];
      const headers: { uid: number; messageId: string }[] = [];
      for await (const message of client.fetch(candidates, { uid: true, envelope: true }, { uid: true })) {
        headers.push({ uid: message.uid, messageId: (message.envelope?.messageId || `uid-${message.uid}`).slice(0, 500) });
      }
      const { data: processed, error: processedError } = headers.length
        ? await admin.from("mail_payment_processed_messages").select("message_id").eq("organization_id", organizationId).in("message_id", headers.map((header) => header.messageId))
        : { data: [], error: null };
      if (processedError) throw new Error("payment_proof_processed_messages_load_failed");
      const alreadyProcessed = new Set((processed ?? []).map((row) => row.message_id));
      const uids = headers.filter((header) => !alreadyProcessed.has(header.messageId)).slice(-Math.max(1, Math.min(messageLimit, 50))).map((header) => header.uid);
      stage = "fetch_messages";
      for await (const message of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
        if (!message.source) continue;
        const messageId = `uid-${message.uid}`;
        let processingStatus: "imported" | "ignored" | "failed" = "ignored";
        let detail: string | null = null;
        let relevant = false;
        let emailSubject: string | null = null;
        let senderName: string | null = null;
        let senderAddress: string | null = null;
        let receivedAt: string | null = null;
        let attachmentCount = 0;
        try {
          stage = "parse_message";
          const mail = await simpleParser(message.source, {});
          const canonicalMessageId = (mail.messageId || messageId).slice(0, 500);
          const subject = mail.subject ?? "";
          const sender = mail.from?.value[0];
          emailSubject = subject.slice(0, 1000) || null;
          senderName = sender?.name?.slice(0, 500) || null;
          senderAddress = sender?.address?.slice(0, 500) || null;
          receivedAt = mail.date?.toISOString() ?? null;
          attachmentCount = mail.attachments?.length ?? 0;
          const attachmentNames = (mail.attachments ?? []).map((attachment) => attachment.filename ?? "").join(" ");
          const searchable = `${subject}\n${mail.text ?? ""}\n${attachmentNames}`;
          const attachments = (mail.attachments ?? []).filter((attachment) => paymentProofAttachment(attachment.contentType, attachment.filename, attachment.size));
          if (!attachments.length || !paymentEmail(searchable)) {
            detail = "Correo sin comprobante de pago";
          } else {
            relevant = true;
            scanned += 1;
            for (const attachment of attachments) {
              const checksum = createHash("sha256").update(attachment.content).digest("hex");
              const { data: alreadyImported } = await admin
                .from("mail_payment_receipts")
                .select("id")
                .eq("organization_id", organizationId)
                .eq("attachment_sha256", checksum)
                .maybeSingle();
              if (alreadyImported) continue;
              stage = "match_payment_proof";
              const result = matchPaymentProof((documents ?? []) as PaymentCandidate[], searchable);
              const mimeType = attachment.contentType.toLowerCase().split(";")[0] === "application/pdf" || attachment.contentType.toLowerCase().includes("pdf")
                ? "application/pdf"
                : attachment.contentType.toLowerCase().includes("png") ? "image/png" : "image/jpeg";
              const safeName = (attachment.filename || `comprobante-${checksum.slice(0, 12)}.${attachmentExtension(attachment.filename, mimeType)}`).slice(0, 300);
              const storagePath = `${organizationId}/payment-proofs/mail/${checksum}.${attachmentExtension(attachment.filename, mimeType)}`;
              stage = "store_payment_proof";
              const { error: uploadError } = await admin.storage.from("received-document-files").upload(storagePath, attachment.content, { contentType: mimeType, upsert: false });
              if (uploadError && !/already exists/i.test(uploadError.message)) throw new Error("payment_proof_storage_failed");
              if (result.documentId) {
                stage = "attach_payment_proof";
                const { error: attachError } = await admin.from("received_documents").update({
                  payment_proof_path: storagePath,
                  payment_proof_name: safeName,
                  payment_proof_mime_type: mimeType,
                  payment_proof_size: attachment.size,
                }).eq("id", result.documentId).eq("organization_id", organizationId).is("payment_proof_path", null);
                if (attachError) throw new Error("payment_proof_attach_failed");
                matched += 1;
              } else {
                reviewRequired += 1;
              }
              stage = "record_payment_proof";
              const { error: receiptError } = await admin.from("mail_payment_receipts").insert({
                organization_id: organizationId,
                received_document_id: result.documentId,
                message_id: canonicalMessageId,
                attachment_sha256: checksum,
                attachment_name: safeName,
                attachment_mime_type: mimeType,
                attachment_size: attachment.size,
                storage_path: storagePath,
                email_subject: subject.slice(0, 1000) || null,
                received_at: mail.date?.toISOString() ?? null,
                match_status: result.status,
                match_reason: result.reason,
              });
              if (receiptError) throw new Error("payment_proof_receipt_record_failed");
            }
            processingStatus = "imported";
          }
          stage = "record_payment_message";
          const { error: recordError } = await admin.from("mail_payment_processed_messages").upsert({
            organization_id: organizationId,
            message_id: canonicalMessageId,
            imap_uid: message.uid,
            processing_status: processingStatus,
            detail,
            email_subject: emailSubject,
            sender_name: senderName,
            sender_address: senderAddress,
            received_at: receivedAt,
            attachment_count: attachmentCount,
            processed_at: new Date().toISOString(),
          }, { onConflict: "organization_id,message_id" });
          if (recordError) throw new Error("payment_proof_processed_message_record_failed");
        } catch (messageError) {
          processingStatus = "failed";
          detail = messageError instanceof Error ? messageError.message.slice(0, 500) : "No fue posible leer el correo";
          await admin.from("mail_payment_processed_messages").upsert({ organization_id: organizationId, message_id: messageId, imap_uid: message.uid, processing_status: processingStatus, detail, email_subject: emailSubject, sender_name: senderName, sender_address: senderAddress, received_at: receivedAt, attachment_count: attachmentCount, processed_at: new Date().toISOString() }, { onConflict: "organization_id,message_id" });
          console.error("No fue posible procesar un comprobante de pago", messageError);
        }
        if (relevant) {
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
    throw new Error(`payment_proof_imap_${stage}: ${message}${detail ? ` (${detail})` : ""}`);
  } finally {
    await client.logout().catch(() => undefined);
  }
  return { scanned, matched, reviewRequired };
}
