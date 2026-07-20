import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationExpenseReadAccess,
  requireOrganizationFinanceAccess,
} from "@/lib/admin-access";

type ReconcileRequest = {
  organizationId?: unknown;
  action?: unknown;
  bankTransactionId?: unknown;
  documentId?: unknown;
  documentType?: unknown;
  matchedAmount?: unknown;
  notes?: unknown;
};

function readAmount(value: unknown) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function readNotes(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const notes = value.trim();
  return notes.length <= 2_000 ? notes || null : null;
}

function isPaid(status: string | null) {
  return status?.toLocaleLowerCase().includes("pagada") ?? false;
}
export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId))
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const [accountsResult, transactionsResult, matchesResult, issuedResult, receivedResult, directPayablesResult] =
    await Promise.all([
      context.supabase
        .from("bank_accounts")
        .select("id, name, bank_name, account_number_masked, currency_code, opening_balance, opening_balance_date, is_active")
        .eq("organization_id", organizationId)
        .order("is_active", { ascending: false })
        .order("name"),
      context.supabase
        .from("bank_transactions")
        .select("id, bank_account_id, booked_on, value_date, description, reference, amount, balance_after, reconciliation_status")
        .eq("organization_id", organizationId)
        .order("booked_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(250),
      context.supabase
        .from("bank_reconciliation_matches")
        .select("id, bank_transaction_id, issued_document_id, received_document_id, direct_payable_id, matched_amount, matched_on, notes")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false })
        .limit(500),
      context.supabase
        .from("issued_documents")
        .select("id, document_number, issue_date, client_name, total_amount, payment_status")
        .eq("organization_id", organizationId)
        .order("issue_date", { ascending: false })
        .limit(250),
      context.supabase
        .from("received_documents")
        .select("id, document_number, issue_date, supplier_name, total_amount, payment_status")
        .eq("organization_id", organizationId)
        .order("issue_date", { ascending: false })
        .limit(250),
      context.supabase
        .from("direct_payables")
        .select("id, payable_number, invoice_number, issue_date, supplier_name, total_amount, currency_code, status")
        .eq("organization_id", organizationId)
        .eq("status", "paid")
        .order("issue_date", { ascending: false })
        .limit(250),
    ]);

  if (
    accountsResult.error ||
    transactionsResult.error ||
    matchesResult.error ||
    issuedResult.error ||
    receivedResult.error ||
    directPayablesResult.error
  )
    return NextResponse.json({ error: "unable_to_load_treasury" }, { status: 500 });

  return NextResponse.json({
    accounts: accountsResult.data ?? [],
    transactions: transactionsResult.data ?? [],
    matches: matchesResult.data ?? [],
    issuedDocuments: (issuedResult.data ?? []).filter(
      (document) => !isPaid(document.payment_status),
    ),
    receivedDocuments: (receivedResult.data ?? []).filter(
      (document) => !isPaid(document.payment_status),
    ),
    directPayables: directPayablesResult.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ReconcileRequest | null;
  const organizationId = body?.organizationId;
  const bankTransactionId = body?.bankTransactionId;
  const documentId = body?.documentId;
  const documentType = body?.documentType;
  const matchedAmount = readAmount(body?.matchedAmount);
  const notes = readNotes(body?.notes);
  if (
    body?.action !== "reconcile" ||
    !isUuid(organizationId) ||
    !isUuid(bankTransactionId) ||
    !isUuid(documentId) ||
    (documentType !== "issued" && documentType !== "received" && documentType !== "direct") ||
    !matchedAmount ||
    (body?.notes !== undefined &&
      body?.notes !== null &&
      (typeof body.notes !== "string" || body.notes.length > 2_000))
  )
    return NextResponse.json({ error: "invalid_reconciliation" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const { data: transaction, error: transactionError } = await context.supabase
    .from("bank_transactions")
    .select("id, amount, booked_on")
    .eq("id", bankTransactionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (transactionError || !transaction)
    return NextResponse.json({ error: "bank_transaction_not_found" }, { status: 404 });

  if (
    (documentType === "issued" && Number(transaction.amount) <= 0) ||
    ((documentType === "received" || documentType === "direct") && Number(transaction.amount) >= 0)
  )
    return NextResponse.json({ error: "transaction_direction_mismatch" }, { status: 400 });

  const documentTable = documentType === "issued" ? "issued_documents" : documentType === "direct" ? "direct_payables" : "received_documents";
  const { data: document, error: documentError } = await context.supabase
    .from(documentTable)
    .select(documentType === "direct" ? "id, total_amount, status" : "id, total_amount, payment_status")
    .eq("id", documentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (documentError || !document)
    return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  const directDocument = document as { status?: string | null };
  const invoiceDocument = document as { payment_status?: string | null };
  if ((documentType === "direct" && directDocument.status !== "paid") || (documentType !== "direct" && isPaid(invoiceDocument.payment_status ?? null)))
    return NextResponse.json({ error: "document_already_paid" }, { status: 409 });

  const matchPayload = {
    organization_id: organizationId,
    bank_transaction_id: bankTransactionId,
    issued_document_id: documentType === "issued" ? documentId : null,
    received_document_id: documentType === "received" ? documentId : null,
    direct_payable_id: documentType === "direct" ? documentId : null,
    matched_amount: matchedAmount,
    matched_on: transaction.booked_on,
    notes,
  };
  const { data: match, error: matchError } = await context.supabase
    .from("bank_reconciliation_matches")
    .insert(matchPayload)
    .select("id, bank_transaction_id, issued_document_id, received_document_id, direct_payable_id, matched_amount, matched_on, notes")
    .single();
  if (matchError || !match)
    return NextResponse.json({ error: "unable_to_reconcile" }, { status: 409 });

  const [{ data: transactionMatches }, { data: documentMatches }] = await Promise.all([
    context.supabase
      .from("bank_reconciliation_matches")
      .select("matched_amount")
      .eq("bank_transaction_id", bankTransactionId),
    context.supabase
      .from("bank_reconciliation_matches")
      .select("matched_amount")
      .eq(documentType === "issued" ? "issued_document_id" : documentType === "direct" ? "direct_payable_id" : "received_document_id", documentId),
  ]);
  const matchedForTransaction = (transactionMatches ?? []).reduce(
    (total, item) => total + Number(item.matched_amount),
    0,
  );
  const matchedForDocument = (documentMatches ?? []).reduce(
    (total, item) => total + Number(item.matched_amount),
    0,
  );
  const transactionTotal = Math.abs(Number(transaction.amount));
  const documentTotal = Math.abs(Number(document.total_amount));
  const transactionStatus =
    matchedForTransaction >= transactionTotal
      ? "reconciled"
      : "partially_reconciled";

  await context.supabase
    .from("bank_transactions")
    .update({ reconciliation_status: transactionStatus })
    .eq("id", bankTransactionId)
    .eq("organization_id", organizationId);

  return NextResponse.json({
    match,
    transactionStatus,
    documentPaid: matchedForDocument >= documentTotal,
  });
}
