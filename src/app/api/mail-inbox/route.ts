import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationExpenseReadAccess } from "@/lib/admin-access";

export const dynamic = "force-dynamic";

type InboxItem = {
  id: string;
  kind: "invoice" | "payment";
  messageId: string;
  subject: string | null;
  senderName: string | null;
  senderAddress: string | null;
  receivedAt: string | null;
  processedAt: string;
  status: "imported" | "ignored" | "failed" | "review_required" | "matched";
  detail: string | null;
  attachmentCount: number;
  documentId: string | null;
  documentLabel: string | null;
  documentStatus: string | null;
};

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const [invoiceMessages, paymentMessages, paymentReceipts] = await Promise.all([
    context.supabase
      .from("sii_mail_processed_messages")
      .select("id, message_id, processing_status, detail, processed_at, email_subject, sender_name, sender_address, received_at, attachment_count, dte_attachment_count")
      .eq("organization_id", organizationId)
      .order("processed_at", { ascending: false })
      .limit(150),
    context.supabase
      .from("mail_payment_processed_messages")
      .select("id, message_id, processing_status, detail, processed_at, email_subject, sender_name, sender_address, received_at, attachment_count")
      .eq("organization_id", organizationId)
      .order("processed_at", { ascending: false })
      .limit(150),
    context.supabase
      .from("mail_payment_receipts")
      .select("message_id, received_document_id, email_subject, received_at, match_status, match_reason")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(150),
  ]);

  if (invoiceMessages.error || paymentMessages.error || paymentReceipts.error) {
    return NextResponse.json({ error: "unable_to_load_mail_inbox" }, { status: 500 });
  }

  const paymentDocumentIds = (paymentReceipts.data ?? [])
    .map((receipt) => receipt.received_document_id)
    .filter((id): id is string => Boolean(id));
  const [invoiceDocuments, paymentDocuments] = await Promise.all([
    context.supabase
      .from("received_documents")
      .select("id, sii_mail_message_id, supplier_name, document_number, payment_status")
      .eq("organization_id", organizationId)
      .not("sii_mail_message_id", "is", null),
    paymentDocumentIds.length
      ? context.supabase
        .from("received_documents")
        .select("id, sii_mail_message_id, supplier_name, document_number, payment_status")
        .eq("organization_id", organizationId)
        .in("id", paymentDocumentIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (invoiceDocuments.error || paymentDocuments.error) return NextResponse.json({ error: "unable_to_load_mail_inbox" }, { status: 500 });

  const relatedDocuments = [...(invoiceDocuments.data ?? []), ...(paymentDocuments.data ?? [])];
  const documentsByMessageId = new Map(relatedDocuments.map((document) => [document.sii_mail_message_id, document]));
  const receiptsByMessageId = new Map((paymentReceipts.data ?? []).map((receipt) => [receipt.message_id, receipt]));
  const documentsById = new Map(relatedDocuments.map((document) => [document.id, document]));
  const items: InboxItem[] = [
    ...(invoiceMessages.data ?? []).map((message) => {
      const document = documentsByMessageId.get(message.message_id);
      return {
        id: `invoice-${message.id}`,
        kind: "invoice" as const,
        messageId: message.message_id,
        subject: message.email_subject,
        senderName: message.sender_name,
        senderAddress: message.sender_address,
        receivedAt: message.received_at,
        processedAt: message.processed_at,
        status: message.processing_status,
        detail: message.detail,
        attachmentCount: message.attachment_count,
        documentId: document?.id ?? null,
        documentLabel: document ? `${document.supplier_name} · Folio ${document.document_number ?? "—"}` : null,
        documentStatus: document?.payment_status ?? null,
      };
    }),
    ...(paymentMessages.data ?? []).map((message) => {
      const receipt = receiptsByMessageId.get(message.message_id);
      const document = receipt?.received_document_id ? documentsById.get(receipt.received_document_id) : null;
      return {
        id: `payment-${message.id}`,
        kind: "payment" as const,
        messageId: message.message_id,
        subject: receipt?.email_subject ?? message.email_subject,
        senderName: message.sender_name,
        senderAddress: message.sender_address,
        receivedAt: receipt?.received_at ?? message.received_at,
        processedAt: message.processed_at,
        status: receipt?.match_status ?? message.processing_status,
        detail: receipt?.match_reason ?? message.detail,
        attachmentCount: message.attachment_count,
        documentId: document?.id ?? receipt?.received_document_id ?? null,
        documentLabel: document ? `${document.supplier_name} · Folio ${document.document_number ?? "—"}` : null,
        documentStatus: document?.payment_status ?? null,
      };
    }),
  ].sort((left, right) => new Date(right.receivedAt ?? right.processedAt).valueOf() - new Date(left.receivedAt ?? left.processedAt).valueOf());

  return NextResponse.json({ items });
}
