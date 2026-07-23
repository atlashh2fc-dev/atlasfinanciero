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

type ReconciliationMatch = {
  id: string;
  bank_transaction_id: string;
  issued_document_id: string | null;
  received_document_id: string | null;
  direct_payable_id: string | null;
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
  const [notes, setNotes] = useState("");
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
      const documentId = match.issued_document_id ?? match.received_document_id ?? match.direct_payable_id;
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
    if (!selectedTransaction || !data) return [];
    const documents =
      amount(selectedTransaction.amount) > 0
        ? data.issuedDocuments.map((document) => ({
            ...document,
            kind: "issued" as const,
            name: document.client_name || "Cliente sin nombre",
          }))
        : [
            ...data.receivedDocuments.map((document) => ({ ...document, kind: "received" as const, name: document.supplier_name })),
            ...data.directPayables.filter((payable) => payable.currency_code === "CLP").map((payable) => ({ ...payable, document_number: payable.invoice_number || payable.payable_number, kind: "direct" as const, name: payable.supplier_name })),
          ];
    return documents
      .map((document) => {
        const available =
          document.kind === "direct"
            ? amount(document.available_to_reconcile ?? 0)
            : Math.abs(amount(document.total_amount));
        return {
          ...document,
          remaining: Math.max(
            0,
            available - (matchedByDocument.get(document.id) ?? 0),
          ),
        };
      })
      .filter((document) => document.remaining > 0);
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

  function openReconciliation(transaction: BankTransaction) {
    setSelectedTransaction(transaction);
    setSelectedDocumentId("");
    setMatchAmount("");
    setNotes("");
    setMessage(null);
  }

  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !selectedTransaction || !selectedDocument) return;
    setSaving(true);
    const response = await fetch("/api/treasury", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "reconcile",
        organizationId,
        bankTransactionId: selectedTransaction.id,
        documentId: selectedDocument.id,
        documentType: selectedDocument.kind,
        matchedAmount: matchAmount,
        notes,
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; documentPaid?: boolean }
      | null;
    setSaving(false);
    if (!response.ok) {
      setMessage(
        payload?.error === "transaction_direction_mismatch"
          ? "El abono sólo puede conciliar ingresos y el cargo sólo pagos."
          : "No fue posible conciliar. Revisa el monto disponible y vuelve a intentarlo.",
      );
      return;
    }
    setSelectedTransaction(null);
    setMessage(
      payload?.documentPaid
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
                <th className="money-col">Movimientos</th>
                <th className="money-col">Posición</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5}>Cargando posición bancaria…</td></tr>
              ) : accountPositions.length ? (
                accountPositions.map((account) => (
                  <tr key={account.id}>
                    <td><strong>{account.name}</strong><small>{account.account_number_masked || "Sin número informado"}</small></td>
                    <td>{account.bank_name || "—"}</td>
                    <td>{account.currency_code}</td>
                    <td className="money-col">{account.movements}</td>
                    <td className={`money-col ${account.position < 0 ? "is-negative" : ""}`}>{formatAmount(account.position, account.currency_code)}</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={5}>Aún no hay cuentas bancarias configuradas.</td></tr>
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
            <p>Un abono se aplica a una factura emitida y un cargo a una factura recibida o cuenta directa ejecutada mediante una orden de pago. Las aplicaciones parciales se conservan con trazabilidad.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fecha / cuenta</th>
                <th>Movimiento</th>
                <th>Referencia</th>
                <th className="money-col">Monto</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}>Cargando movimientos…</td></tr>
              ) : pendingTransactions.length ? (
                pendingTransactions.map((transaction) => {
                  const account = accountPositions.find((item) => item.id === transaction.bank_account_id);
                  const remaining = Math.max(0, Math.abs(amount(transaction.amount)) - (matchedByTransaction.get(transaction.id) ?? 0));
                  const currencyCode = account?.currency_code || "CLP";
                  return (
                    <tr key={transaction.id}>
                      <td><strong>{displayDate(transaction.booked_on)}</strong><small>{account?.name || "Cuenta no disponible"}</small></td>
                      <td><strong>{transaction.description}</strong><small>Disponible: {formatAmount(remaining, currencyCode)}</small></td>
                      <td>{transaction.reference || "—"}</td>
                      <td className={`money-col ${amount(transaction.amount) < 0 ? "is-negative" : ""}`}>{amount(transaction.amount) < 0 ? "−" : "+"}{formatAmount(Math.abs(amount(transaction.amount)), currencyCode)}</td>
                      <td><span className={reconciliationClass(transaction.reconciliation_status)}>{reconciliationLabel(transaction.reconciliation_status)}</span></td>
                      <td>{canManage ? <button type="button" className="secondary-button" onClick={() => openReconciliation(transaction)}>Conciliar</button> : "Sin permiso de edición"}</td>
                    </tr>
                  );
                })
              ) : (
                <tr><td colSpan={6}>No hay movimientos pendientes de conciliación.</td></tr>
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
                  {amount(selectedTransaction.amount) > 0 ? "Factura emitida" : "Factura recibida o cuenta directa"} *
                  <select required value={selectedDocumentId} onChange={(event) => { const id = event.target.value; setSelectedDocumentId(id); const doc = selectedDocuments.find((item) => item.id === id); setMatchAmount(doc ? String(Math.min(selectedTransactionRemaining, doc.remaining)) : ""); }}>
                    <option value="">Selecciona un documento o cuenta</option>
                    {selectedDocuments.map((document) => <option key={document.id} value={document.id}>{document.kind === "direct" ? "Cuenta directa" : "Documento"} · {document.document_number || "Sin folio"} · {document.name} · Disponible {money.format(document.remaining)}</option>)}
                  </select>
                </label>
                <label>
                  Monto a aplicar *
                  <input required type="number" min="1" step="1" max={Math.min(selectedTransactionRemaining, selectedDocument?.remaining ?? 0)} value={matchAmount} onChange={(event) => setMatchAmount(event.target.value)} />
                </label>
                <label className="collection-note">
                  Observación
                  <textarea maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Ej. abono parcial, diferencia de transferencia" />
                </label>
              </div>
              <div className="form-actions">
                <button type="button" className="secondary-button" onClick={() => setSelectedTransaction(null)}>Cancelar</button>
                <button type="submit" className="primary-button" disabled={saving || !selectedDocument || Number(matchAmount) <= 0}>{saving ? "Conciliando…" : "Aplicar conciliación"}</button>
              </div>
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
