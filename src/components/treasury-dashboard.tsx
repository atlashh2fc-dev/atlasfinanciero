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
};

type TreasuryPayload = {
  accounts: BankAccount[];
  transactions: BankTransaction[];
  matches: ReconciliationMatch[];
  issuedDocuments: IssuedDocument[];
  receivedDocuments: ReceivedDocument[];
  directPayables: DirectPayable[];
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
      .map((document) => ({
        ...document,
        remaining: Math.max(
          0,
          Math.abs(amount(document.total_amount)) -
            (matchedByDocument.get(document.id) ?? 0),
        ),
      }))
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

  const totalPosition = accountPositions.reduce(
    (total, account) => total + account.position,
    0,
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
      </section>

      {message && <p className="operation-message">{message}</p>}

      <section className="kpis kpis-six">
        <article className="kpi-card accent">
          <span>Posición disponible</span>
          <strong>{money.format(totalPosition)}</strong>
          <small>{accountPositions.length} cuenta(s) bancaria(s)</small>
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
                    <td className={`money-col ${account.position < 0 ? "is-negative" : ""}`}>{money.format(account.position)}</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={5}>Aún no hay cuentas bancarias configuradas.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">CONCILIACIÓN</span>
            <h2>Movimientos pendientes</h2>
            <p>Un abono se aplica a una factura emitida y un cargo a una factura recibida o cuenta directa ya ejecutada por lote. Las aplicaciones parciales se conservan con trazabilidad.</p>
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
                  return (
                    <tr key={transaction.id}>
                      <td><strong>{displayDate(transaction.booked_on)}</strong><small>{account?.name || "Cuenta no disponible"}</small></td>
                      <td><strong>{transaction.description}</strong><small>Disponible: {money.format(remaining)}</small></td>
                      <td>{transaction.reference || "—"}</td>
                      <td className={`money-col ${amount(transaction.amount) < 0 ? "is-negative" : ""}`}>{amount(transaction.amount) < 0 ? "−" : "+"}{money.format(Math.abs(amount(transaction.amount)))}</td>
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
                <p>{displayDate(selectedTransaction.booked_on)} · Disponible: {money.format(selectedTransactionRemaining)}</p>
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
    </main>
  );
}
