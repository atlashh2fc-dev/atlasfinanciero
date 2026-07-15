"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type ReceivedDocument = {
  id: string; supplier_counterparty_id: string | null; supplier_name: string; supplier_tax_id: string | null; document_number: string | null; issue_date: string; document_type: string; net_amount: number | string; vat_amount: number | string; additional_tax_amount: number | string; total_amount: number | string; notes: string | null; payment_term_days: number | null; due_date: string | null; due_month: string | null; payment_status: string | null; payment_method: string | null; payment_bank: string | null; payment_reference: string | null; payment_notes: string | null; payment_date: string | null; payment_recorded_at: string | null; payment_recorded_by: string | null; source_file_name: string; source_sheet_name: string; source_row: number;
};

type PaymentDraft = { document: ReceivedDocument; paymentDate: string; paymentMethod: string; paymentBank: string; paymentReference: string; paymentNotes: string };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });
const amount = (value: number | string | null | undefined) => Number(value ?? 0);
const displayDate = (value: string | null) => value ? date.format(new Date(`${value}T00:00:00`)) : "—";
const normal = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() ?? "";
const isCredit = (document: ReceivedDocument) => normal(document.document_type).includes("nota de credito");
const isGuide = (document: ReceivedDocument) => normal(document.document_type).includes("guia de despacho");
const isInvoice = (document: ReceivedDocument) => !isCredit(document) && !isGuide(document);
const signedTotal = (document: ReceivedDocument) => isCredit(document) ? -amount(document.total_amount) : isGuide(document) ? 0 : amount(document.total_amount);
const statusClass = (status: string | null) => normal(status).includes("pagada") ? "status paid" : normal(status).includes("pendiente") ? "status pending" : normal(status).includes("nota") ? "status cancelled" : "status neutral";
const currentDate = () => new Date().toISOString().slice(0, 10);

export function ExpensesDashboard({ organizationId, canManage }: { organizationId: string | null; canManage: boolean }) {
  const [documents, setDocuments] = useState<ReceivedDocument[]>([]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [supplier, setSupplier] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft | null>(null);
  const [isSavingPayment, setIsSavingPayment] = useState(false);

  useEffect(() => {
    if (!organizationId) { setDocuments([]); setLoading(false); return; }
    let active = true; setLoading(true);
    fetch(`/api/received-documents?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ documents: ReceivedDocument[] }> : Promise.reject(new Error("Unable to load expenses")))
      .then((payload) => { if (active) { setDocuments(payload.documents ?? []); setMessage(""); } })
      .catch(() => { if (active) setMessage("No fue posible cargar los gastos y proveedores."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId]);

  const years = useMemo(() => [...new Set(documents.map((document) => document.issue_date.slice(0, 4)))].sort((a, b) => b.localeCompare(a)), [documents]);
  const suppliers = useMemo(() => [...new Map(documents.map((document) => [document.supplier_tax_id || document.supplier_name, document])).values()].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name, "es")), [documents]);
  const statuses = useMemo(() => [...new Set(documents.map((document) => document.payment_status).filter((item): item is string => Boolean(item)))].sort((a, b) => a.localeCompare(b, "es")), [documents]);
  const visible = useMemo(() => documents.filter((document) => {
    const matchesYear = year === "all" || document.issue_date.startsWith(`${year}-`);
    const matchesSupplier = supplier === "all" || (document.supplier_tax_id || document.supplier_name) === supplier;
    const matchesStatus = status === "all" || document.payment_status === status;
    const haystack = `${document.supplier_name} ${document.supplier_tax_id ?? ""} ${document.document_number ?? ""} ${document.notes ?? ""}`.toLocaleLowerCase();
    return matchesYear && matchesSupplier && matchesStatus && haystack.includes(search.trim().toLocaleLowerCase());
  }), [documents, year, supplier, status, search]);
  const summary = useMemo(() => {
    const invoices = visible.filter(isInvoice); const paid = invoices.filter((document) => normal(document.payment_status).includes("pagada")).reduce((total, document) => total + amount(document.total_amount), 0); const expense = visible.reduce((total, document) => total + signedTotal(document), 0);
    return { expense, paid, pending: expense - paid, invoices: invoices.length, credits: visible.filter(isCredit).length, suppliers: new Set(visible.map((document) => document.supplier_tax_id || document.supplier_name)).size };
  }, [visible]);
  const supplierSummary = useMemo(() => {
    const bySupplier = new Map<string, { name: string; taxId: string | null; documents: number; total: number }>();
    for (const document of visible.filter((item) => !isGuide(item))) { const key = document.supplier_tax_id || document.supplier_name; const current = bySupplier.get(key) ?? { name: document.supplier_name, taxId: document.supplier_tax_id, documents: 0, total: 0 }; current.documents += 1; current.total += signedTotal(document); bySupplier.set(key, current); }
    return [...bySupplier.values()];
  }, [visible]);
  const openPayment = (document: ReceivedDocument) => setPaymentDraft({ document, paymentDate: document.payment_date ?? currentDate(), paymentMethod: document.payment_method ?? "Transferencia", paymentBank: document.payment_bank ?? "", paymentReference: document.payment_reference ?? "", paymentNotes: document.payment_notes ?? "" });
  const updateDraft = (field: Exclude<keyof PaymentDraft, "document">, value: string) => setPaymentDraft((draft) => draft ? { ...draft, [field]: value } : null);
  const savePayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!paymentDraft || !organizationId) return; setIsSavingPayment(true); setMessage("");
    try {
      const response = await fetch("/api/received-documents", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, documentId: paymentDraft.document.id, paymentDate: paymentDraft.paymentDate, paymentMethod: paymentDraft.paymentMethod, paymentBank: paymentDraft.paymentBank, paymentReference: paymentDraft.paymentReference, paymentNotes: paymentDraft.paymentNotes }) });
      const payload = await response.json().catch(() => null) as { document?: ReceivedDocument; error?: string } | null;
      if (!response.ok || !payload?.document) throw new Error(payload?.error || "unable_to_register_payment");
      setDocuments((current) => current.map((document) => document.id === payload.document?.id ? payload.document : document)); setPaymentDraft(null); setMessage("Pago registrado y factura actualizada.");
    } catch { setMessage("No fue posible registrar el pago. Revisa los datos e inténtalo nuevamente."); } finally { setIsSavingPayment(false); }
  };

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">GESTIÓN INTERNA · {year === "all" ? "TODOS LOS AÑOS" : year}</span><h1>Gastos y proveedores</h1><p>Facturas recibidas, notas de crédito y pagos con trazabilidad de proveedor, vencimiento y fila de origen.</p></div><div className="headline-actions"><label className="period-picker">Año<select value={year} onChange={(event) => setYear(event.target.value)}><option value="all">Todos</option>{years.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="kpis kpis-six"><article className="kpi-card"><span>Gasto documentado</span><strong>{money.format(summary.expense)}</strong><small>Facturas y exentas, menos notas de crédito</small></article><article className="kpi-card accent"><span>Pagado</span><strong>{money.format(summary.paid)}</strong><small>Documentos marcados como pagados</small></article><article className="kpi-card"><span>Pendiente de pago</span><strong className={summary.pending > 0 ? "is-negative" : ""}>{money.format(summary.pending)}</strong><small>Gasto documentado menos pagos registrados</small></article><article className="kpi-card"><span>Proveedores</span><strong>{summary.suppliers}</strong><small>Con documentos en el filtro</small></article><article className="kpi-card"><span>Facturas</span><strong>{summary.invoices}</strong><small>{summary.credits} nota(s) de crédito</small></article></section>
    <section className="table-section">
      <div className="table-heading"><div><span className="panel-label">FILTROS</span><h2>Detalle de facturas recibidas</h2><p>Selecciona una factura para registrar o editar su pago.</p></div><button type="button" className="secondary-button" onClick={() => { setSupplier("all"); setStatus("all"); setSearch(""); }}>Limpiar filtros</button></div>
      <div className="expense-filter-row">
        <label><span>Proveedor</span><select value={supplier} onChange={(event) => setSupplier(event.target.value)}><option value="all">Todos los proveedores</option>{suppliers.map((item) => <option key={item.supplier_tax_id || item.supplier_name} value={item.supplier_tax_id || item.supplier_name}>{item.supplier_name}{item.supplier_tax_id ? ` · ${item.supplier_tax_id}` : ""}</option>)}</select></label>
        <label><span>Estado de pago</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos los estados</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label><span>Buscar</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Proveedor, RUT, folio o detalle" /></label>
      </div>
      {loading ? <p className="billing-empty">Cargando documentos recibidos…</p> : <div className="table-scroll"><table><thead><tr><th>Documento</th><th>Proveedor</th><th>Emisión / vencimiento</th><th>Detalle</th><th className="money-col">Neto</th><th className="money-col">IVA</th><th className="money-col">Total</th><th>Pago</th></tr></thead><tbody>{visible.length ? visible.map((document) => {
        const actionable = canManage && isInvoice(document);
        const actionLabel = normal(document.payment_status).includes("pagada") ? "Editar pago" : "Registrar pago";
        return <tr key={document.id} className={actionable ? "expense-document-row is-actionable" : "expense-document-row"} tabIndex={actionable ? 0 : undefined} role={actionable ? "button" : undefined} aria-label={actionable ? `${actionLabel}: factura ${document.document_number || "sin folio"} de ${document.supplier_name}` : undefined} onClick={actionable ? () => openPayment(document) : undefined} onKeyDown={actionable ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPayment(document); } } : undefined}><td><strong>{document.document_type}</strong><small>Folio: {document.document_number || "—"}{actionable ? ` · ${actionLabel}` : ""}</small></td><td><strong>{document.supplier_name}</strong><small>{document.supplier_tax_id || "Sin RUT"}</small></td><td>{displayDate(document.issue_date)}<small>Vence: {displayDate(document.due_date)}</small></td><td><small>{document.notes || "Sin observación"}</small></td><td className="money-col">{money.format(amount(document.net_amount))}</td><td className="money-col">{money.format(amount(document.vat_amount) + amount(document.additional_tax_amount))}</td><td className={`money-col ${isCredit(document) ? "is-negative" : ""}`}>{isCredit(document) ? "−" : ""}{money.format(amount(document.total_amount))}</td><td><span className={statusClass(document.payment_status)}>{document.payment_status || "Sin estado"}</span><small>{[document.payment_method, document.payment_bank, displayDate(document.payment_date)].filter((item) => item && item !== "—").join(" · ") || "Sin pago registrado"}</small>{document.payment_reference && <small>Ref.: {document.payment_reference}</small>}</td></tr>;
      }) : <tr><td colSpan={8}>No hay documentos para los filtros seleccionados.</td></tr>}</tbody></table></div>}
    </section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">PROVEEDORES</span><h2>Concentración de gasto documentado</h2><p>Las guías se conservan en el detalle, pero no alteran el total de gasto.</p></div></div><div className="table-scroll"><table><thead><tr><th>Proveedor</th><th>RUT</th><th className="money-col">Documentos</th><th className="money-col">Gasto documentado</th></tr></thead><tbody>{supplierSummary.sort((a, b) => b.total - a.total).slice(0, 20).map((item) => <tr key={item.taxId || item.name}><td><strong>{item.name}</strong></td><td>{item.taxId || "—"}</td><td className="money-col">{item.documents}</td><td className={`money-col ${item.total < 0 ? "is-negative" : ""}`}>{money.format(item.total)}</td></tr>)}</tbody></table></div></section>
    {paymentDraft && <div className="modal-backdrop" role="presentation"><section className="entry-modal collection-modal" role="dialog" aria-modal="true" aria-labelledby="payment-title"><div className="modal-header"><div><span className="eyebrow">REGISTRO DE PAGO</span><h2 id="payment-title">Factura N° {paymentDraft.document.document_number || "—"}</h2><p>{paymentDraft.document.supplier_name} · {money.format(amount(paymentDraft.document.total_amount))}</p></div><button type="button" className="close-button" onClick={() => setPaymentDraft(null)} aria-label="Cerrar">×</button></div><form onSubmit={savePayment}><div className="form-grid"><label>Fecha de pago *<input required type="date" value={paymentDraft.paymentDate} onChange={(event) => updateDraft("paymentDate", event.target.value)} /></label><label>Medio de pago *<select value={paymentDraft.paymentMethod} onChange={(event) => updateDraft("paymentMethod", event.target.value)}><option value="Transferencia">Transferencia</option><option value="Cheque">Cheque</option><option value="Tarjeta">Tarjeta</option><option value="Efectivo">Efectivo</option><option value="Otro">Otro</option></select></label><label>Banco o cuenta de origen<input maxLength={120} value={paymentDraft.paymentBank} onChange={(event) => updateDraft("paymentBank", event.target.value)} placeholder="Ej. Banco BCI" /></label><label>Referencia o comprobante<input maxLength={180} value={paymentDraft.paymentReference} onChange={(event) => updateDraft("paymentReference", event.target.value)} placeholder="N° transferencia, folio o comprobante" /></label><label className="collection-note">Observación del pago<textarea maxLength={2000} value={paymentDraft.paymentNotes} onChange={(event) => updateDraft("paymentNotes", event.target.value)} placeholder="Información adicional del pago" /></label></div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setPaymentDraft(null)}>Cancelar</button><button type="submit" className="primary-button" disabled={isSavingPayment}>{isSavingPayment ? "Guardando…" : "Registrar pago total"}</button></div></form></section></div>}
  </main>;
}
