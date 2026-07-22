import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationExpenseReadAccess } from "@/lib/admin-access";

function isPaid(status: string | null) {
  return status?.toLocaleLowerCase().includes("pagada") ?? false;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const year = request.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear());
  if (!isUuid(organizationId) || !/^\d{4}$/.test(year)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
  const from = `${year}-01-01`; const to = `${year}-12-31`; const today = new Date().toISOString().slice(0, 10);
  const [issued, issuedPayments, received, direct, approvals, executions, billingAlerts] = await Promise.all([
    context.supabase.from("issued_documents").select("id, document_number, client_name, issue_date, due_date, total_amount, payment_status, cost_center_id").eq("organization_id", organizationId).gte("issue_date", from).lte("issue_date", to).limit(1000),
    context.supabase.from("issued_document_payments").select("issued_document_id, amount").eq("organization_id", organizationId),
    context.supabase.from("received_documents").select("id, document_number, supplier_name, issue_date, due_date, total_amount, payment_status, cost_center_id").eq("organization_id", organizationId).gte("issue_date", from).lte("issue_date", to).limit(1000),
    context.supabase.from("direct_payables").select("id, payable_number, supplier_name, issue_date, due_date, total_amount, status, cost_center_id").eq("organization_id", organizationId).gte("issue_date", from).lte("issue_date", to).limit(1000),
    context.supabase.from("approval_requests").select("id, title, target_type, amount, currency_code, submitted_at").eq("organization_id", organizationId).eq("status", "submitted").order("submitted_at", { ascending: false }).limit(50),
    context.supabase.from("payment_executions").select("id, direction, amount, executed_on, payment_reference").eq("organization_id", organizationId).neq("status", "reconciled").gte("executed_on", from).lte("executed_on", to).order("executed_on", { ascending: false }).limit(500),
    context.supabase.from("billing_alerts").select("id, alert_type, last_detected_at").eq("organization_id", organizationId).eq("status", "open").order("last_detected_at", { ascending: false }).limit(50),
  ]);
  if ([issued, issuedPayments, received, direct, approvals, executions, billingAlerts].some((result) => result.error)) return NextResponse.json({ error: "unable_to_load_management_center" }, { status: 500 });
  const paidByIssuedDocument = new Map<string, number>();
  (issuedPayments.data ?? []).forEach((payment) => paidByIssuedDocument.set(payment.issued_document_id, (paidByIssuedDocument.get(payment.issued_document_id) ?? 0) + Number(payment.amount)));
  const issuedRows = (issued.data ?? []).map((item) => ({ ...item, total_amount: Math.max(0, Number(item.total_amount ?? 0) - (paidByIssuedDocument.get(item.id) ?? 0)) })); const receivedRows = received.data ?? []; const directRows = direct.data ?? [];
  const receivables = issuedRows.filter((item) => !isPaid(item.payment_status) && item.due_date && item.due_date < today);
  const payables = [
    ...receivedRows.filter((item) => !isPaid(item.payment_status) && item.due_date && item.due_date < today).map((item) => ({ ...item, source: "received" })),
    ...directRows.filter((item) => item.status === "approved" && item.due_date && item.due_date < today).map((item) => ({ ...item, source: "direct" })),
  ];
  return NextResponse.json({
    year,
    controls: {
      overdueReceivables: receivables.slice(0, 8),
      overdueReceivableCount: receivables.length,
      overduePayables: payables.slice(0, 8),
      overduePayableCount: payables.length,
      approvals: approvals.data ?? [],
      executions: executions.data ?? [],
      billingAlerts: billingAlerts.data ?? [],
      missingCostCenter: [...issuedRows, ...receivedRows, ...directRows].filter((item) => !item.cost_center_id).length,
    },
  });
}
