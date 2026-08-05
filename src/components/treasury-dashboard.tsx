"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type BankAccount = {
  id: string;
  name: string;
  bank_name: string | null;
  account_number_masked: string | null;
  currency_code: string;
  opening_balance: number | string;
  opening_balance_date: string | null;
  is_active: boolean;
};

type BankTransaction = {
  id: string;
  bank_account_id: string;
  booked_on: string;
  value_date: string | null;
  description: string;
  reference: string | null;
  amount: number | string;
  balance_after: number | string | null;
  reconciliation_status: "pending" | "partially_reconciled" | "reconciled";
};

type CostCenter = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

type AccountCostCenterAllocation = {
  id: string;
  bank_account_id: string;
  cost_center_id: string;
  allocation_percentage: number | string;
};

type TransactionCostCenterAllocation = {
  id: string;
  bank_transaction_id: string;
  cost_center_id: string;
  allocation_percentage: number | string;
  allocated_amount: number | string;
  source: "account_default" | "manual";
};

type CostCenterAllocationDraft = {
  costCenterId: string;
  allocationPercentage: string;
};

type ReconciliationMatch = {
  id: string;
  bank_transaction_id: string;
  issued_document_id: string | null;
  received_document_id: string | null;
  direct_payable_id: string | null;
  loan_cash_event_id: string | null;
  loan_principal_amount: number | string;
  loan_interest_amount: number | string;
  accounting_entry_id: string | null;
  matched_amount: number | string;
  matched_on: string;
  notes: string | null;
};

type IssuedDocument = {
  id: string;
  document_number: string | null;
  issue_date: string | null;
  client_name: string | null;
  total_amount: number | string | null;
  payment_status: string | null;
  outstanding_amount: number | string;
  available_to_reconcile: number | string;
  collection_status: string;
  is_collectible: boolean;
};

type ReceivedDocument = {
  id: string;
  document_number: string | null;
  issue_date: string;
  supplier_name: string;
  total_amount: number | string;
  payment_status: string | null;
};

type DirectPayable = {
  id: string;
  payable_number: string;
  invoice_number: string | null;
  issue_date: string;
  supplier_name: string;
  total_amount: number | string;
  currency_code: string;
  status: string;
  available_to_reconcile?: number | string;
};

type StatementImport = {
  id: string;
  bank_account_id: string;
  file_name: string;
  imported_rows: number;
  skipped_rows: number;
  status: "processing" | "completed" | "failed";
  created_at: string;
};

type PaymentExecution = {
  id: string;
  direction: "inflow" | "outflow";
  status: string;
  amount: number | string;
  executed_on: string;
  source: string;
  payment_method: string | null;
  payment_reference: string | null;
  notes: string | null;
  direct_payable_id?: string | null;
};

type Counterparty = {
  id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string | null;
};

type CompanyLoan = {
  id: string;
  loan_number: number | string;
  borrower_counterparty_id: string;
  disbursement_bank_account_id: string;
  contract_date: string;
  disbursement_date: string;
  maturity_date: string;
  principal_amount: number | string;
  currency_code: "CLP";
  annual_interest_rate: number | string;
  receivable_account_code: "110230" | "120300";
  agreement_reference: string | null;
  purpose: string | null;
  related_party: boolean;
  stamp_tax_status: "review" | "pending" | "paid" | "not_applicable";
  status: "ready" | "disbursed" | "partially_repaid" | "repaid" | "overdue" | "cancelled";
  disbursed_amount: number | string;
  principal_repaid: number | string;
  interest_collected: number | string;
  principal_outstanding: number | string;
  created_at: string;
};

type LoanCashEvent = {
  id: string;
  loan_id: string;
  bank_account_id: string;
  event_type: "disbursement" | "repayment";
  scheduled_on: string;
  principal_amount: number | string;
  interest_amount: number | string;
  total_amount: number | string;
  status: "pending" | "partially_reconciled" | "reconciled" | "cancelled";
  notes: string | null;
  created_at: string;
};

type ReconciliationTarget = {
  id: string;
  kind: "issued" | "received" | "direct" | "loan";
  document_number: string | null;
  name: string;
  remaining: number;
  loanEvent?: LoanCashEvent;
  principalRemaining?: number;
  interestRemaining?: number;
};

type StatementPreview = {
  accountName: string;
  validRows: number;
  rejectedRows: number;
  rows: Array<{ bookedOn: string; description: string; reference: string | null; amount: number; balanceAfter: number | null }>;
};

type TreasuryPayload = {
  accounts: BankAccount[];
  transactions: BankTransaction[];
  matches: ReconciliationMatch[];
  issuedDocuments: IssuedDocument[];
  receivedDocuments: ReceivedDocument[];
  directPayables: DirectPayable[];
  statementImports: StatementImport[];
  paymentExecutions: PaymentExecution[];
  counterparties: Counterparty[];
  companyLoans: CompanyLoan[];
  loanCashEvents: LoanCashEvent[];
  costCenters: CostCenter[];
  accountCostCenterAllocations: AccountCostCenterAllocation[];
  transactionCostCenterAllocations: TransactionCostCenterAllocation[];
};

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});
const date = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function amount(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function formatAmount(value: number | string | null | undefined, currencyCode = "CLP") {
  const numeric = amount(value);
  if (currencyCode === "UF")
    return `${new Intl.NumberFormat("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(numeric)} UF`;
  try {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: currencyCode, maximumFractionDigits: currencyCode === "CLP" ? 0 : 2 }).format(numeric);
  } catch {
    return `${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(numeric)} ${currencyCode}`;
  }
}

function displayDate(value: string | null) {
  return value ? date.format(new Date(`${value}T00:00:00`)) : "—";
}

function reconciliationLabel(status: BankTransaction["reconciliation_status"]) {
  return {
    pending: "Pendiente",
    partially_reconciled: "Parcial",
    reconciled: "Conciliado",
  }[status];
}

function reconciliationClass(status: BankTransaction["reconciliation_status"]) {
  return status === "reconciled"
    ? "status paid"
    : status === "partially_reconciled"
      ? "status pending"
      : "status neutral";
}

function executionSourceLabel(source: string) {
  return {
    payment_batch: "Orden de pago",
    bank_reconciliation: "Conciliación bancaria",
    manual_receipt: "Cobro registrado",
    legacy_import: "Registro histórico",
  }[source] || source;
}

function executionStatusLabel(status: string) {
  return {
    executed: "Ejecutada",
    reconciled: "Respaldada en cartola",
    legacy: "Histórica",
  }[status] || status;
}

function loanReference(loan: CompanyLoan) {
  return `PRE-${String(loan.loan_number).padStart(6, "0")}`;
}

function loanStatus(loan: CompanyLoan) {
  if (
    !["repaid", "cancelled", "ready"].includes(loan.status) &&
    loan.maturity_date < new Date().toISOString().slice(0, 10) &&
    amount(loan.principal_outstanding) > 0
  ) return "overdue";
  return loan.status;
}

function loanStatusLabel(status: ReturnType<typeof loanStatus>) {
  return {
    ready: "Por desembolsar",
    disbursed: "Vigente",
    partially_repaid: "Con devoluciones",
    repaid: "Pagado",
    overdue: "Vencido",
    cancelled: "Cancelado",
  }[status];
}

function loanStatusClass(status: ReturnType<typeof loanStatus>) {
  if (status === "repaid") return "status paid";
  if (status === "overdue" || status === "cancelled") return "status cancelled";
  if (status === "ready") return "status neutral";
  return "status pending";
}

export function TreasuryDashboard({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const [data, setData] = useState<TreasuryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedTransaction, setSelectedTransaction] =
    useState<BankTransaction | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [matchAmount, setMatchAmount] = useState("");
  const [loanPrincipalMatch, setLoanPrincipalMatch] = useState("");
  const [loanInterestMatch, setLoanInterestMatch] = useState("");
  const [notes, setNotes] = useState("");
  const [reconciliationAttemptId, setReconciliationAttemptId] = useState("");
  const [saving, setSaving] = useState(false);
  const [accountEditorOpen, setAccountEditorOpen] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ name: "", bankName: "", accountNumberMasked: "", currencyCode: "CLP", openingBalance: "0", openingBalanceDate: "" });
  const [selectedImportAccountId, setSelectedImportAccountId] = useState("");
  const [statementFile, setStatementFile] = useState<File | null>(null);
  const [statementPreview, setStatementPreview] = useState<StatementPreview | null>(null);
  const [previewingStatement, setPreviewingStatement] = useState(false);
  const [importingStatement, setImportingStatement] = useState(false);
  const [executionsModalOpen, setExecutionsModalOpen] = useState(false);
  const [executionYear, setExecutionYear] = useState(() => String(new Date().getFullYear()));
  const [loanEditorOpen, setLoanEditorOpen] = useState(false);
  const [loanError, setLoanError] = useState<string | null>(null);
  const [allocationAccount, setAllocationAccount] = useState<BankAccount | null>(null);
  const [allocationTransaction, setAllocationTransaction] = useState<BankTransaction | null>(null);
  const [allocationDraft, setAllocationDraft] = useState<CostCenterAllocationDraft[]>([]);
  const [allocationError, setAllocationError] = useState<string | null>(null);
  const [repaymentLoan, setRepaymentLoan] = useState<CompanyLoan | null>(null);
  const [loanDraft, setLoanDraft] = useState({
    borrowerCounterpartyId: "",
    newBorrowerLegalName: "",
    newBorrowerTaxId: "",
    bankAccountId: "",
    contractDate: new Date().toISOString().slice(0, 10),
    disbursementDate: new Date().toISOString().slice(0, 10),
    maturityDate: "",
    principalAmount: "",
    annualInterestRate: "0",
    agreementReference: "",
    purpose: "",
    relatedParty: false,
    stampTaxStatus: "review",
  });
  const [repaymentDraft, setRepaymentDraft] = useState({
    bankAccountId: "",
    scheduledOn: new Date().toISOString().slice(0, 10),
    principalAmount: "",
    interestAmount: "",
    notes: "",
  });

  async function loadTreasury() {
    if (!organizationId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const response = await fetch(
      `/api/treasury?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    );
    const payload = response.ok ? ((await response.json()) as TreasuryPayload) : null;
    setData(payload);
    setMessage(
      response.ok ? null : "No fue posible cargar la posición de tesorería.",
    );
    setLoading(false);
  }

  useEffect(() => {
    void loadTreasury();
  }, [organizationId]);

  useEffect(() => {
    if (!selectedImportAccountId && data?.accounts[0]) setSelectedImportAccountId(data.accounts[0].id);
  }, [data?.accounts, selectedImportAccountId]);

  useEffect(() => {
    const clpAccount = data?.accounts.find(
      (account) => account.is_active && account.currency_code.toUpperCase() === "CLP",
    );
    if (!clpAccount) return;
    setLoanDraft((current) => current.bankAccountId ? current : { ...current, bankAccountId: clpAccount.id });
    setRepaymentDraft((current) => current.bankAccountId ? current : { ...current, bankAccountId: clpAccount.id });
  }, [data?.accounts]);

  const matchedByTransaction = useMemo(() => {
    const values = new Map<string, number>();
    for (const match of data?.matches ?? []) {
      values.set(
        match.bank_transaction_id,
        (values.get(match.bank_transaction_id) ?? 0) + amount(match.matched_amount),
      );
    }
    return values;
  }, [data?.matches]);

  const matchedByDocument = useMemo(() => {
    const values = new Map<string, number>();
    for (const match of data?.matches ?? []) {
      const documentId = match.issued_document_id
        ?? match.received_document_id
        ?? match.direct_payable_id
        ?? match.loan_cash_event_id;
      if (!documentId) continue;
      values.set(documentId, (values.get(documentId) ?? 0) + amount(match.matched_amount));
    }
    return values;
  }, [data?.matches]);

  const accountPositions = useMemo(
    () =>
      (data?.accounts ?? []).map((account) => {
        const movements = (data?.transactions ?? []).filter(
          (transaction) => transaction.bank_account_id === account.id,
        );
        const latestBalance = movements.find(
          (transaction) => transaction.balance_after !== null,
        )?.balance_after;
        const position =
          latestBalance === undefined
            ? amount(account.opening_balance) +
              movements.reduce(
                (total, transaction) => total + amount(transaction.amount),
                0,
              )
            : amount(latestBalance);
        return { ...account, movements: movements.length, position };
      }),
    [data?.accounts, data?.transactions],
  );

  const pendingTransactions = useMemo(
    () =>
      (data?.transactions ?? []).filter(
        (transaction) => transaction.reconciliation_status !== "reconciled",
      ),
    [data?.transactions],
  );

  const pendingAmount = useMemo(
    () =>
      pendingTransactions.reduce(
        (total, transaction) => total + Math.abs(amount(transaction.amount)),
        0,
      ),
    [pendingTransactions],
  );

  const selectedDocuments = useMemo(() => {
    if (!selectedTransaction || !data) return [] as ReconciliationTarget[];
    const isInflow = amount(selectedTransaction.amount) > 0;
    const documentTargets: ReconciliationTarget[] = isInflow
      ? data.issuedDocuments.map((document) => ({
          id: document.id,
          kind: "issued",
          document_number: document.document_number,
          name: document.client_name || "Cliente sin nombre",
          remaining: Math.max(0, amount(document.available_to_reconcile)),
        }))
      : [
          ...data.receivedDocuments.map((document) => ({
            id: document.id,
            kind: "received" as const,
            document_number: document.document_number,
            name: document.supplier_name,
            remaining: Math.max(
              0,
              Math.abs(amount(document.total_amount)) - (matchedByDocument.get(document.id) ?? 0),
            ),
          })),
          ...data.directPayables
            .filter((payable) => payable.currency_code === "CLP")
            .map((payable) => ({
              id: payable.id,
              kind: "direct" as const,
              document_number: payable.invoice_number || payable.payable_number,
              name: payable.supplier_name,
              remaining: Math.max(0, amount(payable.available_to_reconcile)),
            })),
        ];
    const loanTargets: ReconciliationTarget[] = data.loanCashEvents
      .filter((event) =>
        event.status !== "cancelled"
        && event.status !== "reconciled"
        && event.bank_account_id === selectedTransaction.bank_account_id
        && (isInflow ? event.event_type === "repayment" : event.event_type === "disbursement")
        && (event.event_type !== "repayment"
          || amount(data.companyLoans.find((loan) => loan.id === event.loan_id)?.disbursed_amount) > 0),
      )
      .map((event) => {
        const loan = data.companyLoans.find((item) => item.id === event.loan_id);
        const borrower = data.counterparties.find((item) => item.id === loan?.borrower_counterparty_id);
        const eventMatches = data.matches.filter((match) => match.loan_cash_event_id === event.id);
        const principalRemaining = Math.max(
          0,
          amount(event.principal_amount)
            - eventMatches.reduce((sum, match) => sum + amount(match.loan_principal_amount), 0),
        );
        const interestRemaining = Math.max(
          0,
          amount(event.interest_amount)
            - eventMatches.reduce((sum, match) => sum + amount(match.loan_interest_amount), 0),
        );
        return {
          id: event.id,
          kind: "loan",
          document_number: loan ? loanReference(loan) : "Préstamo",
          name: borrower?.trade_name || borrower?.legal_name || "Empresa deudora",
          remaining: principalRemaining + interestRemaining,
          loanEvent: event,
          principalRemaining,
          interestRemaining,
        };
      });
    return [...documentTargets, ...loanTargets].filter((target) => target.remaining > 0);
  }, [data, matchedByDocument, selectedTransaction]);

  const selectedDocument = selectedDocuments.find(
    (document) => document.id === selectedDocumentId,
  );
  const selectedTransactionRemaining = selectedTransaction
    ? Math.max(
        0,
        Math.abs(amount(selectedTransaction.amount)) -
          (matchedByTransaction.get(selectedTransaction.id) ?? 0),
      )
    : 0;
  const selectedTransactionCurrency = data?.accounts.find((account) => account.id === selectedTransaction?.bank_account_id)?.currency_code || "CLP";
  const selectedAppliedAmount = selectedDocument?.kind === "loan"
    ? amount(loanPrincipalMatch) + amount(loanInterestMatch)
    : amount(matchAmount);

  function openReconciliation(transaction: BankTransaction) {
    setSelectedTransaction(transaction);
    setSelectedDocumentId("");
    setMatchAmount("");
    setLoanPrincipalMatch("");
    setLoanInterestMatch("");
    setNotes("");
    setReconciliationAttemptId(crypto.randomUUID());
    setMessage(null);
  }

  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !selectedTransaction || !selectedDocument || !reconciliationAttemptId || saving) return;
    setSaving(true);
    let response: Response;
    try {
      response = await fetch("/api/treasury", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reconcile",
          organizationId,
          bankTransactionId: selectedTransaction.id,
          documentId: selectedDocument.id,
          documentType: selectedDocument.kind,
          matchedAmount: selectedAppliedAmount,
          loanPrincipalAmount: selectedDocument.kind === "loan" ? amount(loanPrincipalMatch) : 0,
          loanInterestAmount: selectedDocument.kind === "loan" ? amount(loanInterestMatch) : 0,
          idempotencyKey: reconciliationAttemptId,
          notes,
        }),
      });
    } catch {
      setSaving(false);
      setMessage("No hubo respuesta del servidor. El intento conserva su identificador para reintentarlo sin duplicar el cobro.");
      return;
    }
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; documentPaid?: boolean }
      | null;
    setSaving(false);
    if (!response.ok) {
      setMessage(
        payload?.error === "transaction_direction_mismatch"
          ? "El abono sólo puede conciliar ingresos y el cargo sólo pagos."
          : payload?.error === "invalid_loan_allocation"
            ? "Separa correctamente la devolución entre capital e intereses."
            : payload?.error === "loan_event_not_available_for_reconciliation"
              ? "Ese desembolso o devolución ya no tiene saldo disponible. Actualizamos la cartera para evitar duplicarlo."
          : payload?.error === "document_not_available_for_reconciliation"
            ? "El documento ya no tiene monto disponible para conciliar. Actualizamos el control para evitar un cobro duplicado."
            : payload?.error === "idempotency_conflict"
              ? "El identificador del intento ya fue usado con otra aplicación. Cierra esta ventana y vuelve a abrir el movimiento."
          : "No fue posible conciliar. Revisa el monto disponible y vuelve a intentarlo.",
      );
      return;
    }
    setSelectedTransaction(null);
    setReconciliationAttemptId("");
    setMessage(
      selectedDocument.kind === "loan"
        ? "Movimiento conciliado con el préstamo y asiento contable generado automáticamente."
        : payload?.documentPaid
        ? "Movimiento conciliado y documento marcado como pagado."
        : "Aplicación parcial conciliada correctamente.",
    );
    await loadTreasury();
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true);
    const response = await fetch("/api/treasury", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_account", organizationId, account: accountDraft }),
    });
    setSaving(false);
    if (!response.ok) {
      setMessage("No fue posible guardar la cuenta. Revisa los datos obligatorios.");
      return;
    }
    setAccountEditorOpen(false);
    setAccountDraft({ name: "", bankName: "", accountNumberMasked: "", currencyCode: "CLP", openingBalance: "0", openingBalanceDate: "" });
    setMessage("Cuenta bancaria creada. Ya puedes cargar su primera cartola.");
    await loadTreasury();
  }

  function allocationRows(
    allocations: Array<AccountCostCenterAllocation | TransactionCostCenterAllocation>,
  ): CostCenterAllocationDraft[] {
    const rows = allocations.map((allocation) => ({
      costCenterId: allocation.cost_center_id,
      allocationPercentage: String(amount(allocation.allocation_percentage)),
    }));
    if (rows.length) return rows;
    const firstCenter = data?.costCenters[0];
    return firstCenter
      ? [{ costCenterId: firstCenter.id, allocationPercentage: "100" }]
      : [];
  }

  function openAccountAllocations(account: BankAccount) {
    const allocations = (data?.accountCostCenterAllocations ?? [])
      .filter((allocation) => allocation.bank_account_id === account.id);
    setAllocationAccount(account);
    setAllocationTransaction(null);
    setAllocationDraft(allocationRows(allocations));
    setAllocationError(null);
  }

  function openTransactionAllocations(transaction: BankTransaction) {
    const transactionAllocations = (data?.transactionCostCenterAllocations ?? [])
      .filter((allocation) => allocation.bank_transaction_id === transaction.id);
    const accountAllocations = (data?.accountCostCenterAllocations ?? [])
      .filter((allocation) => allocation.bank_account_id === transaction.bank_account_id);
    setAllocationAccount(null);
    setAllocationTransaction(transaction);
    setAllocationDraft(allocationRows(
      transactionAllocations.length ? transactionAllocations : accountAllocations,
    ));
    setAllocationError(null);
  }

  function addAllocationRow() {
    const used = new Set(allocationDraft.map((allocation) => allocation.costCenterId));
    const available = data?.costCenters.find((center) => !used.has(center.id));
    if (!available) return;
    setAllocationDraft((current) => [
      ...current,
      { costCenterId: available.id, allocationPercentage: "" },
    ]);
  }

  async function saveCostCenterAllocations(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || saving || (!allocationAccount && !allocationTransaction)) return;
    const normalized = allocationDraft.map((allocation) => ({
      costCenterId: allocation.costCenterId,
      allocationPercentage: Number(allocation.allocationPercentage),
    }));
    const total = normalized.reduce((sum, allocation) => sum + allocation.allocationPercentage, 0);
    if (
      !normalized.length
      || normalized.some((allocation) =>
        !allocation.costCenterId
        || !Number.isFinite(allocation.allocationPercentage)
        || allocation.allocationPercentage <= 0
        || allocation.allocationPercentage > 100)
      || new Set(normalized.map((allocation) => allocation.costCenterId)).size !== normalized.length
      || Math.abs(total - 100) >= 0.001
    ) {
      setAllocationError("Usa centros distintos y porcentajes positivos que sumen exactamente 100%.");
      return;
    }
    setSaving(true);
    setAllocationError(null);
    const response = await fetch("/api/treasury", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: allocationAccount
          ? "save_account_cost_centers"
          : "save_transaction_cost_centers",
        organizationId,
        bankAccountId: allocationAccount?.id,
        bankTransactionId: allocationTransaction?.id,
        allocations: normalized,
      }),
    });
    const payload = await response.json().catch(() => null) as { error?: string; detail?: string } | null;
    setSaving(false);
    if (!response.ok) {
      setAllocationError(payload?.detail || "No fue posible guardar la distribución por centro de costo.");
      return;
    }
    const targetIsAccount = Boolean(allocationAccount);
    setAllocationAccount(null);
    setAllocationTransaction(null);
    setMessage(
      targetIsAccount
        ? "Distribución guardada. Los movimientos nuevos y los anteriores sin imputación heredarán estos centros de costo."
        : "Distribución del movimiento actualizada.",
    );
    await loadTreasury();
  }

  function openLoanEditor() {
    const today = new Date().toISOString().slice(0, 10);
    const clpAccount = data?.accounts.find(
      (account) => account.is_active && account.currency_code.toUpperCase() === "CLP",
    );
    setLoanDraft({
      borrowerCounterpartyId: data?.counterparties[0]?.id ?? "__new__",
      newBorrowerLegalName: "",
      newBorrowerTaxId: "",
      bankAccountId: clpAccount?.id ?? "",
      contractDate: today,
      disbursementDate: today,
      maturityDate: "",
      principalAmount: "",
      annualInterestRate: "0",
      agreementReference: "",
      purpose: "",
      relatedParty: false,
      stampTaxStatus: "review",
    });
    setLoanEditorOpen(true);
    setLoanError(null);
    setMessage(null);
  }

  async function saveLoan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || saving) return;
    setSaving(true);
    setLoanError(null);
    let borrowerCounterpartyId = loanDraft.borrowerCounterpartyId;
    if (borrowerCounterpartyId === "__new__") {
      const borrowerResponse = await fetch("/api/customer-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_profile",
          organizationId,
          profile: {
            legalName: loanDraft.newBorrowerLegalName,
            taxId: loanDraft.newBorrowerTaxId,
            isActive: true,
          },
          contacts: [],
        }),
      });
      const borrowerPayload = await borrowerResponse.json().catch(() => null) as { id?: string; error?: string } | null;
      if (!borrowerResponse.ok || !borrowerPayload?.id) {
        setSaving(false);
        setLoanError(
          borrowerPayload?.error === "unable_to_create_customer_profile"
            ? "No pudimos crear la empresa. Revisa si ese RUT ya existe en el maestro de clientes."
            : "No fue posible crear la empresa deudora. Revisa su razón social y RUT.",
        );
        return;
      }
      borrowerCounterpartyId = borrowerPayload.id;
      const newCounterparty: Counterparty = {
        id: borrowerCounterpartyId,
        legal_name: loanDraft.newBorrowerLegalName.trim(),
        trade_name: null,
        tax_id: loanDraft.newBorrowerTaxId.trim() || null,
      };
      setData((current) => current
        ? { ...current, counterparties: [...current.counterparties, newCounterparty] }
        : current);
      setLoanDraft((current) => ({ ...current, borrowerCounterpartyId }));
    }
    const response = await fetch("/api/company-loans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_loan",
        organizationId,
        ...loanDraft,
        borrowerCounterpartyId,
      }),
    });
    const payload = await response.json().catch(() => null) as { error?: string; detail?: string } | null;
    setSaving(false);
    if (!response.ok) {
      setLoanError(payload?.detail || "No fue posible registrar el préstamo. Revisa empresa, fechas, monto y cuenta bancaria.");
      return;
    }
    setLoanEditorOpen(false);
    setMessage("Préstamo registrado. Quedó listo para conciliar su desembolso contra la cartola bancaria.");
    await loadTreasury();
  }

  function openRepaymentEditor(loan: CompanyLoan) {
    const clpAccount = data?.accounts.find((account) => account.currency_code === "CLP");
    const scheduledPrincipal = (data?.loanCashEvents ?? [])
      .filter((event) => event.loan_id === loan.id && event.event_type === "repayment" && event.status !== "cancelled")
      .reduce((sum, event) => sum + amount(event.principal_amount), 0);
    setRepaymentDraft({
      bankAccountId: clpAccount?.id ?? loan.disbursement_bank_account_id,
      scheduledOn: new Date().toISOString().slice(0, 10),
      principalAmount: String(Math.max(0, amount(loan.principal_amount) - scheduledPrincipal)),
      interestAmount: "",
      notes: "",
    });
    setRepaymentLoan(loan);
    setMessage(null);
  }

  async function saveRepaymentEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !repaymentLoan || saving) return;
    setSaving(true);
    const response = await fetch("/api/company-loans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_repayment_event",
        organizationId,
        loanId: repaymentLoan.id,
        ...repaymentDraft,
      }),
    });
    const payload = await response.json().catch(() => null) as { error?: string; detail?: string } | null;
    setSaving(false);
    if (!response.ok) {
      setMessage(payload?.detail || "No fue posible programar la devolución. Revisa capital, intereses y fecha.");
      return;
    }
    setRepaymentLoan(null);
    setMessage("Devolución registrada. El próximo abono bancario ya puede conciliarse separando capital e intereses.");
    await loadTreasury();
  }

  async function previewStatement() {
    if (!organizationId || !selectedImportAccountId || !statementFile) return;
    setPreviewingStatement(true);
    const form = new FormData();
    form.set("action", "preview_statement");
    form.set("organizationId", organizationId);
    form.set("bankAccountId", selectedImportAccountId);
    form.set("file", statementFile);
    const response = await fetch("/api/treasury", { method: "POST", body: form });
    const payload = (await response.json().catch(() => null)) as StatementPreview | { detail?: string } | null;
    setPreviewingStatement(false);
    if (!response.ok || !payload || !("rows" in payload)) {
      setStatementPreview(null);
      setMessage(payload && "detail" in payload ? payload.detail ?? "No fue posible leer la cartola." : "No fue posible leer la cartola. Usa un CSV con Fecha, Descripción y Monto o Cargo/Abono.");
      return;
    }
    setStatementPreview(payload);
    setMessage(null);
  }

  async function importStatement() {
    if (!organizationId || !selectedImportAccountId || !statementFile) return;
    setImportingStatement(true);
    const form = new FormData();
    form.set("action", "import_statement");
    form.set("organizationId", organizationId);
    form.set("bankAccountId", selectedImportAccountId);
    form.set("file", statementFile);
    const response = await fetch("/api/treasury", { method: "POST", body: form });
    const payload = (await response.json().catch(() => null)) as { importedRows?: number; skippedRows?: number; error?: string } | null;
    setImportingStatement(false);
    if (!response.ok) {
      setMessage(payload?.error === "statement_already_imported" ? "Esta cartola ya fue cargada para esa cuenta; no se duplicó ningún movimiento." : "No fue posible importar la cartola. Intenta nuevamente.");
      return;
    }
    setMessage(`Cartola incorporada: ${payload?.importedRows ?? 0} movimiento(s) registrados${payload?.skippedRows ? ` y ${payload.skippedRows} omitido(s) por estar repetido(s) o incompleto(s)` : ""}.`);
    setStatementFile(null);
    setStatementPreview(null);
    await loadTreasury();
  }

  const clpPosition = accountPositions.filter((account) => account.currency_code === "CLP").reduce((total, account) => total + account.position, 0);
  const nonClpAccounts = accountPositions.filter((account) => account.currency_code !== "CLP");
  const activeClpAccounts = (data?.accounts ?? []).filter(
    (account) => account.is_active && account.currency_code.toUpperCase() === "CLP",
  );
  const costCenterById = new Map((data?.costCenters ?? []).map((center) => [center.id, center]));
  const cashflowByCostCenter = useMemo(() => {
    const transactionById = new Map((data?.transactions ?? []).map((transaction) => [transaction.id, transaction]));
    const totals = new Map<string, { income: number; expense: number; movements: Set<string> }>();
    for (const allocation of data?.transactionCostCenterAllocations ?? []) {
      const transaction = transactionById.get(allocation.bank_transaction_id);
      if (!transaction) continue;
      const current = totals.get(allocation.cost_center_id) ?? {
        income: 0,
        expense: 0,
        movements: new Set<string>(),
      };
      const signedAmount = amount(transaction.amount) * amount(allocation.allocation_percentage) / 100;
      if (signedAmount >= 0) current.income += signedAmount;
      else current.expense += Math.abs(signedAmount);
      current.movements.add(transaction.id);
      totals.set(allocation.cost_center_id, current);
    }
    return [...totals.entries()]
      .map(([costCenterId, totalsByCenter]) => ({
        costCenterId,
        ...totalsByCenter,
        net: totalsByCenter.income - totalsByCenter.expense,
      }))
      .sort((left, right) => Math.abs(right.net) - Math.abs(left.net));
  }, [data?.transactionCostCenterAllocations, data?.transactions]);
  const loanPortfolio = data?.companyLoans ?? [];
  const outstandingLoanPrincipal = loanPortfolio.reduce(
    (total, loan) => total + amount(loan.principal_outstanding),
    0,
  );
  const activeLoans = loanPortfolio.filter((loan) =>
    ["disbursed", "partially_repaid", "overdue"].includes(loanStatus(loan)),
  );
  const overdueLoans = loanPortfolio.filter((loan) => loanStatus(loan) === "overdue");
  const executionYears = useMemo(() => {
    const years = new Set<string>([String(new Date().getFullYear())]);
    for (const execution of data?.paymentExecutions ?? []) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(execution.executed_on)) years.add(execution.executed_on.slice(0, 4));
    }
    return [...years].sort((left, right) => Number(right) - Number(left));
  }, [data?.paymentExecutions]);
  const executionsToVerify = (data?.paymentExecutions ?? []).filter(
    (execution) => execution.status !== "reconciled" && execution.executed_on.startsWith(`${executionYear}-`),
  );
  const allocationDraftTotal = allocationDraft.reduce(
    (sum, allocation) => sum + amount(allocation.allocationPercentage),
    0,
  );
  const unusedCostCenterCount = (data?.costCenters ?? []).filter(
    (center) => !allocationDraft.some((allocation) => allocation.costCenterId === center.id),
  ).length;

  return (
    <main className="dashboard">
      <section className="headline">
        <div>
          <span className="eyebrow">TESORERÍA · POSICIÓN Y CONCILIACIÓN</span>
          <h1>Control de tesorería</h1>
          <p>
            Consulta saldos por cuenta, identifica movimientos abiertos y aplica
            cada abono o cargo contra su documento de respaldo.
          </p>
        </div>
        {canManage && (
          <div className="headline-actions">
            <button type="button" className="secondary-button" onClick={openLoanEditor}>Registrar préstamo</button>
            <button type="button" className="secondary-button" onClick={() => setAccountEditorOpen(true)}>Nueva cuenta</button>
            <button type="button" className="primary-button" onClick={() => document.getElementById("cargar-cartola")?.scrollIntoView({ behavior: "smooth", block: "start" })} disabled={!data?.accounts.length}>Cargar cartola</button>
          </div>
        )}
      </section>

      {message && <p className="operation-message">{message}</p>}

      <section className="kpis">
        <article className="kpi-card accent">
          <span>Posición disponible CLP</span>
          <strong>{money.format(clpPosition)}</strong>
          <small>{nonClpAccounts.length ? `${accountPositions.length} cuentas; otras monedas se muestran por cuenta` : `${accountPositions.length} cuenta(s) bancaria(s)`}</small>
        </article>
        <article className="kpi-card">
          <span>Por conciliar</span>
          <strong className={pendingTransactions.length ? "is-negative" : ""}>
            {money.format(pendingAmount)}
          </strong>
          <small>{pendingTransactions.length} movimiento(s) abierto(s)</small>
        </article>
        <article className="kpi-card">
          <span>Conciliados</span>
          <strong>
            {(data?.transactions ?? []).filter(
              (transaction) => transaction.reconciliation_status === "reconciled",
            ).length}
          </strong>
          <small>Movimientos con aplicación total</small>
        </article>
        <button type="button" className="kpi-card kpi-card-button" onClick={() => setExecutionsModalOpen(true)} aria-label="Ver detalle de ejecuciones por respaldar">
          <span>Ejecuciones por respaldar · {executionYear}</span>
          <strong>{executionsToVerify.length}</strong>
          <small>Ver detalle anual · no se incluyen en posición hasta cargar cartola</small>
        </button>
      </section>

      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">ACTIVOS FINANCIEROS · PRÉSTAMOS OTORGADOS</span>
            <h2>Cartera de préstamos a empresas</h2>
            <p>
              {activeLoans.length} préstamo(s) vigente(s) · capital por cobrar {money.format(outstandingLoanPrincipal)}
              {overdueLoans.length ? ` · ${overdueLoans.length} vencido(s)` : ""}
            </p>
          </div>
          {canManage && <button type="button" className="primary-button" onClick={openLoanEditor}>Registrar préstamo</button>}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Préstamo / empresa</th>
                <th>Desembolso</th>
                <th>Vencimiento</th>
                <th className="money-col">Capital original</th>
                <th className="money-col">Por cobrar</th>
                <th>Tasa anual</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8}>Cargando cartera de préstamos…</td></tr>
              ) : loanPortfolio.length ? loanPortfolio.map((loan) => {
                const borrower = data?.counterparties.find((item) => item.id === loan.borrower_counterparty_id);
                const effectiveStatus = loanStatus(loan);
                return (
                  <tr key={loan.id}>
                    <td>
                      <strong>{loanReference(loan)} · {borrower?.trade_name || borrower?.legal_name || "Empresa deudora"}</strong>
                      <small>{borrower?.tax_id || "RUT no informado"}{loan.related_party ? " · Parte relacionada" : ""}</small>
                    </td>
                    <td>{displayDate(loan.disbursement_date)}<small>{data?.accounts.find((account) => account.id === loan.disbursement_bank_account_id)?.name || "Cuenta no disponible"}</small></td>
                    <td>{displayDate(loan.maturity_date)}<small>{loan.receivable_account_code === "110230" ? "Activo corriente" : "Activo no corriente"}</small></td>
                    <td className="money-col">{money.format(amount(loan.principal_amount))}</td>
                    <td className="money-col"><strong>{money.format(amount(loan.principal_outstanding))}</strong><small>Devuelto {money.format(amount(loan.principal_repaid))}</small></td>
                    <td>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 4 }).format(amount(loan.annual_interest_rate))}%<small>Intereses cobrados {money.format(amount(loan.interest_collected))}</small></td>
                    <td><span className={loanStatusClass(effectiveStatus)}>{loanStatusLabel(effectiveStatus)}</span><small>{loan.stamp_tax_status === "paid" ? "Timbres pagado" : loan.stamp_tax_status === "not_applicable" ? "Timbres no aplica" : "Timbres por revisar"}</small></td>
                    <td>{canManage && !["repaid", "cancelled"].includes(effectiveStatus) ? <button type="button" className="secondary-button" onClick={() => openRepaymentEditor(loan)}>Registrar devolución</button> : "—"}</td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={8}>Aún no hay préstamos otorgados. Regístralos aquí; no se crean facturas ni cuentas por pagar.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {!loading && !accountPositions.length && (
        <section className="panel treasury-onboarding">
          <span className="panel-label">PUNTO DE PARTIDA</span>
          <h2>Activa la posición bancaria real</h2>
          <p>Primero registra la cuenta y su saldo inicial si corresponde. Después carga la cartola: sólo los movimientos informados por el banco forman la posición y quedan disponibles para conciliar.</p>
          {canManage ? <button type="button" className="primary-button" onClick={() => setAccountEditorOpen(true)}>Registrar primera cuenta</button> : <p className="permission-note">Necesitas permiso de Finanzas para configurar cuentas y cargar cartolas.</p>}
        </section>
      )}

      {canManage && data?.accounts.length ? (
        <section id="cargar-cartola" className="panel treasury-import-panel">
          <div>
            <span className="panel-label">CARGA CONTROLADA</span>
            <h2>Cargar cartola bancaria</h2>
            <p>Importa un archivo CSV exportado por el banco. Primero revisamos las columnas y una muestra; al confirmar, guardamos el archivo, deduplicamos movimientos y los dejamos listos para conciliación.</p>
          </div>
          <div className="treasury-import-form">
            <label>Cuenta bancaria<select value={selectedImportAccountId} onChange={(event) => { setSelectedImportAccountId(event.target.value); setStatementPreview(null); }}>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency_code}</option>)}</select></label>
            <label>Archivo de cartola (.csv)<input type="file" accept=".csv,text/csv,text/plain" onChange={(event) => { setStatementFile(event.target.files?.[0] ?? null); setStatementPreview(null); }} /></label>
            <button type="button" className="secondary-button" onClick={() => void previewStatement()} disabled={!statementFile || previewingStatement}>{previewingStatement ? "Revisando…" : "Previsualizar"}</button>
          </div>
          {statementPreview && <div className="treasury-preview"><strong>{statementPreview.accountName}: {statementPreview.validRows} movimiento(s) detectado(s)</strong><span>{statementPreview.rejectedRows ? `${statementPreview.rejectedRows} fila(s) incompleta(s) se omitirá(n).` : "Las filas detectadas están listas para importar."}</span><div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Descripción</th><th>Referencia</th><th className="money-col">Monto</th></tr></thead><tbody>{statementPreview.rows.map((row, index) => <tr key={`${row.bookedOn}-${index}`}><td>{displayDate(row.bookedOn)}</td><td>{row.description}</td><td>{row.reference || "—"}</td><td className={`money-col ${row.amount < 0 ? "is-negative" : ""}`}>{row.amount < 0 ? "−" : "+"}{money.format(Math.abs(row.amount))}</td></tr>)}</tbody></table></div><div className="form-actions"><button type="button" className="primary-button" onClick={() => void importStatement()} disabled={importingStatement}>{importingStatement ? "Importando…" : "Confirmar e importar"}</button></div></div>}
        </section>
      ) : null}

      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">LECTURA AUTOMÁTICA · INGRESOS Y EGRESOS</span>
            <h2>Flujo por centro de costo</h2>
            <p>Distribución de los últimos movimientos bancarios cargados según la imputación guardada en cada movimiento.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Centro de costo</th>
                <th className="money-col">Ingresos</th>
                <th className="money-col">Egresos</th>
                <th className="money-col">Flujo neto</th>
                <th className="money-col">Movimientos</th>
              </tr>
            </thead>
            <tbody>
              {cashflowByCostCenter.length ? cashflowByCostCenter.map((row) => {
                const center = costCenterById.get(row.costCenterId);
                return (
                  <tr key={row.costCenterId}>
                    <td><strong>{center?.code || "Centro no disponible"}</strong><small>{center?.name || "Revisa la configuración"}</small></td>
                    <td className="money-col">{money.format(row.income)}</td>
                    <td className="money-col is-negative">−{money.format(row.expense)}</td>
                    <td className={`money-col ${row.net < 0 ? "is-negative" : ""}`}>{row.net < 0 ? "−" : ""}{money.format(Math.abs(row.net))}</td>
                    <td className="money-col">{row.movements.size}</td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={5}>Configura los centros de costo de una cuenta bancaria para activar esta lectura automática.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">POSICIÓN BANCARIA</span>
            <h2>Saldos por cuenta</h2>
            <p>
              Se usa el último saldo informado por el banco; si no existe, se
              calcula desde el saldo inicial y los movimientos cargados.
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Cuenta</th>
                <th>Banco</th>
                <th>Moneda</th>
                <th>Centros de costo</th>
                <th className="money-col">Movimientos</th>
                <th className="money-col">Posición</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7}>Cargando posición bancaria…</td></tr>
              ) : accountPositions.length ? (
                accountPositions.map((account) => {
                  const allocations = (data?.accountCostCenterAllocations ?? [])
                    .filter((allocation) => allocation.bank_account_id === account.id);
                  return (
                    <tr key={account.id}>
                      <td><strong>{account.name}</strong><small>{account.account_number_masked || "Sin número informado"}</small></td>
                      <td>{account.bank_name || "—"}</td>
                      <td>{account.currency_code}</td>
                      <td>{allocations.length ? allocations.map((allocation) => {
                        const center = costCenterById.get(allocation.cost_center_id);
                        return <small key={allocation.id}>{center?.code || "Centro"} · {amount(allocation.allocation_percentage)}%</small>;
                      }) : <span className="status neutral">Sin configurar</span>}</td>
                      <td className="money-col">{account.movements}</td>
                      <td className={`money-col ${account.position < 0 ? "is-negative" : ""}`}>{formatAmount(account.position, account.currency_code)}</td>
                      <td>{canManage ? <button type="button" className="secondary-button" onClick={() => openAccountAllocations(account)}>Configurar centros</button> : "—"}</td>
                    </tr>
                  );
                })
              ) : (
                <tr><td colSpan={7}>Aún no hay cuentas bancarias configuradas.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {!!data?.statementImports.length && <section className="table-section">
        <div className="table-heading"><div><span className="panel-label">TRAZABILIDAD</span><h2>Últimas cartolas cargadas</h2><p>Cada importación conserva su archivo original, fecha y resultado.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Archivo</th><th>Cuenta</th><th>Fecha</th><th className="money-col">Movimientos</th><th>Estado</th></tr></thead><tbody>{data.statementImports.map((item) => <tr key={item.id}><td><strong>{item.file_name}</strong><small>{item.skipped_rows ? `${item.skipped_rows} fila(s) omitida(s)` : "Sin filas omitidas"}</small></td><td>{data.accounts.find((account) => account.id === item.bank_account_id)?.name || "Cuenta no disponible"}</td><td>{new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.created_at))}</td><td className="money-col">{item.imported_rows}</td><td><span className={item.status === "completed" ? "status paid" : item.status === "failed" ? "status overdue" : "status pending"}>{item.status === "completed" ? "Importada" : item.status === "failed" ? "Con error" : "Procesando"}</span></td></tr>)}</tbody></table></div>
      </section>}

      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">CONCILIACIÓN</span>
            <h2>Movimientos pendientes</h2>
            <p>Los movimientos pueden aplicarse a documentos operativos o a desembolsos y devoluciones de préstamos. En préstamos, el sistema separa capital e intereses y genera el asiento contable.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha / cuenta</th>
                <th>Movimiento</th>
                <th>Referencia</th>
                <th>Centros de costo</th>
                <th className="money-col">Monto</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7}>Cargando movimientos…</td></tr>
              ) : pendingTransactions.length ? (
                pendingTransactions.map((transaction) => {
                  const account = accountPositions.find((item) => item.id === transaction.bank_account_id);
                  const remaining = Math.max(0, Math.abs(amount(transaction.amount)) - (matchedByTransaction.get(transaction.id) ?? 0));
                  const currencyCode = account?.currency_code || "CLP";
                  const allocations = (data?.transactionCostCenterAllocations ?? [])
                    .filter((allocation) => allocation.bank_transaction_id === transaction.id);
                  return (
                    <tr key={transaction.id}>
                      <td><strong>{displayDate(transaction.booked_on)}</strong><small>{account?.name || "Cuenta no disponible"}</small></td>
                      <td><strong>{transaction.description}</strong><small>{amount(transaction.amount) < 0 ? "Egreso" : "Ingreso"} · disponible {formatAmount(remaining, currencyCode)}</small></td>
                      <td>{transaction.reference || "—"}</td>
                      <td>{allocations.length ? allocations.map((allocation) => {
                        const center = costCenterById.get(allocation.cost_center_id);
                        return <small key={allocation.id}>{center?.code || "Centro"} · {amount(allocation.allocation_percentage)}%</small>;
                      }) : <span className="status neutral">Sin imputar</span>}</td>
                      <td className={`money-col ${amount(transaction.amount) < 0 ? "is-negative" : ""}`}>{amount(transaction.amount) < 0 ? "−" : "+"}{formatAmount(Math.abs(amount(transaction.amount)), currencyCode)}</td>
                      <td><span className={reconciliationClass(transaction.reconciliation_status)}>{reconciliationLabel(transaction.reconciliation_status)}</span></td>
                      <td>{canManage ? <div className="table-action-stack"><button type="button" className="secondary-button" onClick={() => openTransactionAllocations(transaction)}>Centro de costo</button><button type="button" className="secondary-button" onClick={() => openReconciliation(transaction)}>Conciliar</button></div> : "Sin permiso de edición"}</td>
                    </tr>
                  );
                })
              ) : (
                <tr><td colSpan={7}>No hay movimientos pendientes de conciliación.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedTransaction && (
        <div className="modal-backdrop" role="presentation">
          <section className="entry-modal collection-modal" role="dialog" aria-modal="true" aria-labelledby="treasury-reconciliation-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">CONCILIAR MOVIMIENTO</span>
                <h2 id="treasury-reconciliation-title">{selectedTransaction.description}</h2>
                <p>{displayDate(selectedTransaction.booked_on)} · Disponible: {formatAmount(selectedTransactionRemaining, selectedTransactionCurrency)}</p>
              </div>
              <button type="button" className="close-button" onClick={() => setSelectedTransaction(null)} aria-label="Cerrar">×</button>
            </div>
            <form onSubmit={reconcile}>
              <div className="form-grid">
                <label>
                  {amount(selectedTransaction.amount) > 0 ? "Factura emitida o devolución de préstamo" : "Factura recibida, cuenta directa o desembolso"} *
                  <select required value={selectedDocumentId} onChange={(event) => {
                    const id = event.target.value;
                    setSelectedDocumentId(id);
                    const target = selectedDocuments.find((item) => item.id === id);
                    const available = target ? Math.min(selectedTransactionRemaining, target.remaining) : 0;
                    setMatchAmount(target ? String(available) : "");
                    if (target?.kind === "loan") {
                      const principal = Math.min(target.principalRemaining ?? 0, available);
                      const interest = Math.min(target.interestRemaining ?? 0, Math.max(0, available - principal));
                      setLoanPrincipalMatch(String(principal));
                      setLoanInterestMatch(String(interest));
                    } else {
                      setLoanPrincipalMatch("");
                      setLoanInterestMatch("");
                    }
                  }}>
                    <option value="">Selecciona un documento, cuenta o préstamo</option>
                    {selectedDocuments.map((document) => <option key={document.id} value={document.id}>{document.kind === "loan" ? "Préstamo" : document.kind === "direct" ? "Cuenta directa" : "Documento"} · {document.document_number || "Sin folio"} · {document.name} · Disponible {money.format(document.remaining)}</option>)}
                  </select>
                </label>
                {selectedDocument?.kind === "loan" ? <>
                  <label>
                    Capital *
                    <input required type="number" min="0" step="1" max={selectedDocument.principalRemaining ?? 0} value={loanPrincipalMatch} onChange={(event) => setLoanPrincipalMatch(event.target.value)} />
                  </label>
                  <label>
                    Intereses *
                    <input required type="number" min="0" step="1" max={selectedDocument.interestRemaining ?? 0} value={loanInterestMatch} onChange={(event) => setLoanInterestMatch(event.target.value)} />
                  </label>
                  <p className="form-note">Total a conciliar: <strong>{money.format(selectedAppliedAmount)}</strong>. El capital reduce el activo; los intereses se reconocen como ingreso financiero.</p>
                </> : <label>
                  Monto a aplicar *
                  <input required type="number" min="1" step="1" max={Math.min(selectedTransactionRemaining, selectedDocument?.remaining ?? 0)} value={matchAmount} onChange={(event) => setMatchAmount(event.target.value)} />
                </label>}
                <label className="collection-note">
                  Observación
                  <textarea maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Ej. abono parcial, diferencia de transferencia" />
                </label>
              </div>
              <div className="form-actions">
                <button type="button" className="secondary-button" onClick={() => setSelectedTransaction(null)}>Cancelar</button>
                <button type="submit" className="primary-button" disabled={saving || !selectedDocument || selectedAppliedAmount <= 0 || selectedAppliedAmount > selectedTransactionRemaining || selectedAppliedAmount > selectedDocument.remaining}>{saving ? "Conciliando…" : "Aplicar conciliación"}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {(allocationAccount || allocationTransaction) && (
        <div className="modal-backdrop" role="presentation">
          <section className="entry-modal collection-modal" role="dialog" aria-modal="true" aria-labelledby="cost-center-allocation-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">{allocationAccount ? "CONFIGURACIÓN DE CUENTA" : "IMPUTACIÓN DE MOVIMIENTO"}</span>
                <h2 id="cost-center-allocation-title">
                  {allocationAccount ? allocationAccount.name : allocationTransaction?.description}
                </h2>
                <p>
                  {allocationAccount
                    ? "Distribuye automáticamente los ingresos y egresos de esta cuenta. Los porcentajes deben sumar 100%."
                    : "Ajusta sólo este movimiento; la configuración predeterminada de la cuenta no cambia."}
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => {
                  setAllocationAccount(null);
                  setAllocationTransaction(null);
                }}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form onSubmit={saveCostCenterAllocations}>
              {allocationError && <p className="form-error">{allocationError}</p>}
              {data?.costCenters.length ? (
                <div className="allocation-split-list">
                  {allocationDraft.map((allocation, index) => (
                    <div className="allocation-split-row" key={`${allocation.costCenterId}-${index}`}>
                      <label>
                        Centro de costo *
                        <select
                          required
                          value={allocation.costCenterId}
                          onChange={(event) => setAllocationDraft((current) => current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, costCenterId: event.target.value } : item))}
                        >
                          <option value="">Selecciona un centro</option>
                          {data.costCenters.map((center) => (
                            <option
                              key={center.id}
                              value={center.id}
                              disabled={allocationDraft.some((item, itemIndex) =>
                                itemIndex !== index && item.costCenterId === center.id)}
                            >
                              {center.code} · {center.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Porcentaje *
                        <input
                          required
                          type="number"
                          min="0.01"
                          max="100"
                          step="0.01"
                          value={allocation.allocationPercentage}
                          onChange={(event) => setAllocationDraft((current) => current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, allocationPercentage: event.target.value } : item))}
                        />
                      </label>
                      <button
                        type="button"
                        className="text-button"
                        disabled={allocationDraft.length === 1}
                        onClick={() => setAllocationDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      >
                        Quitar
                      </button>
                    </div>
                  ))}
                  <div className="allocation-split-summary">
                    <button type="button" className="secondary-button" onClick={addAllocationRow} disabled={!unusedCostCenterCount}>Añadir centro</button>
                    <strong className={Math.abs(allocationDraftTotal - 100) < 0.001 ? "is-balanced" : "is-unbalanced"}>
                      Total {new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(allocationDraftTotal)}%
                    </strong>
                  </div>
                </div>
              ) : (
                <p className="form-error">Primero crea al menos un centro de costo en el módulo “Centros de costo”.</p>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setAllocationAccount(null);
                    setAllocationTransaction(null);
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={saving || !allocationDraft.length || Math.abs(allocationDraftTotal - 100) >= 0.001}
                >
                  {saving ? "Guardando…" : "Guardar distribución"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {loanEditorOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="entry-modal collection-modal" role="dialog" aria-modal="true" aria-labelledby="company-loan-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">TESORERÍA · ACTIVO FINANCIERO</span>
                <h2 id="company-loan-title">Registrar préstamo otorgado</h2>
                <p>Registra el contrato y el desembolso esperado. No se genera factura: el asiento nace al conciliar la salida bancaria.</p>
              </div>
              <button type="button" className="close-button" onClick={() => setLoanEditorOpen(false)} aria-label="Cerrar">×</button>
            </div>
            <form onSubmit={saveLoan}>
              {loanError && <p className="form-error">{loanError}</p>}
              {!activeClpAccounts.length && (
                <div className="form-error">
                  <p>Necesitas una cuenta bancaria activa en CLP para registrar el desembolso.</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setLoanEditorOpen(false);
                      setAccountEditorOpen(true);
                    }}
                  >
                    Crear cuenta CLP
                  </button>
                </div>
              )}
              <div className="form-grid">
                <label>Empresa deudora *<select required value={loanDraft.borrowerCounterpartyId} onChange={(event) => setLoanDraft({ ...loanDraft, borrowerCounterpartyId: event.target.value })}><option value="">Selecciona una empresa</option>{data?.counterparties.map((counterparty) => <option key={counterparty.id} value={counterparty.id}>{counterparty.trade_name || counterparty.legal_name}{counterparty.tax_id ? ` · ${counterparty.tax_id}` : ""}</option>)}<option value="__new__">＋ Registrar empresa nueva</option></select></label>
                <label>Cuenta bancaria de origen *<select required value={loanDraft.bankAccountId} onChange={(event) => setLoanDraft({ ...loanDraft, bankAccountId: event.target.value })}><option value="">Selecciona una cuenta CLP</option>{activeClpAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.bank_name || "Banco no informado"}</option>)}</select></label>
                {loanDraft.borrowerCounterpartyId === "__new__" && (
                  <>
                    <label>Razón social deudora *<input required maxLength={250} value={loanDraft.newBorrowerLegalName} onChange={(event) => setLoanDraft({ ...loanDraft, newBorrowerLegalName: event.target.value })} placeholder="Ej. Empresa Inversiones SpA" /></label>
                    <label>RUT empresa deudora *<input required maxLength={40} value={loanDraft.newBorrowerTaxId} onChange={(event) => setLoanDraft({ ...loanDraft, newBorrowerTaxId: event.target.value })} placeholder="Ej. 76.123.456-7" /></label>
                  </>
                )}
                <label>Fecha del contrato *<input required type="date" value={loanDraft.contractDate} onChange={(event) => setLoanDraft({ ...loanDraft, contractDate: event.target.value })} /></label>
                <label>Fecha de desembolso *<input required type="date" min={loanDraft.contractDate} value={loanDraft.disbursementDate} onChange={(event) => setLoanDraft({ ...loanDraft, disbursementDate: event.target.value, maturityDate: event.target.value > loanDraft.maturityDate ? "" : loanDraft.maturityDate })} /></label>
                <label>Vencimiento final *<input required type="date" min={loanDraft.disbursementDate} value={loanDraft.maturityDate} onChange={(event) => setLoanDraft({ ...loanDraft, maturityDate: event.target.value })} /></label>
                <label>Capital CLP *<input required type="number" min="1" step="1" value={loanDraft.principalAmount} onChange={(event) => setLoanDraft({ ...loanDraft, principalAmount: event.target.value })} placeholder="Ej. 10000000" /></label>
                <label>Tasa de interés anual (%) *<input required type="number" min="0" max="100" step="0.0001" value={loanDraft.annualInterestRate} onChange={(event) => setLoanDraft({ ...loanDraft, annualInterestRate: event.target.value })} /></label>
                <label>Contrato / referencia<input maxLength={180} value={loanDraft.agreementReference} onChange={(event) => setLoanDraft({ ...loanDraft, agreementReference: event.target.value })} placeholder="Ej. Mutuo 2026-08" /></label>
                <label>Impuesto de Timbres *<select value={loanDraft.stampTaxStatus} onChange={(event) => setLoanDraft({ ...loanDraft, stampTaxStatus: event.target.value })}><option value="review">Requiere revisión</option><option value="pending">Determinado, pendiente de pago</option><option value="paid">Pagado</option><option value="not_applicable">No aplicable</option></select></label>
                <label className="collection-note">Objetivo / condiciones<textarea maxLength={2000} value={loanDraft.purpose} onChange={(event) => setLoanDraft({ ...loanDraft, purpose: event.target.value })} placeholder="Destino de los fondos y condiciones relevantes" /></label>
                <label><span>Relación entre empresas</span><span><input type="checkbox" checked={loanDraft.relatedParty} onChange={(event) => setLoanDraft({ ...loanDraft, relatedParty: event.target.checked })} /> Es una parte relacionada</span></label>
              </div>
              <p className="form-note">Hasta 12 meses se presenta inicialmente como préstamo por cobrar corriente; sobre 12 meses, como no corriente. La reclasificación posterior debe revisarse en cada cierre.</p>
              <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setLoanEditorOpen(false)}>Cancelar</button><button type="submit" className="primary-button" disabled={saving || !activeClpAccounts.length}>{saving ? "Registrando…" : "Registrar préstamo"}</button></div>
            </form>
          </section>
        </div>
      )}

      {repaymentLoan && (
        <div className="modal-backdrop" role="presentation">
          <section className="entry-modal collection-modal" role="dialog" aria-modal="true" aria-labelledby="loan-repayment-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">PRÉSTAMO {loanReference(repaymentLoan)}</span>
                <h2 id="loan-repayment-title">Registrar devolución esperada</h2>
                <p>Indica cuánto del próximo abono corresponde a capital y cuánto a intereses.</p>
              </div>
              <button type="button" className="close-button" onClick={() => setRepaymentLoan(null)} aria-label="Cerrar">×</button>
            </div>
            <form onSubmit={saveRepaymentEvent}>
              <div className="form-grid">
                <label>Cuenta de ingreso *<select required value={repaymentDraft.bankAccountId} onChange={(event) => setRepaymentDraft({ ...repaymentDraft, bankAccountId: event.target.value })}><option value="">Selecciona una cuenta CLP</option>{data?.accounts.filter((account) => account.currency_code === "CLP").map((account) => <option key={account.id} value={account.id}>{account.name} · {account.bank_name || "Banco no informado"}</option>)}</select></label>
                <label>Fecha esperada *<input required type="date" min={repaymentLoan.disbursement_date} value={repaymentDraft.scheduledOn} onChange={(event) => setRepaymentDraft({ ...repaymentDraft, scheduledOn: event.target.value })} /></label>
                <label>Capital a devolver *<input required type="number" min="0" step="1" max={amount(repaymentLoan.principal_amount)} value={repaymentDraft.principalAmount} onChange={(event) => setRepaymentDraft({ ...repaymentDraft, principalAmount: event.target.value })} /></label>
                <label>Intereses a cobrar *<input required type="number" min="0" step="1" value={repaymentDraft.interestAmount} onChange={(event) => setRepaymentDraft({ ...repaymentDraft, interestAmount: event.target.value })} /></label>
                <label className="collection-note">Observación<textarea maxLength={2000} value={repaymentDraft.notes} onChange={(event) => setRepaymentDraft({ ...repaymentDraft, notes: event.target.value })} placeholder="Ej. Primera cuota o pago total" /></label>
              </div>
              <p className="form-note">Total esperado: <strong>{money.format(amount(repaymentDraft.principalAmount) + amount(repaymentDraft.interestAmount))}</strong>. Al conciliar, el capital reduce “Préstamos por cobrar” y los intereses van a ingreso financiero.</p>
              <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setRepaymentLoan(null)}>Cancelar</button><button type="submit" className="primary-button" disabled={saving || amount(repaymentDraft.principalAmount) + amount(repaymentDraft.interestAmount) <= 0}>{saving ? "Registrando…" : "Registrar devolución"}</button></div>
            </form>
          </section>
        </div>
      )}

      {accountEditorOpen && (
        <div className="modal-backdrop" role="presentation"><section className="entry-modal collection-modal" role="dialog" aria-modal="true" aria-labelledby="bank-account-title"><div className="modal-header"><div><span className="eyebrow">CONFIGURACIÓN BANCARIA</span><h2 id="bank-account-title">Nueva cuenta bancaria</h2><p>El saldo inicial sólo se usa hasta que la cartola informe un saldo posterior.</p></div><button type="button" className="close-button" onClick={() => setAccountEditorOpen(false)} aria-label="Cerrar">×</button></div><form onSubmit={saveAccount}><div className="form-grid"><label>Nombre de la cuenta *<input required maxLength={140} value={accountDraft.name} onChange={(event) => setAccountDraft({ ...accountDraft, name: event.target.value })} placeholder="Ej. Cuenta corriente operaciones" /></label><label>Banco<input maxLength={140} value={accountDraft.bankName} onChange={(event) => setAccountDraft({ ...accountDraft, bankName: event.target.value })} placeholder="Ej. Banco de Chile" /></label><label>Número enmascarado<input maxLength={80} value={accountDraft.accountNumberMasked} onChange={(event) => setAccountDraft({ ...accountDraft, accountNumberMasked: event.target.value })} placeholder="Ej. **** 4582" /></label><label>Moneda *<select value={accountDraft.currencyCode} onChange={(event) => setAccountDraft({ ...accountDraft, currencyCode: event.target.value })}><option value="CLP">CLP · Pesos chilenos</option><option value="USD">USD · Dólares</option><option value="UF">UF · Unidad de Fomento</option></select></label><label>Saldo inicial<input type="number" step="any" value={accountDraft.openingBalance} onChange={(event) => setAccountDraft({ ...accountDraft, openingBalance: event.target.value })} /></label><label>Fecha del saldo inicial<input type="date" value={accountDraft.openingBalanceDate} onChange={(event) => setAccountDraft({ ...accountDraft, openingBalanceDate: event.target.value })} /></label></div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setAccountEditorOpen(false)}>Cancelar</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Guardando…" : "Guardar cuenta"}</button></div></form></section></div>
      )}

      {executionsModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="entry-modal treasury-executions-modal" role="dialog" aria-modal="true" aria-labelledby="treasury-executions-title">
            <div className="modal-header">
              <div>
                <span className="eyebrow">CONTROL OPERATIVO · TESORERÍA</span>
                <h2 id="treasury-executions-title">Ejecuciones por respaldar · {executionYear}</h2>
                <p>Son pagos o abonos registrados en los módulos financieros. El control se consulta por año contable; no afecta la posición bancaria hasta que el banco lo confirme.</p>
              </div>
              <button type="button" className="close-button" onClick={() => setExecutionsModalOpen(false)} aria-label="Cerrar">×</button>
            </div>
            <div className="treasury-execution-summary">
              <div><strong>{executionsToVerify.length}</strong><span>ejecuciones pendientes de respaldo en cartola</span></div>
              <label>Año contable<select value={executionYear} onChange={(event) => setExecutionYear(event.target.value)}>{executionYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            </div>
            <div className="table-scroll treasury-executions-table">
              <table>
                <thead><tr><th>Fecha</th><th>Origen</th><th>Referencia</th><th>Medio / observación</th><th className="money-col">Monto</th><th>Estado</th></tr></thead>
                <tbody>
                  {executionsToVerify.length ? executionsToVerify.map((execution) => (
                    <tr key={execution.id}>
                      <td>{displayDate(execution.executed_on)}</td>
                      <td><strong>{execution.direction === "outflow" ? "Egreso" : "Ingreso"}</strong><small>{executionSourceLabel(execution.source)}</small></td>
                      <td>{execution.payment_reference || "Sin referencia informada"}</td>
                      <td>{execution.payment_method || "Medio no informado"}<small>{execution.notes || "Sin observación"}</small></td>
                      <td className={`money-col ${execution.direction === "outflow" ? "is-negative" : ""}`}>{execution.direction === "outflow" ? "−" : "+"}{money.format(amount(execution.amount))}</td>
                      <td><span className={execution.status === "reconciled" ? "status paid" : "status pending"}>{executionStatusLabel(execution.status)}</span></td>
                    </tr>
                  )) : <tr><td colSpan={6}>No hay ejecuciones pendientes de respaldo.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setExecutionsModalOpen(false)}>Cerrar</button></div>
          </section>
        </div>
      )}
    </main>
  );
}
