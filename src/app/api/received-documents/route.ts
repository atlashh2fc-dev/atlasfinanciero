import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationExpenseReadAccess } from "@/lib/admin-access";

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
  // Un documento recibido no se liquida desde esta vista. Sólo un lote P2P
  // aprobado y ejecutado crea la ejecución de pago; Tesorería luego la
  // confirma contra el movimiento bancario. Así no existen pagos huérfanos.
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!isUuid(body?.organizationId) || !isUuid(body?.documentId)) {
    return NextResponse.json({ error: "invalid_payment_registration" }, { status: 400 });
  }
  return NextResponse.json({
    error: "payment_batch_required",
    message: "Registra esta factura en Compras y lotes de pago. El pago se ejecuta desde un lote aprobado y se confirma en Tesorería.",
  }, { status: 409 });
}
