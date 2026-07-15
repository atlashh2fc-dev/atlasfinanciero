"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Customer = { id?: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type CatalogItem = { id: string; name: string; category: string | null; unit_name: string; unit_price: number; currency: "CLP" | "UF" | "USD"; is_active: boolean };
type CustomerService = { id: string; counterparty_id: string; service_catalog_id: string; quantity: number; unit_price: number; currency: "CLP" | "UF" | "USD"; starts_on: string | null; ends_on: string | null; billing_frequency: "monthly" | "one_time" | "annual" | "quarterly"; notes: string | null; is_active: boolean };
type CustomerFile = { id: string; counterparty_id: string; file_name: string; mime_type: string | null; file_size: number | null; document_type: string; notes: string | null; created_at: string };
type Issued = { id: string; counterparty_id: string | null; document_number: string | null; issue_date: string | null; document_type: string | null; client_name: string | null; recipient_name: string | null; total_amount: number | null; payment_status: string | null };
type Received = { id: string; supplier_counterparty_id: string | null; supplier_name: string; document_number: string | null; issue_date: string; document_type: string; total_amount: number; payment_status: string | null };
type Data = { catalog: CatalogItem[]; services: CustomerService[]; files: CustomerFile[]; issuedDocuments: Issued[]; receivedDocuments: Received[]; canReadExpenses: boolean };

const money = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });
const date = (value: string | null) => value ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`)) : "Sin fecha";
const normalize = (value: string | null | undefined) => (value ?? "").trim().toLocaleUpperCase();
const today = () => new Date().toISOString().slice(0, 10);

type UfQuote = { date: string; value: number; source: "SII"; sourceUrl: string };

export function CustomerControlCard({ organizationId, customer, canManage }: { organizationId: string | null; customer: Customer; canManage: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("0");
  const [currency, setCurrency] = useState<"CLP" | "UF">("CLP");
  const [ufPricingDate, setUfPricingDate] = useState(today());
  const [ufQuote, setUfQuote] = useState<UfQuote | null>(null);
  const [loadingUf, setLoadingUf] = useState(false);
  const [frequency, setFrequency] = useState<CustomerService["billing_frequency"]>("monthly");
  const [upload, setUpload] = useState<File | null>(null);

  const load = async () => {
    if (!organizationId) return;
    setLoading(true);
    const response = await fetch(`/api/customer-control?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Data | null;
    if (response.ok && payload) { setData(payload); setMessage(""); } else setMessage("No fue posible cargar el control documental del cliente.");
    setLoading(false);
  };
  useEffect(() => { void load(); }, [organizationId]);
  useEffect(() => { setSelectedCatalogId(""); setQuantity("1"); setUnitPrice("0"); setCurrency("CLP"); setUfPricingDate(today()); setUfQuote(null); }, [customer.id]);

  useEffect(() => {
    if (currency !== "UF") { setUfQuote(null); return; }
    let active = true;
    setLoadingUf(true);
    fetch(`/api/uf?date=${encodeURIComponent(ufPricingDate)}`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<UfQuote> : null)
      .then((quote) => { if (active) setUfQuote(quote); })
      .catch(() => { if (active) setUfQuote(null); })
      .finally(() => { if (active) setLoadingUf(false); });
    return () => { active = false; };
  }, [currency, ufPricingDate]);

  const clientNames = useMemo(() => new Set([normalize(customer.legal_name), normalize(customer.trade_name)].filter(Boolean)), [customer]);
  const issued = useMemo(() => (data?.issuedDocuments ?? []).filter((item) => item.counterparty_id === customer.id || clientNames.has(normalize(item.client_name)) || clientNames.has(normalize(item.recipient_name))), [data, customer.id, clientNames]);
  const received = useMemo(() => (data?.receivedDocuments ?? []).filter((item) => item.supplier_counterparty_id === customer.id || clientNames.has(normalize(item.supplier_name))), [data, customer.id, clientNames]);
  const services = useMemo(() => (data?.services ?? []).filter((item) => item.counterparty_id === customer.id), [data, customer.id]);
  const files = useMemo(() => (data?.files ?? []).filter((item) => item.counterparty_id === customer.id), [data, customer.id]);
  const catalogById = useMemo(() => new Map((data?.catalog ?? []).map((item) => [item.id, item])), [data]);
  const availableCatalog = useMemo(() => (data?.catalog ?? []).filter((item) => item.is_active), [data]);

  const chooseCatalog = (id: string) => {
    setSelectedCatalogId(id);
    const item = catalogById.get(id);
    if (item) {
      setUnitPrice(String(item.unit_price));
      setCurrency(item.currency === "UF" ? "UF" : "CLP");
    }
  };
  const saveService = async (event: FormEvent) => {
    event.preventDefault(); if (!organizationId || !customer.id || !selectedCatalogId) return;
    const response = await fetch("/api/customer-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_service", organizationId, item: { counterpartyId: customer.id, catalogId: selectedCatalogId, quantity, unitPrice, currency, billingFrequency: frequency, isActive: true } }) });
    if (!response.ok) return setMessage("No fue posible guardar el servicio. Revisa cantidad y precio.");
    setMessage("Servicio contratado guardado."); setSelectedCatalogId(""); setQuantity("1"); await load();
  };
  const removeService = async (id: string) => {
    if (!organizationId || !window.confirm("¿Quitar este servicio de la ficha del cliente?")) return;
    const response = await fetch("/api/customer-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete_service", organizationId, serviceId: id }) });
    if (!response.ok) return setMessage("No fue posible quitar el servicio.");
    setMessage("Servicio quitado."); await load();
  };
  const uploadContract = async (event: FormEvent) => {
    event.preventDefault(); if (!organizationId || !customer.id || !upload) return;
    const form = new FormData(); form.set("organizationId", organizationId); form.set("counterpartyId", customer.id); form.set("file", upload); form.set("documentType", "contract");
    const response = await fetch("/api/customer-control", { method: "POST", body: form });
    if (!response.ok) return setMessage("No fue posible subir el contrato. Usa PDF, Word, JPG o PNG de hasta 50 MB.");
    setUpload(null); const input = document.getElementById(`contract-${customer.id}`) as HTMLInputElement | null; if (input) input.value = ""; setMessage("Contrato guardado en la ficha del cliente."); await load();
  };
  const openFile = async (id: string) => {
    if (!organizationId) return;
    const response = await fetch(`/api/customer-control?organizationId=${encodeURIComponent(organizationId)}&fileId=${encodeURIComponent(id)}`);
    const payload = await response.json().catch(() => null) as { signedUrl?: string } | null;
    if (!response.ok || !payload?.signedUrl) return setMessage("No fue posible abrir el documento.");
    window.open(payload.signedUrl, "_blank", "noopener,noreferrer");
  };

  return <section className="customer-control">
    <div className="customer-control-heading"><div><span className="panel-label">CONTROL DEL CLIENTE</span><h3>Contratos, servicios y documentos</h3><p>Los documentos se relacionan por la ficha o por la razón social registrada.</p></div><button type="button" className="secondary-button" onClick={() => void load()}>Actualizar</button></div>
    {message && <p className="operation-message">{message}</p>}
    {loading ? <p className="billing-empty">Cargando control del cliente…</p> : <div className="customer-control-grid">
      <article className="customer-control-section"><div className="section-title"><h4>Contratos y anexos</h4><span>{files.length}</span></div>{files.length ? <div className="control-list">{files.map((file) => <div key={file.id}><div><strong>{file.file_name}</strong><small>{file.document_type === "annex" ? "Anexo" : "Contrato"} · {new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(file.created_at))}</small></div><button type="button" className="text-button" onClick={() => void openFile(file.id)}>Abrir</button></div>)}</div> : <p className="control-empty">Sin contratos cargados.</p>}{canManage && <form className="contract-upload" onSubmit={uploadContract}><label htmlFor={`contract-${customer.id}`}>Subir contrato<input id={`contract-${customer.id}`} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={(event) => setUpload(event.target.files?.[0] ?? null)} /></label><button className="secondary-button" type="submit" disabled={!upload}>Guardar documento</button></form>}</article>
      <article className="customer-control-section"><div className="section-title"><h4>Servicios contratados</h4><span>{services.length}</span></div>{services.length ? <div className="control-list">{services.map((service) => { const item = catalogById.get(service.service_catalog_id); return <div key={service.id}><div><strong>{item?.name ?? "Servicio no disponible"}</strong><small>{service.quantity} × {service.currency} {money.format(Number(service.unit_price))}{service.currency === "UF" ? " · valorización SII en cada prefactura" : ""} · {service.billing_frequency === "monthly" ? "Mensual" : service.billing_frequency === "annual" ? "Anual" : service.billing_frequency === "quarterly" ? "Trimestral" : "Única vez"}</small></div>{canManage && <button type="button" className="text-button" onClick={() => void removeService(service.id)}>Quitar</button>}</div>; })}</div> : <p className="control-empty">Sin servicios contratados.</p>}{canManage && <form className="service-assignment" onSubmit={saveService}><label>Servicio<select value={selectedCatalogId} onChange={(event) => chooseCatalog(event.target.value)} required><option value="">Seleccionar…</option>{availableCatalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Cantidad<input type="number" min="0.0001" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required /></label><label>Precio pactado<input type="number" min="0" step={currency === "UF" ? "0.0001" : "1"} value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} required /></label><label>Moneda<select value={currency} onChange={(event) => setCurrency(event.target.value as "CLP" | "UF")}><option value="CLP">CLP</option><option value="UF">UF</option></select></label>{currency === "UF" && <label>Fecha UF SII<input type="date" value={ufPricingDate} onChange={(event) => setUfPricingDate(event.target.value)} required /></label>}<label>Frecuencia<select value={frequency} onChange={(event) => setFrequency(event.target.value as CustomerService["billing_frequency"])}><option value="monthly">Mensual</option><option value="quarterly">Trimestral</option><option value="annual">Anual</option><option value="one_time">Única vez</option></select></label>{currency === "UF" && <p className="form-note">{loadingUf ? "Consultando UF oficial…" : ufQuote ? `SII · ${ufQuote.date}: 1 UF = CLP ${money.format(ufQuote.value)}. Referencia: CLP ${money.format(Number(unitPrice || 0) * ufQuote.value)}.` : "No hay valor UF del SII disponible para esta fecha."}</p>}<button className="primary-button" type="submit" disabled={currency === "UF" && (!ufQuote || loadingUf)}>Agregar servicio</button></form>}</article>
      <article className="customer-control-section documents-section"><div className="section-title"><h4>Facturas de venta</h4><span>{issued.length}</span></div>{issued.length ? <div className="control-list">{issued.slice(0, 8).map((item) => <div key={item.id}><div><strong>{item.document_type || "Documento"} {item.document_number || "s/n"}</strong><small>{date(item.issue_date)} · {item.payment_status || "Sin estado"}</small></div><b>CLP {money.format(Number(item.total_amount ?? 0))}</b></div>)}</div> : <p className="control-empty">No se encontraron facturas de venta para esta ficha.</p>}</article>
      <article className="customer-control-section documents-section"><div className="section-title"><h4>Facturas de gasto</h4><span>{received.length}</span></div>{data?.canReadExpenses ? received.length ? <div className="control-list">{received.slice(0, 8).map((item) => <div key={item.id}><div><strong>{item.document_type} {item.document_number || "s/n"}</strong><small>{date(item.issue_date)} · {item.payment_status || "Sin estado"}</small></div><b>CLP {money.format(Number(item.total_amount ?? 0))}</b></div>)}</div> : <p className="control-empty">No se encontraron facturas de gasto para esta ficha.</p> : <p className="control-empty">Tu rol no puede ver documentos de gasto.</p>}</article>
    </div>}
  </section>;
}
