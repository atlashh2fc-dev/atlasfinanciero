import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
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
  account?: unknown;
};

type StatementRow = {
  bookedOn: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  amount: number;
  balanceAfter: number | null;
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
function text(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}
function dateValue(value: unknown) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  const iso = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const local = clean.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  const year = Number(iso?.[1] ?? local?.[3]); const month = Number(iso?.[2] ?? local?.[2]); const day = Number(iso?.[3] ?? local?.[1]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const result = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return new Date(`${result}T12:00:00Z`).getUTCDate() === day ? result : null;
}
function signedAmount(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const negative = raw.includes("(") || raw.startsWith("-");
  const digits = raw.replace(/[$\s()]/g, "");
  const normalized = digits.includes(",") && digits.includes(".")
    ? (digits.lastIndexOf(",") > digits.lastIndexOf(".") ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, ""))
    : digits.includes(",") ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : null;
}
function normalizeHeader(value: string) {
  return value.toLocaleLowerCase("es-CL").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}
function csvRows(source: string) {
  const delimiter = [";", ",", "\t"].sort((left, right) => source.slice(0, 2_000).split(right).length - source.slice(0, 2_000).split(left).length)[0];
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]; const next = source[index + 1];
    if (character === '"' && quoted && next === '"') { field += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === delimiter && !quoted) { row.push(field.trim()); field = ""; continue; }
    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = ""; continue;
    }
    field += character;
  }
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}
function columnIndex(headers: string[], names: string[]) {
  return headers.findIndex((header) => names.includes(header));
}
function parseStatement(source: string) {
  const rows = csvRows(source.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return { rows: [] as StatementRow[], rejected: 0, error: "La cartola no contiene filas de movimientos." };
  const headers = rows[0].map(normalizeHeader);
  const booked = columnIndex(headers, ["fecha", "fechacontable", "fechamovimiento", "bookingdate", "date"]);
  const description = columnIndex(headers, ["descripcion", "glosa", "detalle", "movimiento", "concepto", "description"]);
  const amount = columnIndex(headers, ["monto", "importe", "valor", "amount"]);
  const debit = columnIndex(headers, ["cargo", "debito", "egreso", "debit"]);
  const credit = columnIndex(headers, ["abono", "credito", "ingreso", "credit"]);
  const valueDate = columnIndex(headers, ["fechavalor", "valuedate"]);
  const reference = columnIndex(headers, ["referencia", "nreferencia", "referenciaoperacion", "reference"]);
  const balance = columnIndex(headers, ["saldo", "balance", "saldodisponible"]);
  if (booked < 0 || description < 0 || (amount < 0 && debit < 0 && credit < 0)) return { rows: [] as StatementRow[], rejected: rows.length - 1, error: "No reconocimos las columnas mínimas. Incluye Fecha, Descripción y Monto o bien Cargo/Abono." };
  const valid: StatementRow[] = []; let rejected = 0;
  for (const row of rows.slice(1, 5_001)) {
    const bookedOn = dateValue(row[booked]); const detail = text(row[description], 500, true);
    const explicit = amount >= 0 ? signedAmount(row[amount]) : null;
    const debitAmount = debit >= 0 ? signedAmount(row[debit]) : null; const creditAmount = credit >= 0 ? signedAmount(row[credit]) : null;
    const transactionAmount = explicit ?? ((creditAmount ?? 0) - Math.abs(debitAmount ?? 0));
    if (!bookedOn || !detail || !transactionAmount) { rejected += 1; continue; }
    valid.push({ bookedOn, valueDate: valueDate >= 0 ? dateValue(row[valueDate]) : null, description: detail, reference: reference >= 0 ? text(row[reference], 180) : null, amount: transactionAmount, balanceAfter: balance >= 0 ? signedAmount(row[balance]) : null });
  }
  return { rows: valid, rejected, error: valid.length ? null : "No encontramos movimientos válidos en la cartola." };
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

  const [accountsResult, transactionsResult, matchesResult, issuedResult, receivedResult, directPayablesResult, importsResult, executionsResult] =
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
        .in("status", ["approved", "paid"])
        .eq("is_reference", false)
        .order("issue_date", { ascending: false })
        .limit(250),
      context.supabase
        .from("bank_statement_imports")
        .select("id, bank_account_id, file_name, imported_rows, skipped_rows, status, created_at")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false })
        .limit(12),
      context.supabase
        .from("payment_executions")
        .select("id, direction, status, amount, executed_on, source, payment_method, payment_reference, notes, direct_payable_id")
        .eq("organization_id", organizationId)
        .order("executed_on", { ascending: false })
        .limit(500),
    ]);

  if (
    accountsResult.error ||
    transactionsResult.error ||
    matchesResult.error ||
    issuedResult.error ||
    receivedResult.error ||
    directPayablesResult.error ||
    importsResult.error ||
    executionsResult.error
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
    directPayables: (directPayablesResult.data ?? []).map((payable) => ({
      ...payable,
      available_to_reconcile: (executionsResult.data ?? [])
        .filter(
          (execution) =>
            execution.direct_payable_id === payable.id &&
            execution.status !== "reconciled",
        )
        .reduce((sum, execution) => sum + Number(execution.amount ?? 0), 0),
    })),
    statementImports: importsResult.data ?? [],
    paymentExecutions: executionsResult.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const action = form?.get("action");
    const organizationId = form?.get("organizationId");
    const bankAccountId = form?.get("bankAccountId");
    const statement = form?.get("file");
    if (
      (action !== "preview_statement" && action !== "import_statement") ||
      !isUuid(organizationId) ||
      !isUuid(bankAccountId) ||
      !(statement instanceof File) ||
      statement.size === 0 ||
      statement.size > 10 * 1024 * 1024 ||
      (!statement.name.toLocaleLowerCase().endsWith(".csv") &&
        !["text/csv", "text/plain", "application/vnd.ms-excel"].includes(statement.type))
    )
      return NextResponse.json({ error: "invalid_statement_file" }, { status: 400 });

    const context = await requireOrganizationFinanceAccess(organizationId);
    if (context.error || !context.supabase)
      return NextResponse.json({ error: context.error }, { status: context.status });
    const { data: account, error: accountError } = await context.supabase
      .from("bank_accounts")
      .select("id, name")
      .eq("id", bankAccountId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .maybeSingle();
    if (accountError || !account)
      return NextResponse.json({ error: "bank_account_not_found" }, { status: 404 });

    const bytes = Buffer.from(await statement.arrayBuffer());
    const parsed = parseStatement(bytes.toString("utf8"));
    if (parsed.error)
      return NextResponse.json({ error: "invalid_statement", detail: parsed.error }, { status: 400 });
    if (action === "preview_statement")
      return NextResponse.json({
        accountName: account.name,
        validRows: parsed.rows.length,
        rejectedRows: parsed.rejected,
        rows: parsed.rows.slice(0, 12),
      });

    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    const { data: priorImport } = await context.supabase
      .from("bank_statement_imports")
      .select("id, status")
      .eq("bank_account_id", bankAccountId)
      .eq("file_sha256", fileSha256)
      .maybeSingle();
    if (priorImport)
      return NextResponse.json({ error: "statement_already_imported" }, { status: 409 });

    const sourceIds = parsed.rows.map((row) =>
      createHash("sha256")
        .update([bankAccountId, row.bookedOn, row.valueDate ?? "", row.description, row.reference ?? "", row.amount, row.balanceAfter ?? ""].join("|"))
        .digest("hex"),
    );
    const existingIds = new Set<string>();
    for (let start = 0; start < sourceIds.length; start += 400) {
      const { data: existing } = await context.supabase
        .from("bank_transactions")
        .select("source_external_id")
        .eq("bank_account_id", bankAccountId)
        .in("source_external_id", sourceIds.slice(start, start + 400));
      for (const item of existing ?? []) if (item.source_external_id) existingIds.add(item.source_external_id);
    }
    const seenIds = new Set<string>();
    const rowsToInsert = parsed.rows.flatMap((row, index) => {
      const sourceId = sourceIds[index];
      if (existingIds.has(sourceId) || seenIds.has(sourceId)) return [];
      seenIds.add(sourceId);
      return [{ row, sourceId }];
    });
    const safeName = statement.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160) || "cartola.csv";
    const storagePath = `${organizationId}/${bankAccountId}/${randomUUID()}-${safeName}`;
    const { data: importRecord, error: importError } = await context.supabase
      .from("bank_statement_imports")
      .insert({ organization_id: organizationId, bank_account_id: bankAccountId, file_name: statement.name.slice(0, 255), storage_path: storagePath, file_sha256: fileSha256 })
      .select("id")
      .single();
    if (importError || !importRecord)
      return NextResponse.json({ error: "unable_to_register_statement" }, { status: 409 });

    const { error: uploadError } = await context.supabase.storage
      .from("bank-statements")
      .upload(storagePath, bytes, { contentType: statement.type || "text/csv", upsert: false });
    if (uploadError) {
      await context.supabase.from("bank_statement_imports").update({ status: "failed", error_message: "No fue posible guardar el archivo de cartola." }).eq("id", importRecord.id);
      return NextResponse.json({ error: "unable_to_store_statement" }, { status: 500 });
    }

    const transactions = rowsToInsert.map(({ row, sourceId }) => {
      return {
        organization_id: organizationId,
        bank_account_id: bankAccountId,
        bank_statement_import_id: importRecord.id,
        booked_on: row.bookedOn,
        value_date: row.valueDate,
        description: row.description,
        reference: row.reference,
        amount: row.amount,
        balance_after: row.balanceAfter,
        source_external_id: sourceId,
        source_file_name: statement.name.slice(0, 255),
      };
    });
    for (let start = 0; start < transactions.length; start += 400) {
      const { error } = await context.supabase.from("bank_transactions").insert(transactions.slice(start, start + 400));
      if (error) {
        await context.supabase.from("bank_transactions").delete().eq("bank_statement_import_id", importRecord.id);
        await context.supabase.storage.from("bank-statements").remove([storagePath]);
        await context.supabase.from("bank_statement_imports").update({ status: "failed", error_message: "No fue posible registrar todos los movimientos de la cartola." }).eq("id", importRecord.id);
        return NextResponse.json({ error: "unable_to_import_statement" }, { status: 500 });
      }
    }
    const skippedRows = parsed.rejected + (parsed.rows.length - rowsToInsert.length);
    await context.supabase
      .from("bank_statement_imports")
      .update({ status: "completed", imported_rows: rowsToInsert.length, skipped_rows: skippedRows })
      .eq("id", importRecord.id);
    return NextResponse.json({ importedRows: rowsToInsert.length, skippedRows, importId: importRecord.id });
  }

  const body = (await request.json().catch(() => null)) as ReconcileRequest | null;
  const organizationId = body?.organizationId;
  if (!isUuid(organizationId))
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  if (body?.action === "save_account") {
    const account = body.account as Record<string, unknown> | null;
    const name = text(account?.name, 140, true);
    const bankName = text(account?.bankName, 140);
    const accountNumberMasked = text(account?.accountNumberMasked, 80);
    const currencyCode = text(account?.currencyCode, 3, true)?.toUpperCase();
    const openingBalance = typeof account?.openingBalance === "number" ? account.openingBalance : Number(account?.openingBalance ?? 0);
    const openingBalanceDate = account?.openingBalanceDate ? dateValue(account.openingBalanceDate) : null;
    if (!name || !currencyCode || !/^[A-Z]{3}$/.test(currencyCode) || !Number.isFinite(openingBalance) || (account?.openingBalanceDate && !openingBalanceDate))
      return NextResponse.json({ error: "invalid_bank_account" }, { status: 400 });
    const payload = { organization_id: organizationId, name, bank_name: bankName, account_number_masked: accountNumberMasked, currency_code: currencyCode, opening_balance: openingBalance, opening_balance_date: openingBalanceDate, is_active: true };
    const { data: saved, error } = await context.supabase
      .from("bank_accounts")
      .insert(payload)
      .select("id, name")
      .single();
    if (error || !saved)
      return NextResponse.json({ error: "unable_to_save_bank_account" }, { status: 409 });
    return NextResponse.json({ account: saved });
  }

  const bankTransactionId = body?.bankTransactionId;
  const documentId = body?.documentId;
  const documentType = body?.documentType;
  const matchedAmount = readAmount(body?.matchedAmount);
  const notes = readNotes(body?.notes);
  if (
    body?.action !== "reconcile" ||
    !isUuid(bankTransactionId) ||
    !isUuid(documentId) ||
    (documentType !== "issued" && documentType !== "received" && documentType !== "direct") ||
    !matchedAmount ||
    (body?.notes !== undefined &&
      body?.notes !== null &&
      (typeof body.notes !== "string" || body.notes.length > 2_000))
  )
    return NextResponse.json({ error: "invalid_reconciliation" }, { status: 400 });

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
  if (
    (documentType === "direct" && !["approved", "paid"].includes(directDocument.status ?? "")) ||
    (documentType !== "direct" && isPaid(invoiceDocument.payment_status ?? null))
  )
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
