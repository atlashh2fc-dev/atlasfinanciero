import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationFinanceAccess,
  requireOrganizationProcurementAccess,
} from "@/lib/admin-access";

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

function safeFileName(fileName: string) {
  return (
    fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) ||
    "respaldo"
  );
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const payableId = request.nextUrl.searchParams.get("payableId");
  if (!isUuid(organizationId) || !isUuid(payableId))
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationProcurementAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const { data: files, error } = await context.supabase
    .from("direct_payable_attachments")
    .select("id, file_name, mime_type, file_size, storage_path, created_at")
    .eq("organization_id", organizationId)
    .eq("direct_payable_id", payableId)
    .order("created_at", { ascending: false });
  if (error)
    return NextResponse.json({ error: "unable_to_load_payable_attachments" }, { status: 500 });

  const enriched = await Promise.all(
    (files ?? []).map(async (file) => {
      const { data } = await context.supabase.storage
        .from("direct-payable-files")
        .createSignedUrl(file.storage_path, 60);
      return {
        id: file.id,
        fileName: file.file_name,
        mimeType: file.mime_type,
        fileSize: file.file_size,
        createdAt: file.created_at,
        signedUrl: data?.signedUrl ?? null,
      };
    }),
  );
  return NextResponse.json({ files: enriched });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const organizationId = form.get("organizationId");
  const payableId = form.get("payableId");
  const file = form.get("file");
  if (!isUuid(organizationId) || !isUuid(payableId) || !(file instanceof File))
    return NextResponse.json({ error: "invalid_attachment_request" }, { status: 400 });
  if (
    file.size === 0 ||
    file.size > 52_428_800 ||
    !allowedMimeTypes.has(file.type)
  )
    return NextResponse.json({ error: "invalid_attachment_file" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const { data: payable, error: payableError } = await context.supabase
    .from("direct_payables")
    .select("id")
    .eq("id", payableId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (payableError || !payable)
    return NextResponse.json({ error: "payable_not_found" }, { status: 404 });

  const storagePath = `${organizationId}/${payableId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { error: uploadError } = await context.supabase.storage
    .from("direct-payable-files")
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError)
    return NextResponse.json({ error: "unable_to_upload_payable_attachment" }, { status: 409 });

  const { data, error } = await context.supabase
    .from("direct_payable_attachments")
    .insert({
      organization_id: organizationId,
      direct_payable_id: payableId,
      storage_path: storagePath,
      file_name: file.name.slice(0, 300),
      mime_type: file.type,
      file_size: file.size,
    })
    .select("id, file_name, mime_type, file_size, created_at")
    .single();
  if (error || !data) {
    await context.supabase.storage.from("direct-payable-files").remove([storagePath]);
    return NextResponse.json({ error: "unable_to_register_payable_attachment" }, { status: 409 });
  }
  return NextResponse.json({
    file: {
      id: data.id,
      fileName: data.file_name,
      mimeType: data.mime_type,
      fileSize: data.file_size,
      createdAt: data.created_at,
    },
  }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const payableId = body?.payableId;
  const invoiceNumber = typeof body?.invoiceNumber === "string" ? body.invoiceNumber.trim() : null;
  const supplierName = typeof body?.supplierName === "string" ? body.supplierName.trim() : null;
  if (
    !isUuid(organizationId) ||
    !isUuid(payableId) ||
    invoiceNumber === null ||
    invoiceNumber.length > 80 ||
    supplierName === null ||
    supplierName.length === 0 ||
    supplierName.length > 300
  ) return NextResponse.json({ error: "invalid_payable_invoice" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });
  const { data, error } = await context.supabase
    .from("direct_payables")
    .update({ invoice_number: invoiceNumber || null, supplier_name: supplierName })
    .eq("id", payableId)
    .eq("organization_id", organizationId)
    .select("id, invoice_number, supplier_name")
    .maybeSingle();
  if (error || !data)
    return NextResponse.json({ error: "unable_to_update_payable_invoice" }, { status: 409 });
  const { data: activeItems, error: activeItemsError } = await context.supabase
    .from("payment_batch_items")
    .select("id, payment_batch_id")
    .eq("organization_id", organizationId)
    .eq("direct_payable_id", payableId);
  if (activeItemsError)
    return NextResponse.json({ error: "unable_to_sync_payable_payment_items" }, { status: 409 });
  const itemBatchIds = [...new Set((activeItems ?? []).map((item) => item.payment_batch_id))];
  const batchesResult = itemBatchIds.length
    ? await context.supabase
        .from("payment_batches")
        .select("id")
        .eq("organization_id", organizationId)
        .in("id", itemBatchIds)
        .in("status", ["draft", "review"])
    : { data: [], error: null };
  if (batchesResult.error)
    return NextResponse.json({ error: "unable_to_sync_payable_payment_items" }, { status: 409 });
  const activeBatchIds = (batchesResult.data ?? []).map((item) => item.id);
  const activeItemIds = (activeItems ?? [])
    .filter((item) => activeBatchIds.includes(item.payment_batch_id))
    .map((item) => item.id);
  if (activeItemIds.length) {
    const { error: syncError } = await context.supabase
      .from("payment_batch_items")
      .update({
        supplier_name_snapshot: data.supplier_name,
        document_number_snapshot: data.invoice_number,
      })
      .eq("organization_id", organizationId)
      .in("id", activeItemIds);
    if (syncError)
      return NextResponse.json({ error: "unable_to_sync_payable_payment_items" }, { status: 409 });
  }
  return NextResponse.json({ payable: data });
}
