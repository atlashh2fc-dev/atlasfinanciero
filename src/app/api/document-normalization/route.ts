import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationProcurementAccess,
} from "@/lib/admin-access";

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const documentKinds = new Set(["issued", "received", "direct"]);

function safeFileName(fileName: string) {
  return (
    fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "factura"
  );
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const organizationId = form.get("organizationId");
  const recordId = form.get("recordId");
  const kind = form.get("kind");
  const invoiceNumberValue = form.get("invoiceNumber");
  const invoiceNumber =
    typeof invoiceNumberValue === "string" ? invoiceNumberValue.trim() : "";
  const file = form.get("file");

  if (
    !isUuid(organizationId) ||
    !isUuid(recordId) ||
    typeof kind !== "string" ||
    !documentKinds.has(kind) ||
    !invoiceNumber ||
    invoiceNumber.length > 80 ||
    !(file instanceof File) ||
    file.size === 0 ||
    file.size > 52_428_800 ||
    !allowedMimeTypes.has(file.type)
  )
    return NextResponse.json({ error: "invalid_normalization" }, { status: 400 });

  const context = await requireOrganizationProcurementAccess(organizationId);
  if (context.error || !context.supabase || !context.membership)
    return NextResponse.json({ error: context.error }, { status: context.status });
  if (
    kind !== "issued" &&
    !["administrator", "finance"].includes(context.membership.role)
  )
    return NextResponse.json({ error: "finance_access_required" }, { status: 403 });

  if (kind === "direct") {
    const { data: payable, error: payableError } = await context.supabase
      .from("direct_payables")
      .select("invoice_number, is_reference")
      .eq("id", recordId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (payableError || !payable)
      return NextResponse.json({ error: "record_not_found" }, { status: 404 });
    if (payable.is_reference)
      return NextResponse.json({ error: "reference_not_normalizable" }, { status: 409 });

    const storagePath = `${organizationId}/${recordId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error: uploadError } = await context.supabase.storage
      .from("direct-payable-files")
      .upload(storagePath, file, { contentType: file.type, upsert: false });
    if (uploadError)
      return NextResponse.json({ error: "unable_to_upload_invoice" }, { status: 409 });

    const { error: updateError } = await context.supabase
      .from("direct_payables")
      .update({ invoice_number: invoiceNumber })
      .eq("id", recordId)
      .eq("organization_id", organizationId);
    if (updateError) {
      await context.supabase.storage.from("direct-payable-files").remove([storagePath]);
      return NextResponse.json({ error: "unable_to_update_invoice_number" }, { status: 409 });
    }

    const { error: attachmentError } = await context.supabase
      .from("direct_payable_attachments")
      .insert({
        organization_id: organizationId,
        direct_payable_id: recordId,
        storage_path: storagePath,
        file_name: file.name.slice(0, 300),
        mime_type: file.type,
        file_size: file.size,
      });
    if (attachmentError) {
      await context.supabase
        .from("direct_payables")
        .update({ invoice_number: payable.invoice_number })
        .eq("id", recordId)
        .eq("organization_id", organizationId);
      await context.supabase.storage.from("direct-payable-files").remove([storagePath]);
      return NextResponse.json({ error: "unable_to_save_invoice" }, { status: 409 });
    }
    return NextResponse.json({ recordId, invoiceNumber });
  }

  const table = kind === "issued" ? "issued_documents" : "received_documents";
  const bucket = kind === "issued" ? "issued-document-files" : "received-document-files";
  const { data: document, error: documentError } = await context.supabase
    .from(table)
    .select("attachment_path")
    .eq("id", recordId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (documentError || !document)
    return NextResponse.json({ error: "record_not_found" }, { status: 404 });

  const storagePath = `${organizationId}/normalized-invoices/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { error: uploadError } = await context.supabase.storage
    .from(bucket)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError)
    return NextResponse.json({ error: "unable_to_upload_invoice" }, { status: 409 });

  const { error: updateError } = await context.supabase
    .from(table)
    .update({
      document_number: invoiceNumber,
      attachment_path: storagePath,
      attachment_name: file.name.slice(0, 300),
      attachment_mime_type: file.type,
      attachment_size: file.size,
    })
    .eq("id", recordId)
    .eq("organization_id", organizationId);
  if (updateError) {
    await context.supabase.storage.from(bucket).remove([storagePath]);
    return NextResponse.json({ error: "unable_to_save_invoice" }, { status: 409 });
  }
  if (document.attachment_path)
    await context.supabase.storage.from(bucket).remove([document.attachment_path]);
  return NextResponse.json({ recordId, invoiceNumber });
}
