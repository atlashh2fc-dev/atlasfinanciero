import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "comprobante";
}
function parseItemIds(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 250 &&
      parsed.every(isUuid) && new Set(parsed).size === parsed.length
      ? (parsed as string[])
      : null;
  } catch { return null; }
}
function parseAmounts(value: FormDataEntryValue | null, itemIds: string[]) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const amounts = new Map<string, number>();
    for (const itemId of itemIds) {
      const amount = Number(parsed[itemId]);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000_000) return null;
      amounts.set(itemId, amount);
    }
    return amounts;
  } catch { return null; }
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const organizationId = form.get("organizationId");
  const batchId = form.get("batchId");
  const itemIds = parseItemIds(form.get("itemIds"));
  const paidOn = form.get("paidOn");
  const paymentReference = form.get("paymentReference");
  const file = form.get("file");
  const reference = typeof paymentReference === "string" ? paymentReference.trim() : "";
  const amounts = itemIds ? parseAmounts(form.get("amounts"), itemIds) : null;

  if (
    !isUuid(organizationId) ||
    !isUuid(batchId) ||
    !itemIds ||
    !amounts ||
    !isDate(paidOn) ||
    !(file instanceof File) ||
    file.size === 0 ||
    file.size > 52_428_800 ||
    !allowedMimeTypes.has(file.type) ||
    reference.length > 180
  ) return NextResponse.json({ error: "invalid_payment_proof" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const [{ data: batch, error: batchError }, { data: items, error: itemsError }] = await Promise.all([
    context.supabase
    .from("payment_batches")
    .select("id, status")
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .maybeSingle(),
    context.supabase
      .from("payment_batch_items")
      .select("id, authorized_amount, authorization_status")
      .eq("organization_id", organizationId)
      .eq("payment_batch_id", batchId)
      .in("id", itemIds),
  ]);
  if (batchError || !batch || itemsError || items?.length !== itemIds.length)
    return NextResponse.json({ error: "payment_batch_not_found" }, { status: 404 });
  if (!["approved", "processing"].includes(batch.status))
    return NextResponse.json({ error: "payment_batch_not_ready" }, { status: 409 });
  const { data: priorExecutions, error: executionsError } = await context.supabase
    .from("payment_executions")
    .select("payment_batch_item_id, amount")
    .eq("organization_id", organizationId)
    .in("payment_batch_item_id", itemIds);
  const paidByItem = new Map<string, number>();
  for (const execution of priorExecutions ?? [])
    if (execution.payment_batch_item_id)
      paidByItem.set(
        execution.payment_batch_item_id,
        (paidByItem.get(execution.payment_batch_item_id) ?? 0) +
          Number(execution.amount ?? 0),
      );
  if (
    executionsError ||
    items.some((item) =>
      item.authorization_status !== "authorized" ||
      (amounts.get(item.id) ?? 0) >
        Number(item.authorized_amount ?? 0) - (paidByItem.get(item.id) ?? 0) + 0.01,
    )
  )
    return NextResponse.json(
      { error: "payment_item_amount_exceeds_outstanding" },
      { status: 409 },
    );

  const proofKey = crypto.randomUUID();
  const storagePath = `${organizationId}/payment-batches/${batchId}/${proofKey}-${safeFileName(file.name)}`;
  const { error: uploadError } = await context.supabase.storage
    .from("direct-payable-files")
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError)
    return NextResponse.json({ error: "unable_to_upload_payment_proof" }, { status: 409 });

  const results = [];
  for (const itemId of itemIds) {
    const { data, error } = await context.supabase.rpc(
      "record_payment_batch_item_execution",
      {
        p_organization_id: organizationId,
        p_payment_batch_item_id: itemId,
        p_amount: amounts.get(itemId),
        p_paid_on: paidOn,
        p_payment_reference: reference || null,
        p_storage_path: storagePath,
        p_file_name: file.name.slice(0, 300),
        p_mime_type: file.type,
        p_file_size: file.size,
        p_idempotency_key: crypto.randomUUID(),
      },
    );
    if (error) {
      // Si ya hubo ejecuciones, el comprobante está referenciado y debe
      // conservarse. La RPC impide sobrepagos al reintentar.
      if (!results.length)
        await context.supabase.storage.from("direct-payable-files").remove([storagePath]);
      return NextResponse.json(
        { error: "unable_to_confirm_payment_items", detail: error.message },
        { status: 409 },
      );
    }
    results.push(data);
  }
  if (!results.length) {
    await context.supabase.storage.from("direct-payable-files").remove([storagePath]);
    return NextResponse.json({ error: "unable_to_confirm_payment_items" }, { status: 409 });
  }

  return NextResponse.json({ batchId, executions: results });
}
