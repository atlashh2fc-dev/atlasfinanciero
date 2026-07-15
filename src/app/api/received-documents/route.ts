import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationExpenseReadAccess, requireOrganizationFinanceAccess } from "@/lib/admin-access";

const paymentMethods = new Set(["Transferencia", "Cheque", "Tarjeta", "Efectivo", "Otro"]);

function text(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function date(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function yearFrom(value: string | null) {
  if (!value) return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const requestedYear = request.nextUrl.searchParams.get("year");
  const year = yearFrom(requestedYear);
  if (!isUuid(organizationId) || (requestedYear && year === null)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  let query = context.supabase
    .from("received_documents")
    .select("id, supplier_counterparty_id, supplier_name, supplier_tax_id, document_number, issue_date, document_type, net_amount, vat_amount, additional_tax_amount, total_amount, notes, payment_term_days, due_date, due_month, payment_status, payment_method, payment_bank, payment_reference, payment_notes, payment_date, payment_recorded_at, payment_recorded_by, source_file_name, source_sheet_name, source_row")
    .eq("organization_id", organizationId)
    .order("issue_date", { ascending: false })
    .order("source_row", { ascending: false });
  if (year !== null) query = query.gte("issue_date", `${year}-01-01`).lte("issue_date", `${year}-12-31`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "unable_to_load_received_documents" }, { status: 500 });
  return NextResponse.json({ documents: data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const documentId = body?.documentId;
  const paymentDate = date(body?.paymentDate);
  const paymentMethod = text(body?.paymentMethod, 80, true);
  const paymentBank = text(body?.paymentBank, 120);
  const paymentReference = text(body?.paymentReference, 180);
  const paymentNotes = text(body?.paymentNotes, 2_000);
  if (!isUuid(organizationId) || !isUuid(documentId) || !paymentDate || !paymentMethod || !paymentMethods.has(paymentMethod)) {
    return NextResponse.json({ error: "invalid_payment_registration" }, { status: 400 });
  }

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });

  const { data, error } = await context.supabase
    .from("received_documents")
    .update({
      payment_status: "Pagada",
      payment_date: paymentDate,
      payment_method: paymentMethod,
      payment_bank: paymentBank,
      payment_reference: paymentReference,
      payment_notes: paymentNotes,
      payment_recorded_at: new Date().toISOString(),
      payment_recorded_by: context.user.id,
    })
    .eq("id", documentId)
    .eq("organization_id", organizationId)
    .select("id, supplier_counterparty_id, supplier_name, supplier_tax_id, document_number, issue_date, document_type, net_amount, vat_amount, additional_tax_amount, total_amount, notes, payment_term_days, due_date, due_month, payment_status, payment_method, payment_bank, payment_reference, payment_notes, payment_date, payment_recorded_at, payment_recorded_by, source_file_name, source_sheet_name, source_row")
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: "unable_to_register_payment" }, { status: 403 });
  return NextResponse.json({ document: data });
}
