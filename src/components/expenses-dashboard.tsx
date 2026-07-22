"use client";

import { useEffect, useMemo, useState } from "react";

type ReceivedDocument = { id: string; supplier_counterparty_id: string | null; supplier_name: string; supplier_tax_id: string | null; document_number: string | null; issue_date: string; document_type: string; net_amount: number | string; vat_amount: number | string; additional_tax_amount: number | string; total_amount: number | string; notes: string | null; due_date: string | null; payment_status: string | null; payment_method: string | null; payment_bank: string | null; payment_reference: string | null; payment_date: string | null; attachment_path: string | null; attachment_name: string | null; attachment_mime_type: string | null; attachment_size: number | null };
type DirectPayable = { id: string; payable_number: string; supplier_counterparty_id: string | null; supplier_name: string; invoice_number: string | null; category: string; category_detail: string | null; description: string; issue_date: string; due_date: string | null; total_amount: number | string; currency_code: string; status: "draft" | "review" | "approved" | "rejected" | "paid"; notes: string | null; payment_reference: string | null; paid_at: string | null; factoring_issued_document_id: string | null; is_reference: boolean; reference_settled_at: string | null; reference_settlement_note: string | null };
type Payable = { id: string; source: "received" | "direct"; supplier_counterparty_id: string | null; supplier_name: string; supplier_tax_id: string | null; document_number: string | null; issue_date: string; document_type: string; net_amount: number | string; vat_amount: number | string; additional_tax_amount: number | string; total_amount: number | string; currency_code: string; notes: string | null; due_date: string | null; payment_status: string | null; payment_method: string | null; payment_bank: string | null; payment_reference: string | null; payment_date: string | null; attachment_path: string | null; attachment_name: string | null; attachment_mime_type: string | null; attachment_size: number | null; workflow_status: DirectPayable["status"] | null; factoring_issued_document_id: string | null; is_reference: boolean; reference_settled_at: string | null; reference_settlement_note: string | null };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });
const amount = (value: number | string | null | undefined) => Number(value ?? 0);
const displayDate = (value: string | null) => value ? date.format(new Date(`${value}T00:00:00`)) : "—";
const displayAmount = (value: number | string, currency: string) => currency === "UF" ? `${Number(value).toLocaleString("es-CL", { maximumFractionDigits: 4 })} UF` : money.format(amount(value));
const normal = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() ?? "";
const directStatusLabel: Record<DirectPayable["status"], string> = { draft: "Borrador", review: "Pendiente de aprobación", approved: "Aprobada para pago", rejected: "Rechazada", paid: "Pagada" };
const isCredit = (document: Payable) => normal(document.document_type).includes("nota de credito");
const isGuide = (document: Payable) => normal(document.document_type).includes("guia de despacho");
const isInvoice = (document: Payable) => !isCredit(document) && !isGuide(document);
const signedTotal = (document: Payable) => isCredit(document) ? -amount(document.total_amount) : isGuide(document) ? 0 : amount(document.total_amount);
const statusClass = (status: string | null) => normal(status).includes("pagada") || normal(status).includes("liquidada") ? "status paid" : normal(status).includes("pendiente") ? "status pending" : normal(status).includes("rechazada") || normal(status).includes("nota") ? "status cancelled" : "status neutral";
const countsAsExpense = (item: Payable) => item.source === "received" || (!item.factoring_issued_document_id && (item.workflow_status === "approved" || item.workflow_status === "paid"));
const supplierKey = (item: Pick<Payable, "supplier_counterparty_id" | "supplier_tax_id" | "supplier_name">) => item.supplier_counterparty_id || item.supplier_tax_id || item.supplier_name;

export function ExpensesDashboard({ organizationId, canManage }: { organizationId: string | null; canManage: boolean }) {
  const [documents, setDocuments] = useState<ReceivedDocument[]>([]);
  const [directPayables, setDirectPayables] = useState<DirectPayable[]>([]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [supplier, setSupplier] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [referenceToSettle, setReferenceToSettle] = useState<Payable | null>(null);
  const [referenceDate, setReferenceDate] = useState(new Date().toISOString().slice(0, 10));
  const [referenceNote, setReferenceNote] = useState("");
  const [savingReference, setSavingReference] = useState(false);
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) { setDocuments([]); setDirectPayables([]); setLoading(false); return; }
    let active = true; setLoading(true);
    fetch(`/api/received-documents?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ documents: ReceivedDocument[]; directPayables: DirectPayable[] }> : Promise.reject(new Error("Unable to load accounts payable")))
      .then((payload) => { if (active) { setDocuments(payload.documents ?? []); setDirectPayables(payload.directPayables ?? []); setMessage(""); } })
      .catch(() => { if (active) setMessage("No fue posible cargar las cuentas por pagar y proveedores."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId]);

  const payables = useMemo<Payable[]>(() => [
    ...documents.map((document) => ({ ...document, source: "received" as const, currency_code: "CLP", workflow_status: null, factoring_issued_document_id: null, is_reference: false, reference_settled_at: null, reference_settlement_note: null })),
    ...directPayables.map((payable) => ({ id: payable.id, source: "direct" as const, supplier_counterparty_id: payable.supplier_counterparty_id, supplier_name: payable.supplier_name, supplier_tax_id: null, document_number: payable.invoice_number || payable.payable_number, issue_date: payable.issue_date, document_type: payable.is_reference ? "Referencia de factoring" : "Cuenta por pagar directa", net_amount: payable.total_amount, vat_amount: 0, additional_tax_amount: 0, total_amount: payable.total_amount, currency_code: payable.currency_code, notes: payable.notes || payable.description, due_date: payable.due_date, payment_status: payable.is_reference ? payable.reference_settled_at ? "Liquidada (referencial)" : "Pendiente de referencia" : directStatusLabel[payable.status], payment_method: payable.is_reference ? "Control de factoring" : payable.status === "paid" ? "Orden de pago" : null, payment_bank: null, payment_reference: payable.is_reference ? payable.reference_settlement_note : payable.payment_reference, payment_date: payable.is_reference ? payable.reference_settled_at?.slice(0, 10) ?? null : payable.paid_at?.slice(0, 10) ?? null, attachment_path: null, attachment_name: null, attachment_mime_type: null, attachment_size: null, workflow_status: payable.status, factoring_issued_document_id: payable.factoring_issued_document_id, is_reference: payable.is_reference, reference_settled_at: payable.reference_settled_at, reference_settlement_note: payable.reference_settlement_note })),
  ], [documents, directPayables]);
  const years = useMemo(() => [...new Set(payables.map((item) => item.issue_date.slice(0, 4)))].sort((a, b) => b.localeCompare(a)), [payables]);
  const suppliers = useMemo(() => [...new Map(payables.map((item) => [supplierKey(item), item])).values()].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name, "es")), [payables]);
  const statuses = useMemo(() => [...new Set(payables.map((item) => item.payment_status).filter((item): item is string => Boolean(item)))].sort((a, b) => a.localeCompare(b, "es")), [payables]);
  const visible = useMemo(() => payables.filter((item) => {
    const matchesYear = year === "all" || item.issue_date.startsWith(`${year}-`);
    const matchesSupplier = supplier === "all" || supplierKey(item) === supplier;
    const matchesStatus = status === "all" || item.payment_status === status;
    const haystack = `${item.supplier_name} ${item.supplier_tax_id ?? ""} ${item.document_number ?? ""} ${item.notes ?? ""}`.toLocaleLowerCase();
    return matchesYear && matchesSupplier && matchesStatus && haystack.includes(search.trim().toLocaleLowerCase());
  }), [payables, year, supplier, status, search]);
  const summary = useMemo(() => {
    const recognized = visible.filter(countsAsExpense).filter((item) => item.currency_code === "CLP");
    const invoices = recognized.filter(isInvoice); const paid = invoices.filter((item) => normal(item.payment_status).includes("pagada")).reduce((total, item) => total + amount(item.total_amount), 0); const expense = recognized.reduce((total, item) => total + signedTotal(item), 0);
    return { expense, paid, pending: expense - paid, invoices: invoices.length, credits: recognized.filter(isCredit).length, suppliers: new Set(visible.map(supplierKey)).size, directPendingApproval: visible.filter((item) => item.source === "direct" && item.workflow_status === "review").length };
  }, [visible]);
  const supplierSummary = useMemo(() => {
    const bySupplier = new Map<string, { name: string; taxId: string | null; documents: number; total: number }>();
    for (const item of visible.filter(countsAsExpense).filter((item) => item.currency_code === "CLP" && !isGuide(item))) { const key = supplierKey(item); const current = bySupplier.get(key) ?? { name: item.supplier_name, taxId: item.supplier_tax_id, documents: 0, total: 0 }; current.documents += 1; current.total += signedTotal(item); bySupplier.set(key, current); }
    return [...bySupplier.values()];
  }, [visible]);

  function openReferenceControl(item: Payable) {
    setReferenceToSettle(item);
    setReferenceDate(item.reference_settled_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
    setReferenceNote(item.reference_settlement_note ?? "");
    setMessage("");
  }

  async function openAttachment(item: Payable) {
    if (!organizationId || item.source !== "received" || !item.attachment_path) return;
    setOpeningDocumentId(item.id);
    setMessage("");
    const response = await fetch(`/api/received-documents?organizationId=${encodeURIComponent(organizationId)}&fileId=${encodeURIComponent(item.id)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { signedUrl?: string } | null;
    setOpeningDocumentId(null);
    if (!response.ok || !payload?.signedUrl) {
      setMessage("No fue posible abrir el respaldo de esta factura.");
      return;
    }
    window.open(payload.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function saveReferenceControl() {
    if (!organizationId || !referenceToSettle) return;
    setSavingReference(true);
    const response = await fetch("/api/received-documents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "settle_factoring_reference",
        organizationId,
        referenceId: referenceToSettle.id,
        settledAt: referenceDate,
        note: referenceNote,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      reference?: { reference_settled_at: string; reference_settlement_note: string | null };
    } | null;
    setSavingReference(false);
    if (!response.ok || !payload?.reference) {
      setMessage("No fue posible actualizar la referencia de factoring.");
      return;
    }
    setDirectPayables((current) =>
      current.map((item) =>
        item.id === referenceToSettle.id
          ? {
              ...item,
              reference_settled_at: payload.reference!.reference_settled_at,
              reference_settlement_note:
                payload.reference!.reference_settlement_note,
            }
          : item,
      ),
    );
    setReferenceToSettle(null);
    setMessage("Referencia de factoring actualizada. No se generó salida de caja ni pago en Tesorería.");
  }

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">GESTIÓN INTERNA · {year === "all" ? "TODOS LOS AÑOS" : year}</span><h1>Cuentas por pagar y proveedores</h1><p>Facturas recibidas y cuentas directas, con su aprobación, vencimiento, propuesta y pago conectados en una sola bandeja.</p></div><div className="headline-actions"><label className="period-picker">Año<select value={year} onChange={(event) => setYear(event.target.value)}><option value="all">Todos</option>{years.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="kpis kpis-six"><article className="kpi-card"><span>Gasto registrado</span><strong>{money.format(summary.expense)}</strong><small>Documentos y cuentas directas aprobadas</small></article><article className="kpi-card accent"><span>Pagado</span><strong>{money.format(summary.paid)}</strong><small>Confirmado por orden de pago o documento</small></article><article className="kpi-card"><span>Pendiente de pago</span><strong className={summary.pending > 0 ? "is-negative" : ""}>{money.format(summary.pending)}</strong><small>Registros aprobados aún abiertos</small></article><article className="kpi-card"><span>Por aprobar</span><strong>{summary.directPendingApproval}</strong><small>Cuentas directas en aprobación</small></article><article className="kpi-card"><span>Proveedores</span><strong>{summary.suppliers}</strong><small>Con registros en el filtro</small></article><article className="kpi-card"><span>Registros</span><strong>{visible.length}</strong><small>{summary.credits} nota(s) de crédito</small></article></section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">FILTROS</span><h2>Documentos y cuentas por pagar</h2><p>Una cuenta directa aprobada queda disponible en Compras, obligaciones y pagos; las referencias de factoring sólo se controlan aquí y no generan salida de caja.</p></div><button type="button" className="secondary-button" onClick={() => { setSupplier("all"); setStatus("all"); setSearch(""); }}>Limpiar filtros</button></div>
      <div className="expense-filter-row"><label><span>Proveedor</span><select value={supplier} onChange={(event) => setSupplier(event.target.value)}><option value="all">Todos los proveedores</option>{suppliers.map((item) => <option key={supplierKey(item)} value={supplierKey(item)}>{item.supplier_name}{item.supplier_tax_id ? ` · ${item.supplier_tax_id}` : ""}</option>)}</select></label><label><span>Estado</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todos los estados</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Buscar</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Proveedor, folio o detalle" /></label></div>
      {loading ? <p className="billing-empty">Cargando cuentas por pagar…</p> : <div className="table-scroll"><table><thead><tr><th>Documento / cuenta</th><th>Proveedor</th><th>Emisión / vencimiento</th><th>Detalle</th><th className="money-col">Neto</th><th className="money-col">IVA</th><th className="money-col">Total</th><th>Estado</th><th>Control</th></tr></thead><tbody>{visible.length ? visible.map((item) => <tr key={`${item.source}-${item.id}`} className="expense-document-row"><td><strong>{item.document_type}</strong><small>{item.is_reference ? "Control referencial" : item.source === "direct" ? "Cuenta directa" : "Documento recibido"} · Folio: {item.document_number || "—"}</small></td><td><strong>{item.supplier_name}</strong><small>{item.supplier_tax_id || "Sin RUT"}</small></td><td>{displayDate(item.issue_date)}<small>{item.is_reference ? "Referencia: sin salida de caja" : `Vence: ${displayDate(item.due_date)}`}</small></td><td><small>{item.notes || "Sin observación"}</small></td><td className="money-col">{displayAmount(item.net_amount, item.currency_code)}</td><td className="money-col">{item.currency_code === "CLP" ? money.format(amount(item.vat_amount) + amount(item.additional_tax_amount)) : "—"}</td><td className={`money-col ${isCredit(item) ? "is-negative" : ""}`}>{isCredit(item) ? "−" : ""}{displayAmount(item.total_amount, item.currency_code)}</td><td><span className={statusClass(item.payment_status)}>{item.payment_status || "Sin estado"}</span><small>{[item.payment_method, item.payment_bank, displayDate(item.payment_date)].filter((value) => value && value !== "—").join(" · ") || (item.is_reference ? "Pendiente de control referencial" : item.source === "direct" && item.workflow_status === "review" ? "Pendiente de decisión en Aprobaciones" : "Pendiente de propuesta o conciliación")}</small>{item.payment_reference && <small>Ref.: {item.payment_reference}</small>}</td><td>{item.source === "received" && item.attachment_path ? <button type="button" className="secondary-button" disabled={openingDocumentId === item.id} onClick={() => void openAttachment(item)}>{openingDocumentId === item.id ? "Abriendo…" : "Abrir respaldo"}</button> : item.is_reference && canManage ? <button type="button" className="secondary-button" onClick={() => openReferenceControl(item)}>{item.reference_settled_at ? "Actualizar control" : "Liquidar referencia"}</button> : "—"}</td></tr>) : <tr><td colSpan={9}>No hay registros para los filtros seleccionados.</td></tr>}</tbody></table></div>}
    </section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">PROVEEDORES</span><h2>Concentración de gasto registrado</h2><p>Incluye documentos y cuentas directas aprobadas; las pendientes de aprobación se exhiben arriba, pero aún no alteran el gasto.</p></div></div><div className="table-scroll"><table><thead><tr><th>Proveedor</th><th>RUT</th><th className="money-col">Registros</th><th className="money-col">Gasto registrado</th></tr></thead><tbody>{supplierSummary.sort((a, b) => b.total - a.total).slice(0, 20).map((item) => <tr key={item.taxId || item.name}><td><strong>{item.name}</strong></td><td>{item.taxId || "—"}</td><td className="money-col">{item.documents}</td><td className={`money-col ${item.total < 0 ? "is-negative" : ""}`}>{money.format(item.total)}</td></tr>)}</tbody></table></div></section>
    {referenceToSettle && <div className="modal-backdrop" role="presentation"><section className="entry-modal" role="dialog" aria-modal="true" aria-labelledby="factoring-reference-title"><div className="modal-header"><div><span className="eyebrow">CONTROL REFERENCIAL · FACTORING</span><h2 id="factoring-reference-title">Liquidar referencia</h2><p>{referenceToSettle.supplier_name} · {referenceToSettle.document_number || "Sin folio"}. Este control no genera gasto, pago ni movimiento en Tesorería.</p></div><button type="button" className="close-button" onClick={() => setReferenceToSettle(null)} aria-label="Cerrar">×</button></div><div className="form-grid"><label>Fecha de liquidación *<input required type="date" value={referenceDate} onChange={(event) => setReferenceDate(event.target.value)} /></label><label className="p2p-form-wide">Referencia / observación<input maxLength={2000} value={referenceNote} onChange={(event) => setReferenceNote(event.target.value)} placeholder="Ej. Liquidación informada por factoring" /></label></div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setReferenceToSettle(null)}>Cancelar</button><button type="button" className="primary-button" disabled={savingReference || !referenceDate} onClick={() => void saveReferenceControl()}>{savingReference ? "Guardando…" : "Guardar control"}</button></div></section></div>}
  </main>;
}
