import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationExpenseReadAccess,
  requireOrganizationFinanceAccess,
} from "@/lib/admin-access";

function yearFrom(value: string | null) {
  if (!value) return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}

function optionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed || null : undefined;
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : undefined;
}

function nonNegativeAmount(value: unknown) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000_000
    ? amount
    : undefined;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const requestedYear = request.nextUrl.searchParams.get("year");
  const fileId = request.nextUrl.searchParams.get("fileId");
  const year = yearFrom(requestedYear);
  if (
    !isUuid(organizationId) ||
    (requestedYear && year === null) ||
    (fileId && !isUuid(fileId))
  )
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  if (fileId) {
    const { data: document, error } = await context.supabase
      .from("received_documents")
      .select("attachment_path")
      .eq("id", fileId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error || !document?.attachment_path)
      return NextResponse.json({ error: "document_file_not_found" }, { status: 404 });
    const { data: signed, error: signedError } = await context.supabase.storage
      .from("received-document-files")
      .createSignedUrl(document.attachment_path, 60);
    if (signedError || !signed)
      return NextResponse.json({ error: "unable_to_open_document_file" }, { status: 409 });
    return NextResponse.json({ signedUrl: signed.signedUrl });
  }

  let documentsQuery = context.supabase
    .from("received_documents")
    .select("id, supplier_counterparty_id, supplier_name, supplier_tax_id, document_number, issue_date, document_type, net_amount, vat_amount, additional_tax_amount, total_amount, notes, payment_term_days, due_date, due_month, payment_status, payment_method, payment_bank, payment_reference, payment_notes, payment_date, payment_recorded_at, payment_recorded_by, attachment_path, attachment_name, attachment_mime_type, attachment_size, source_file_name, source_sheet_name, source_row")
    .eq("organization_id", organizationId)
    .order("issue_date", { ascending: false })
    .order("source_row", { ascending: false });
  let directPayablesQuery = context.supabase
    .from("direct_payables")
    .select("id, payable_number, supplier_counterparty_id, supplier_name, invoice_number, category, category_detail, description, issue_date, due_date, total_amount, currency_code, status, notes, payment_reference, paid_at, factoring_issued_document_id, is_reference, reference_settled_at, reference_settlement_note, reference_settled_by")
    .eq("organization_id", organizationId)
    .neq("status", "cancelled")
    .order("issue_date", { ascending: false });
  if (year !== null) {
    documentsQuery = documentsQuery.gte("issue_date", `${year}-01-01`).lte("issue_date", `${year}-12-31`);
    directPayablesQuery = directPayablesQuery.gte("issue_date", `${year}-01-01`).lte("issue_date", `${year}-12-31`);
  }

  const [documents, directPayables, directPayableExecutions] = await Promise.all([
    documentsQuery,
    directPayablesQuery,
    context.supabase
      .from("payment_executions")
      .select("direct_payable_id, amount")
      .eq("organization_id", organizationId)
      .not("direct_payable_id", "is", null),
  ]);
  if (documents.error || directPayables.error || directPayableExecutions.error) return NextResponse.json({ error: "unable_to_load_accounts_payable" }, { status: 500 });
  const paidByDirectPayable = new Map<string, number>();
  for (const execution of directPayableExecutions.data ?? []) {
    if (!execution.direct_payable_id) continue;
    paidByDirectPayable.set(
      execution.direct_payable_id,
      (paidByDirectPayable.get(execution.direct_payable_id) ?? 0) + Number(execution.amount ?? 0),
    );
  }
  return NextResponse.json({
    documents: documents.data ?? [],
    directPayables: (directPayables.data ?? []).map((payable) => {
      const paidAmount = Math.min(
        Math.max(0, paidByDirectPayable.get(payable.id) ?? 0),
        Math.max(0, Number(payable.total_amount ?? 0)),
      );
      return {
        ...payable,
        paid_amount: paidAmount,
        outstanding_amount: Math.max(0, Number(payable.total_amount ?? 0) - paidAmount),
      };
    }),
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const referenceId = body?.referenceId;
  if (!isUuid(organizationId)) {
    return NextResponse.json({ error: "invalid_payment_registration" }, { status: 400 });
  }
  if (body?.action === "update_received_document" && isUuid(body?.documentId)) {
    const supplierName = optionalText(body.supplierName, 300);
    const supplierTaxId = optionalText(body.supplierTaxId, 30);
    const documentNumber = optionalText(body.documentNumber, 80);
    const documentType = optionalText(body.documentType, 80);
    const issueDate = optionalDate(body.issueDate);
    const dueDate = optionalDate(body.dueDate);
    const notes = optionalText(body.notes, 2_000);
    const paymentTermDays = body.paymentTermDays === null || body.paymentTermDays === undefined || body.paymentTermDays === ""
      ? null
      : Number.isInteger(Number(body.paymentTermDays)) && Number(body.paymentTermDays) >= 0 && Number(body.paymentTermDays) <= 3_650
        ? Number(body.paymentTermDays)
        : undefined;
    const netAmount = nonNegativeAmount(body.netAmount);
    const vatAmount = nonNegativeAmount(body.vatAmount);
    const additionalTaxAmount = nonNegativeAmount(body.additionalTaxAmount);
    if (
      supplierName === undefined || !supplierName ||
      supplierTaxId === undefined ||
      documentNumber === undefined ||
      documentType === undefined || !documentType ||
      issueDate === undefined || !issueDate ||
      dueDate === undefined ||
      notes === undefined ||
      paymentTermDays === undefined ||
      netAmount === undefined || vatAmount === undefined || additionalTaxAmount === undefined
    ) return NextResponse.json({ error: "invalid_received_document" }, { status: 400 });

    const context = await requireOrganizationFinanceAccess(organizationId);
    if (context.error || !context.supabase)
      return NextResponse.json({ error: context.error }, { status: context.status });
    const dueMonth = dueDate
      ? new Intl.DateTimeFormat("es-CL", { month: "long" }).format(new Date(`${dueDate}T12:00:00`)).replace(/^./, (letter) => letter.toUpperCase())
      : null;
    const { data, error } = await context.supabase
      .from("received_documents")
      .update({
        supplier_name: supplierName,
        supplier_tax_id: supplierTaxId,
        document_number: documentNumber,
        document_type: documentType,
        issue_date: issueDate,
        net_amount: netAmount,
        vat_amount: vatAmount,
        additional_tax_amount: additionalTaxAmount,
        total_amount: netAmount + vatAmount + additionalTaxAmount,
        notes,
        payment_term_days: paymentTermDays,
        due_date: dueDate,
        due_month: dueMonth,
      })
      .eq("id", body.documentId)
      .eq("organization_id", organizationId)
      .select("id, supplier_counterparty_id, supplier_name, supplier_tax_id, document_number, issue_date, document_type, net_amount, vat_amount, additional_tax_amount, total_amount, notes, due_date, payment_status, payment_method, payment_bank, payment_reference, payment_date, attachment_path, attachment_name, attachment_mime_type, attachment_size")
      .maybeSingle();
    if (error || !data)
      return NextResponse.json({ error: "unable_to_update_received_document" }, { status: 409 });
    return NextResponse.json({ document: data });
  }
  if (body?.action === "settle_factoring_reference" && isUuid(referenceId)) {
    const settledAt = typeof body?.settledAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.settledAt)
      ? body.settledAt
      : new Date().toISOString().slice(0, 10);
    const note = typeof body?.note === "string" && body.note.trim().length <= 2_000
      ? body.note.trim() || null
      : body?.note === undefined || body?.note === null
        ? null
        : undefined;
    if (note === undefined) return NextResponse.json({ error: "invalid_reference_note" }, { status: 400 });
    const context = await requireOrganizationFinanceAccess(organizationId);
    if (context.error || !context.supabase || !context.user)
      return NextResponse.json({ error: context.error }, { status: context.status });
    const { data, error } = await context.supabase
      .from("direct_payables")
      .update({
        reference_settled_at: `${settledAt}T12:00:00.000Z`,
        reference_settlement_note: note,
        reference_settled_by: context.user.id,
      })
      .eq("id", referenceId)
      .eq("organization_id", organizationId)
      .eq("is_reference", true)
      .select("id, reference_settled_at, reference_settlement_note")
      .maybeSingle();
    if (error || !data)
      return NextResponse.json({ error: "unable_to_settle_factoring_reference" }, { status: 409 });
    return NextResponse.json({ reference: data });
  }
  if (!isUuid(body?.documentId)) {
    return NextResponse.json({ error: "invalid_payment_registration" }, { status: 400 });
  }
  // Un documento recibido no se liquida desde esta vista. Sólo una orden de pago
  // aprobado y ejecutado crea la ejecución de pago; Tesorería luego la
  // confirma contra el movimiento bancario. Así no existen pagos huérfanos.
  return NextResponse.json({
    error: "payment_batch_required",
    message: "Registra esta factura en Compras, obligaciones y pagos. El pago se ejecuta desde una orden autorizada y se confirma en Tesorería.",
  }, { status: 409 });
}
