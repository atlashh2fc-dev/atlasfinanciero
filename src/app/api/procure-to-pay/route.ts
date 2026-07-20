import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationFinanceAccess,
  requireOrganizationProcurementAccess,
} from "@/lib/admin-access";

type Line = { description?: unknown; quantity?: unknown; unitPrice?: unknown; costCenterId?: unknown };
type ActionBody = Record<string, unknown> & { action?: unknown; organizationId?: unknown };

function text(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}
function date(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
function month(value: unknown) {
  const parsed = date(value);
  return parsed?.slice(8) === "01" ? parsed : null;
}
function addMonths(value: string, offset: number) {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() + offset);
  return parsed.toISOString().slice(0, 10);
}
function positive(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function isPaid(status: string | null) {
  return status?.toLocaleLowerCase().includes("pagada") ?? false;
}
function sameSupplier(
  left: { supplier_counterparty_id: string | null; supplier_name: string | null },
  right: { supplier_counterparty_id: string | null; supplier_name: string | null },
) {
  if (left.supplier_counterparty_id && right.supplier_counterparty_id) return left.supplier_counterparty_id === right.supplier_counterparty_id;
  const normalize = (value: string | null) => (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return Boolean(normalize(left.supplier_name)) && normalize(left.supplier_name) === normalize(right.supplier_name);
}
function isReceivedOrder(status: string) {
  return status === "received" || status === "partially_received";
}
function amountMatchesOrder(documentTotal: number | string | null, orderTotal: number | string | null) {
  return Number(documentTotal ?? 0) > 0 && Number(documentTotal ?? 0) <= Number(orderTotal ?? 0) + 0.01;
}
async function canWriteProcurement(
  supabase: NonNullable<Awaited<ReturnType<typeof requireOrganizationProcurementAccess>>["supabase"]>,
  organizationId: string,
  userId: string,
) {
  const { data } = await supabase.from("organization_memberships").select("role").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
  return ["administrator", "finance", "operations"].includes(data?.role ?? "");
}
function lines(value: unknown): { description: string; quantity: number; unitPrice: number; netAmount: number; costCenterId: string | null }[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 100) return null;
  const parsed = value.map((item) => {
    const line = item as Line;
    const description = text(line.description, 500, true);
    const quantity = positive(line.quantity);
    const unitPrice = positive(line.unitPrice);
    const costCenterId = line.costCenterId === undefined || line.costCenterId === null || line.costCenterId === "" ? null : isUuid(line.costCenterId) ? line.costCenterId : undefined;
    return description && quantity && unitPrice && costCenterId !== undefined
      ? { description, quantity, unitPrice, netAmount: Math.round(quantity * unitPrice * 100) / 100, costCenterId }
      : null;
  });
  return parsed.every(Boolean) ? parsed as { description: string; quantity: number; unitPrice: number; netAmount: number; costCenterId: string | null }[] : null;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationProcurementAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const [requests, orders, orderLines, batches, batchItems, documents, directPayables, financingPlans, suppliers, bankAccounts] = await Promise.all([
    context.supabase.from("purchase_requests").select("id, request_number, supplier_counterparty_id, supplier_name, description, requested_on, needed_by, cost_center_id, currency_code, estimated_amount, status, notes, approved_at, cancellation_reason").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(200),
    context.supabase.from("vendor_purchase_orders").select("id, purchase_order_number, purchase_request_id, supplier_counterparty_id, supplier_name, supplier_tax_id, ordered_on, expected_on, currency_code, net_amount, vat_amount, total_amount, status, notes, approved_at, sent_at, received_at, cancellation_reason").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(200),
    context.supabase.from("vendor_purchase_order_lines").select("id, purchase_order_id, line_number, description, quantity, unit_price, net_amount, received_quantity, cost_center_id").eq("organization_id", organizationId).order("line_number"),
    context.supabase.from("payment_batches").select("id, batch_number, bank_account_id, scheduled_for, currency_code, total_amount, status, notes, submitted_at, approved_at, processed_at, paid_at, payment_reference, cancellation_reason").eq("organization_id", organizationId).order("scheduled_for", { ascending: false }).limit(100),
    context.supabase.from("payment_batch_items").select("id, payment_batch_id, received_document_id, direct_payable_id, supplier_name_snapshot, document_number_snapshot, due_date_snapshot, amount").eq("organization_id", organizationId),
    context.supabase.from("received_documents").select("id, supplier_counterparty_id, supplier_name, document_number, issue_date, due_date, net_amount, total_amount, payment_status, vendor_purchase_order_id, purchase_match_status, purchase_match_approved_at, purchase_match_approved_by").eq("organization_id", organizationId).order("due_date", { ascending: true }).limit(500),
    context.supabase.from("direct_payables").select("id, payable_number, supplier_counterparty_id, supplier_name, invoice_number, category, description, issue_date, due_date, total_amount, currency_code, status, notes, payment_reference").eq("organization_id", organizationId).order("due_date", { ascending: true }).limit(500),
    context.supabase.from("asset_financing_plans").select("id, plan_number, plan_kind, supplier_name, asset_name, currency_code, principal_amount, financing_total_amount, asset_cost_clp, installment_count, first_due_date, useful_life_months, disbursement_date, disbursement_amount, status").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(100),
    context.supabase.from("counterparties").select("id, legal_name, trade_name, tax_id").eq("organization_id", organizationId).in("kind", ["supplier", "both"]).eq("is_active", true).order("legal_name"),
    context.supabase.from("bank_accounts").select("id, name, bank_name, account_number_masked").eq("organization_id", organizationId).eq("is_active", true).order("name"),
  ]);
  if ([requests, orders, orderLines, batches, batchItems, documents, directPayables, financingPlans, suppliers, bankAccounts].some((result) => result.error)) return NextResponse.json({ error: "unable_to_load_procure_to_pay" }, { status: 500 });
  const activeBatchIds = new Set((batches.data ?? []).filter((batch) => !["cancelled", "paid"].includes(batch.status)).map((batch) => batch.id));
  const reservedDocumentIds = new Set((batchItems.data ?? []).filter((item) => activeBatchIds.has(item.payment_batch_id)).map((item) => item.received_document_id));
  const reservedDirectPayableIds = new Set((batchItems.data ?? []).filter((item) => activeBatchIds.has(item.payment_batch_id)).map((item) => item.direct_payable_id));
  const ordersById = new Map((orders.data ?? []).map((order) => [order.id, order]));
  const availableDocuments = (documents.data ?? []).filter((document) => !isPaid(document.payment_status)).map((document) => {
    const order = document.vendor_purchase_order_id ? ordersById.get(document.vendor_purchase_order_id) : null;
    const approvedException = document.purchase_match_status === "exception" && Boolean(document.purchase_match_approved_at && document.purchase_match_approved_by);
    const matchedOrder = document.purchase_match_status === "matched" && order
      ? isReceivedOrder(order.status) && sameSupplier(document, order) && amountMatchesOrder(document.total_amount, order.total_amount)
      : false;
    const paymentEligible = document.purchase_match_status === "not_required"
      ? !reservedDocumentIds.has(document.id)
      : approvedException
        ? !reservedDocumentIds.has(document.id)
        : matchedOrder && !reservedDocumentIds.has(document.id);
    return { ...document, payment_eligible: paymentEligible, payment_block_reason: paymentEligible ? null : document.purchase_match_status === "pending" ? "purchase_match_pending" : document.purchase_match_status === "rejected" ? "purchase_match_rejected" : document.purchase_match_status === "exception" ? "purchase_match_exception_not_approved" : !order ? "missing_purchase_order" : !isReceivedOrder(order.status) ? "purchase_order_not_received" : !sameSupplier(document, order) ? "supplier_mismatch" : !amountMatchesOrder(document.total_amount, order.total_amount) ? "amount_mismatch" : "already_in_payment_batch" };
  });
  return NextResponse.json({
    purchaseRequests: requests.data ?? [], purchaseOrders: orders.data ?? [], purchaseOrderLines: orderLines.data ?? [],
    paymentBatches: batches.data ?? [], paymentBatchItems: batchItems.data ?? [],
    receivedDocuments: availableDocuments,
    directPayables: (directPayables.data ?? []).map((payable) => ({ ...payable, payment_eligible: payable.status === "approved" && !reservedDirectPayableIds.has(payable.id), payment_block_reason: payable.status === "review" ? "awaiting_approval" : payable.status === "draft" ? "not_submitted" : payable.status === "approved" ? "already_in_payment_batch" : payable.status === "paid" ? "already_paid" : "not_approved" })),
    financingPlans: financingPlans.data ?? [],
    suppliers: suppliers.data ?? [], bankAccounts: bankAccounts.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ActionBody | null;
  const organizationId = body?.organizationId;
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const action = body?.action;
  const financeOnly = action === "create_payment_batch" || action === "create_direct_payable" || action === "create_asset_financing_plan" || action === "link_received_document_to_purchase_order";
  const context = financeOnly ? await requireOrganizationFinanceAccess(organizationId) : await requireOrganizationProcurementAccess(organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!financeOnly && !(await canWriteProcurement(context.supabase, organizationId, context.user.id))) return NextResponse.json({ error: "procure_write_access_required" }, { status: 403 });

  if (action === "create_purchase_request") {
    const requestNumber = text(body?.requestNumber, 100, true);
    const supplierName = text(body?.supplierName, 300, true);
    const description = text(body?.description, 2_000, true);
    const estimatedAmount = positive(body?.estimatedAmount);
    const requestedOn = date(body?.requestedOn) ?? new Date().toISOString().slice(0, 10);
    const neededBy = body?.neededBy ? date(body.neededBy) : null;
    const supplierId = body?.supplierId ? (isUuid(body.supplierId) ? body.supplierId : null) : null;
    const costCenterId = body?.costCenterId ? (isUuid(body.costCenterId) ? body.costCenterId : null) : null;
    if (!requestNumber || !supplierName || !description || !estimatedAmount || (body?.neededBy && !neededBy) || (body?.supplierId && !supplierId) || (body?.costCenterId && !costCenterId)) return NextResponse.json({ error: "invalid_purchase_request" }, { status: 400 });
    const { data, error } = await context.supabase.from("purchase_requests").insert({ organization_id: organizationId, request_number: requestNumber, supplier_counterparty_id: supplierId, supplier_name: supplierName, description, requested_on: requestedOn, needed_by: neededBy, cost_center_id: costCenterId, estimated_amount: estimatedAmount, currency_code: "CLP", notes: text(body?.notes, 2_000), requested_by: context.user.id }).select("id").single();
    if (error || !data) return NextResponse.json({ error: "unable_to_create_purchase_request" }, { status: 409 });
    return NextResponse.json({ id: data.id }, { status: 201 });
  }

  if (action === "create_purchase_order_from_request") {
    const purchaseOrderNumber = text(body?.purchaseOrderNumber, 100, true);
    const orderedOn = date(body?.orderedOn) ?? new Date().toISOString().slice(0, 10);
    const expectedOn = body?.expectedOn ? date(body.expectedOn) : null;
    const purchaseRequestId = body?.purchaseRequestId ? (isUuid(body.purchaseRequestId) ? body.purchaseRequestId : null) : null;
    if ((body?.expectedOn && !expectedOn) || !purchaseRequestId || (expectedOn && expectedOn < orderedOn)) return NextResponse.json({ error: "invalid_vendor_purchase_order" }, { status: 400 });

    let supplierName: string | null;
    let supplierId: string | null;
    let supplierTaxId: string | null;
    let currencyCode = "CLP";
    let orderLines: ReturnType<typeof lines>;
    let sourceRequest: { id: string; needed_by: string | null; notes: string | null } | null = null;

    const { data: requestItem, error: requestError } = await context.supabase
      .from("purchase_requests")
      .select("id, request_number, supplier_counterparty_id, supplier_name, description, needed_by, cost_center_id, currency_code, estimated_amount, notes, status")
      .eq("id", purchaseRequestId).eq("organization_id", organizationId).maybeSingle();
    if (requestError || !requestItem || requestItem.status !== "approved") return NextResponse.json({ error: "approved_purchase_request_required" }, { status: 409 });
    const { data: existingOrder, error: existingOrderError } = await context.supabase
      .from("vendor_purchase_orders").select("id").eq("organization_id", organizationId).eq("purchase_request_id", purchaseRequestId).neq("status", "cancelled").limit(1).maybeSingle();
    if (existingOrderError) return NextResponse.json({ error: "unable_to_validate_purchase_request" }, { status: 500 });
    if (existingOrder) return NextResponse.json({ error: "purchase_request_already_has_order" }, { status: 409 });
    supplierName = requestItem.supplier_name;
    supplierId = requestItem.supplier_counterparty_id;
    currencyCode = requestItem.currency_code;
    orderLines = [{ description: requestItem.description, quantity: 1, unitPrice: Number(requestItem.estimated_amount), netAmount: Number(requestItem.estimated_amount), costCenterId: requestItem.cost_center_id }];
    sourceRequest = { id: requestItem.id, needed_by: requestItem.needed_by, notes: requestItem.notes };
    if (supplierId) {
      const { data: supplier } = await context.supabase.from("counterparties").select("tax_id").eq("id", supplierId).eq("organization_id", organizationId).maybeSingle();
      supplierTaxId = supplier?.tax_id ?? null;
    } else supplierTaxId = null;
    if (!purchaseOrderNumber || !supplierName || !orderLines) return NextResponse.json({ error: "invalid_vendor_purchase_order" }, { status: 400 });
    const inheritedExpectedOn = sourceRequest?.needed_by && sourceRequest.needed_by >= orderedOn ? sourceRequest.needed_by : null;
    const { data: order, error: orderError } = await context.supabase.from("vendor_purchase_orders").insert({ organization_id: organizationId, purchase_order_number: purchaseOrderNumber, purchase_request_id: sourceRequest?.id ?? null, supplier_counterparty_id: supplierId, supplier_name: supplierName, supplier_tax_id: supplierTaxId, ordered_on: orderedOn, expected_on: expectedOn ?? inheritedExpectedOn, currency_code: currencyCode, notes: text(body?.notes, 2_000) ?? sourceRequest?.notes ?? null, created_by: context.user.id }).select("id").single();
    if (orderError || !order) return NextResponse.json({ error: "unable_to_create_vendor_purchase_order" }, { status: 409 });
    const { error: linesError } = await context.supabase.from("vendor_purchase_order_lines").insert(orderLines.map((line, index) => ({ organization_id: organizationId, purchase_order_id: order.id, line_number: index + 1, description: line.description, quantity: line.quantity, unit_price: line.unitPrice, net_amount: line.netAmount, cost_center_id: line.costCenterId })));
    if (linesError) {
      await context.supabase.from("vendor_purchase_orders").delete().eq("id", order.id).eq("organization_id", organizationId);
      return NextResponse.json({ error: "unable_to_create_vendor_purchase_order_lines" }, { status: 409 });
    }
    return NextResponse.json({ id: order.id }, { status: 201 });
  }

  if (action === "link_received_document_to_purchase_order") {
    const receivedDocumentId = isUuid(body?.receivedDocumentId) ? body.receivedDocumentId : null;
    const purchaseOrderId = isUuid(body?.purchaseOrderId) ? body.purchaseOrderId : null;
    if (!receivedDocumentId || !purchaseOrderId) return NextResponse.json({ error: "invalid_document_purchase_order_link" }, { status: 400 });
    const [{ data: document, error: documentError }, { data: order, error: orderError }] = await Promise.all([
      context.supabase.from("received_documents").select("id, supplier_counterparty_id, supplier_name, total_amount, payment_status, vendor_purchase_order_id").eq("id", receivedDocumentId).eq("organization_id", organizationId).maybeSingle(),
      context.supabase.from("vendor_purchase_orders").select("id, supplier_counterparty_id, supplier_name, total_amount, status").eq("id", purchaseOrderId).eq("organization_id", organizationId).maybeSingle(),
    ]);
    if (documentError || orderError || !document || !order) return NextResponse.json({ error: "document_or_purchase_order_not_found" }, { status: 404 });
    if (isPaid(document.payment_status)) return NextResponse.json({ error: "paid_document_cannot_be_linked" }, { status: 409 });
    if (document.vendor_purchase_order_id && document.vendor_purchase_order_id !== order.id) return NextResponse.json({ error: "document_already_linked_to_another_purchase_order" }, { status: 409 });
    if (!isReceivedOrder(order.status) || !sameSupplier(document, order) || !amountMatchesOrder(document.total_amount, order.total_amount)) return NextResponse.json({ error: "document_does_not_match_purchase_order" }, { status: 409 });
    const { data: linkedDocuments, error: linkedDocumentsError } = await context.supabase.from("received_documents").select("id, total_amount").eq("organization_id", organizationId).eq("vendor_purchase_order_id", order.id).neq("id", document.id);
    const linkedTotal = (linkedDocuments ?? []).reduce((sum, item) => sum + Number(item.total_amount ?? 0), Number(document.total_amount ?? 0));
    if (linkedDocumentsError || linkedTotal > Number(order.total_amount ?? 0) + 0.01) return NextResponse.json({ error: linkedDocumentsError ? "unable_to_validate_purchase_order_amount" : "purchase_order_amount_exceeded" }, { status: 409 });
    const { data, error } = await context.supabase.from("received_documents").update({ vendor_purchase_order_id: order.id, purchase_match_status: "matched", purchase_match_note: null }).eq("id", document.id).eq("organization_id", organizationId).select("id, vendor_purchase_order_id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "unable_to_link_received_document" }, { status: 409 });
    return NextResponse.json({ document: data });
  }

  if (action === "create_direct_payable") {
    const payableNumber = text(body?.payableNumber, 100, true);
    const supplierName = text(body?.supplierName, 300, true);
    const description = text(body?.description, 2_000, true);
    const totalAmount = positive(body?.totalAmount);
    const issueDate = date(body?.issueDate) ?? new Date().toISOString().slice(0, 10);
    const dueDate = body?.dueDate ? date(body.dueDate) : null;
    const supplierId = body?.supplierId ? (isUuid(body.supplierId) ? body.supplierId : null) : null;
    const invoiceNumber = text(body?.invoiceNumber, 180);
    const category = typeof body?.category === "string" && ["utilities", "rent", "taxes", "insurance", "subscriptions", "other"].includes(body.category) ? body.category : "other";
    if (!payableNumber || !supplierName || !description || !totalAmount || (body?.dueDate && !dueDate) || (dueDate && dueDate < issueDate) || (body?.supplierId && !supplierId)) return NextResponse.json({ error: "invalid_direct_payable" }, { status: 400 });
    const { data, error } = await context.supabase.from("direct_payables").insert({ organization_id: organizationId, payable_number: payableNumber, supplier_counterparty_id: supplierId, supplier_name: supplierName, invoice_number: invoiceNumber, category, description, issue_date: issueDate, due_date: dueDate, total_amount: totalAmount, currency_code: "CLP", notes: text(body?.notes, 2_000), created_by: context.user.id }).select("id").single();
    if (error || !data) return NextResponse.json({ error: "unable_to_create_direct_payable" }, { status: 409 });
    return NextResponse.json({ id: data.id }, { status: 201 });
  }

  if (action === "create_asset_financing_plan") {
    const planNumber = text(body?.planNumber, 100, true);
    const supplierName = text(body?.supplierName, 300, true);
    const planKind = body?.planKind === "credit" || body?.planKind === "supplier_debt" || body?.planKind === "asset_financing" ? body.planKind : null;
    const assetName = text(body?.assetName, 500, planKind === "asset_financing");
    const principalAmount = positive(body?.principalAmount);
    const financingTotalAmount = positive(body?.financingTotalAmount);
    const assetCostClp = planKind === "asset_financing" ? positive(body?.assetCostClp) : null;
    const residualValueClp = body?.residualValueClp === undefined || body?.residualValueClp === "" ? 0 : positive(body?.residualValueClp);
    const installmentCount = Number(body?.installmentCount);
    const firstDueDate = date(body?.firstDueDate);
    const usefulLifeMonths = planKind === "asset_financing" ? Number(body?.usefulLifeMonths) : null;
    const amortizationStartMonth = planKind === "asset_financing" ? month(body?.amortizationStartMonth) : null;
    const disbursementDate = planKind === "credit" ? date(body?.disbursementDate) : null;
    const disbursementAmount = planKind === "credit" ? positive(body?.disbursementAmount) : null;
    const currencyCode = body?.currencyCode === "UF" ? "UF" : body?.currencyCode === "CLP" ? "CLP" : null;
    const supplierId = body?.supplierId ? (isUuid(body.supplierId) ? body.supplierId : null) : null;
    const invalidAsset = planKind === "asset_financing" && (!assetName || !assetCostClp || residualValueClp === null || residualValueClp >= assetCostClp || !Number.isInteger(usefulLifeMonths) || (usefulLifeMonths ?? 0) < 1 || (usefulLifeMonths ?? 0) > 600 || !amortizationStartMonth);
    if (!planNumber || !supplierName || !planKind || !principalAmount || !financingTotalAmount || financingTotalAmount < principalAmount || !Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 240 || !firstDueDate || !currencyCode || invalidAsset || (planKind === "credit" && (!disbursementDate || !disbursementAmount)) || (body?.supplierId && !supplierId)) return NextResponse.json({ error: "invalid_financing_plan" }, { status: 400 });
    const { data: plan, error: planError } = await context.supabase.from("asset_financing_plans").insert({ organization_id: organizationId, plan_number: planNumber, plan_kind: planKind, supplier_counterparty_id: supplierId, supplier_name: supplierName, asset_name: assetName, contract_reference: text(body?.contractReference, 180), currency_code: currencyCode, principal_amount: principalAmount, asset_acquisition_amount: planKind === "asset_financing" ? principalAmount : null, financing_total_amount: financingTotalAmount, asset_cost_clp: assetCostClp, residual_value_clp: planKind === "asset_financing" ? residualValueClp : 0, installment_count: installmentCount, first_due_date: firstDueDate, useful_life_months: usefulLifeMonths, amortization_start_month: amortizationStartMonth, disbursement_date: disbursementDate, disbursement_amount: disbursementAmount, notes: text(body?.notes, 2_000), created_by: context.user.id }).select("id").single();
    if (planError || !plan) return NextResponse.json({ error: "unable_to_create_asset_financing_plan" }, { status: 409 });
    const installmentRows = Array.from({ length: installmentCount }, (_, index) => {
      const principal = index === installmentCount - 1 ? principalAmount - Math.floor(principalAmount / installmentCount * 10_000) / 10_000 * (installmentCount - 1) : Math.floor(principalAmount / installmentCount * 10_000) / 10_000;
      const total = index === installmentCount - 1 ? financingTotalAmount - Math.floor(financingTotalAmount / installmentCount * 10_000) / 10_000 * (installmentCount - 1) : Math.floor(financingTotalAmount / installmentCount * 10_000) / 10_000;
      return { organization_id: organizationId, plan_id: plan.id, installment_number: index + 1, due_date: addMonths(firstDueDate, index), currency_amount: total, principal_amount: principal, finance_charge_amount: total - principal };
    });
    const assetCost = assetCostClp ?? 0;
    const amortizationMonths = usefulLifeMonths ?? 0;
    const amortizationStart = amortizationStartMonth ?? firstDueDate;
    const amortizable = assetCost - (residualValueClp ?? 0);
    const amortizationRows = planKind === "asset_financing" ? Array.from({ length: amortizationMonths }, (_, index) => {
      const amortization = index === amortizationMonths - 1 ? amortizable - Math.floor(amortizable / amortizationMonths * 100) / 100 * (amortizationMonths - 1) : Math.floor(amortizable / amortizationMonths * 100) / 100;
      const opening = index === 0 ? assetCost : assetCost - Math.floor(amortizable / amortizationMonths * 100) / 100 * index;
      return { organization_id: organizationId, plan_id: plan.id, period_month: addMonths(amortizationStart, index), opening_balance_clp: opening, amortization_amount_clp: amortization, closing_balance_clp: opening - amortization };
    }) : [];
    const [{ error: installmentsError }, amortizationResult] = await Promise.all([context.supabase.from("asset_financing_installments").insert(installmentRows), amortizationRows.length ? context.supabase.from("asset_amortization_schedules").insert(amortizationRows) : Promise.resolve({ error: null })]);
    const amortizationError = amortizationResult.error;
    if (installmentsError || amortizationError) { await context.supabase.from("asset_financing_plans").delete().eq("id", plan.id).eq("organization_id", organizationId); return NextResponse.json({ error: "unable_to_generate_asset_financing_schedule" }, { status: 409 }); }
    return NextResponse.json({ id: plan.id }, { status: 201 });
  }

  if (action === "create_payment_batch") {
    const batchNumber = text(body?.batchNumber, 100, true);
    const scheduledFor = date(body?.scheduledFor);
    const bankAccountId = body?.bankAccountId ? (isUuid(body.bankAccountId) ? body.bankAccountId : null) : null;
    const documentIds = Array.isArray(body?.documentIds) && body.documentIds.length <= 250 && body.documentIds.every(isUuid) ? body.documentIds as string[] : null;
    const directPayableIds = Array.isArray(body?.directPayableIds) && body.directPayableIds.length <= 250 && body.directPayableIds.every(isUuid) ? body.directPayableIds as string[] : null;
    if (!batchNumber || !scheduledFor || !documentIds || !directPayableIds || !documentIds.length && !directPayableIds.length || documentIds.length + directPayableIds.length > 250 || (body?.bankAccountId && !bankAccountId)) return NextResponse.json({ error: "invalid_payment_batch" }, { status: 400 });
    if (new Set(documentIds).size !== documentIds.length || new Set(directPayableIds).size !== directPayableIds.length) return NextResponse.json({ error: "duplicated_payment_documents" }, { status: 400 });
    const { data: documents, error: documentsError } = await context.supabase.from("received_documents").select("id, supplier_counterparty_id, supplier_name, document_number, due_date, total_amount, payment_status, vendor_purchase_order_id, purchase_match_status, purchase_match_approved_at, purchase_match_approved_by").eq("organization_id", organizationId).in("id", documentIds);
    if (documentsError || !documents || documents.length !== documentIds.length || documents.some((document) => isPaid(document.payment_status) || Number(document.total_amount) <= 0)) return NextResponse.json({ error: "payment_documents_not_available" }, { status: 409 });
    const purchaseOrderIds = [...new Set(documents.map((document) => document.vendor_purchase_order_id).filter((id): id is string => Boolean(id)))];
    const [{ data: purchaseOrders, error: purchaseOrdersError }, { data: linkedDocuments, error: linkedDocumentsError }, { data: existingItems, error: existingItemsError }, { data: directPayables, error: directPayablesError }, { data: existingDirectItems, error: existingDirectItemsError }] = await Promise.all([
      context.supabase.from("vendor_purchase_orders").select("id, supplier_counterparty_id, supplier_name, total_amount, status").eq("organization_id", organizationId).in("id", purchaseOrderIds),
      context.supabase.from("received_documents").select("vendor_purchase_order_id, total_amount").eq("organization_id", organizationId).in("vendor_purchase_order_id", purchaseOrderIds),
      context.supabase.from("payment_batch_items").select("payment_batch_id, received_document_id").eq("organization_id", organizationId).in("received_document_id", documentIds),
      context.supabase.from("direct_payables").select("id, payable_number, supplier_name, invoice_number, due_date, total_amount, status").eq("organization_id", organizationId).in("id", directPayableIds),
      context.supabase.from("payment_batch_items").select("payment_batch_id, direct_payable_id").eq("organization_id", organizationId).in("direct_payable_id", directPayableIds),
    ]);
    if (purchaseOrdersError || linkedDocumentsError || existingItemsError || directPayablesError || existingDirectItemsError || !purchaseOrders || !directPayables) return NextResponse.json({ error: "unable_to_validate_payment_documents" }, { status: 500 });
    if (directPayables.length !== directPayableIds.length || directPayables.some((payable) => payable.status !== "approved" || Number(payable.total_amount) <= 0)) return NextResponse.json({ error: "direct_payables_not_available" }, { status: 409 });
    const ordersById = new Map(purchaseOrders.map((order) => [order.id, order]));
    const totalsByOrder = new Map<string, number>();
    for (const item of linkedDocuments ?? []) if (item.vendor_purchase_order_id) totalsByOrder.set(item.vendor_purchase_order_id, (totalsByOrder.get(item.vendor_purchase_order_id) ?? 0) + Number(item.total_amount ?? 0));
    if (documents.some((document) => {
      if (document.purchase_match_status === "not_required") return false;
      if (document.purchase_match_status === "exception") return !(document.purchase_match_approved_at && document.purchase_match_approved_by);
      const order = document.vendor_purchase_order_id ? ordersById.get(document.vendor_purchase_order_id) : null;
      return document.purchase_match_status !== "matched" || !order || !isReceivedOrder(order.status) || !sameSupplier(document, order) || !amountMatchesOrder(document.total_amount, order.total_amount) || (totalsByOrder.get(order.id) ?? 0) > Number(order.total_amount ?? 0) + 0.01;
    })) return NextResponse.json({ error: "payment_documents_not_validated_against_purchase_order" }, { status: 409 });
    const existingBatchIds = [...new Set([...(existingItems ?? []).map((item) => item.payment_batch_id), ...(existingDirectItems ?? []).map((item) => item.payment_batch_id)])];
    if (existingBatchIds.length) {
      const { data: existingBatches, error: existingBatchesError } = await context.supabase.from("payment_batches").select("id, status").eq("organization_id", organizationId).in("id", existingBatchIds);
      if (existingBatchesError) return NextResponse.json({ error: "unable_to_validate_payment_documents" }, { status: 500 });
      if ((existingBatches ?? []).some((batch) => batch.status !== "cancelled" && batch.status !== "paid")) return NextResponse.json({ error: "payment_document_already_reserved" }, { status: 409 });
    }
    const { data: batch, error: batchError } = await context.supabase.from("payment_batches").insert({ organization_id: organizationId, batch_number: batchNumber, bank_account_id: bankAccountId, scheduled_for: scheduledFor, currency_code: "CLP", notes: text(body?.notes, 2_000), created_by: context.user.id }).select("id").single();
    if (batchError || !batch) return NextResponse.json({ error: "unable_to_create_payment_batch" }, { status: 409 });
    const { error: itemsError } = await context.supabase.from("payment_batch_items").insert([
      ...documents.map((document) => ({ organization_id: organizationId, payment_batch_id: batch.id, received_document_id: document.id, supplier_name_snapshot: document.supplier_name, document_number_snapshot: document.document_number, due_date_snapshot: document.due_date, amount: document.total_amount })),
      ...directPayables.map((payable) => ({ organization_id: organizationId, payment_batch_id: batch.id, direct_payable_id: payable.id, supplier_name_snapshot: payable.supplier_name, document_number_snapshot: payable.invoice_number ?? payable.payable_number, due_date_snapshot: payable.due_date, amount: payable.total_amount })),
    ]);
    if (itemsError) {
      await context.supabase.from("payment_batches").delete().eq("id", batch.id).eq("organization_id", organizationId);
      return NextResponse.json({ error: "unable_to_create_payment_batch_items" }, { status: 409 });
    }
    return NextResponse.json({ id: batch.id }, { status: 201 });
  }
  return NextResponse.json({ error: "unsupported_procure_to_pay_action" }, { status: 400 });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ActionBody | null;
  const organizationId = body?.organizationId;
  const id = body?.id;
  const action = body?.action;
  if (!isUuid(organizationId) || !isUuid(id) || typeof action !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const financeOnly = ["submit_payment_batch", "start_payment_batch", "mark_payment_batch_paid", "submit_direct_payable", "submit_asset_financing_plan"].includes(action);
  const context = financeOnly ? await requireOrganizationFinanceAccess(organizationId) : await requireOrganizationProcurementAccess(organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!financeOnly && !(await canWriteProcurement(context.supabase, organizationId, context.user.id))) return NextResponse.json({ error: "procure_write_access_required" }, { status: 403 });
  const transitions: Record<string, { table: string; values: Record<string, unknown> }> = {
    submit_purchase_request: { table: "purchase_requests", values: { status: "review" } },
    submit_purchase_order: { table: "vendor_purchase_orders", values: { status: "review" } },
    send_purchase_order: { table: "vendor_purchase_orders", values: { status: "sent", sent_at: new Date().toISOString() } },
    receive_purchase_order: { table: "vendor_purchase_orders", values: { status: "received", received_at: new Date().toISOString() } },
    submit_payment_batch: { table: "payment_batches", values: { status: "review", submitted_at: new Date().toISOString() } },
    start_payment_batch: { table: "payment_batches", values: { status: "processing", processed_at: new Date().toISOString() } },
    mark_payment_batch_paid: { table: "payment_batches", values: { status: "paid", paid_at: new Date().toISOString(), payment_reference: text(body?.paymentReference, 180) } },
    submit_direct_payable: { table: "direct_payables", values: { status: "review" } },
    submit_asset_financing_plan: { table: "asset_financing_plans", values: { status: "review" } },
  };
  const transition = transitions[action];
  if (!transition) return NextResponse.json({ error: "unsupported_procure_to_pay_transition" }, { status: 400 });
  const { data, error } = await context.supabase.from(transition.table).update(transition.values).eq("id", id).eq("organization_id", organizationId).select("id, status").maybeSingle();
  if (error || !data) return NextResponse.json({ error: "unable_to_change_procure_to_pay_status" }, { status: 409 });
  return NextResponse.json({ item: data });
}
