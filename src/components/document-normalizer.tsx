"use client";

import { FormEvent, useEffect, useState } from "react";

export type NormalizationTarget = {
  id: string;
  kind: "issued" | "received" | "direct";
  title: string;
  invoiceNumber: string | null;
};

export function DocumentNormalizer({
  organizationId,
  target,
  onClose,
  onSaved,
}: {
  organizationId: string | null;
  target: NormalizationTarget | null;
  onClose: () => void;
  onSaved: (invoiceNumber: string) => void | Promise<void>;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState(target?.invoiceNumber ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setInvoiceNumber(target?.invoiceNumber ?? "");
    setFile(null);
    setError("");
  }, [target?.id, target?.invoiceNumber]);

  if (!target) return null;
  const currentTarget = target;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !file || !invoiceNumber.trim()) {
      setError("Ingresa el número de factura y adjunta el archivo tributario.");
      return;
    }
    setSaving(true);
    setError("");
    const form = new FormData();
    form.set("organizationId", organizationId);
    form.set("recordId", currentTarget.id);
    form.set("kind", currentTarget.kind);
    form.set("invoiceNumber", invoiceNumber.trim());
    form.set("file", file);
    const response = await fetch("/api/document-normalization", {
      method: "POST",
      body: form,
    });
    setSaving(false);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(
        payload?.error === "reference_not_normalizable"
          ? "Una referencia de factoring no corresponde a una factura de proveedor."
          : payload?.error === "invalid_normalization"
            ? "Usa un folio válido y un PDF, JPG o PNG de máximo 50 MB."
            : "No fue posible guardar la factura. Revisa tus permisos e inténtalo nuevamente.",
      );
      return;
    }
    await onSaved(invoiceNumber.trim());
    onClose();
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="entry-modal" role="dialog" aria-modal="true" aria-labelledby="normalize-invoice-title">
        <div className="modal-header">
          <div>
            <span className="eyebrow">NORMALIZAR REGISTRO</span>
            <h2 id="normalize-invoice-title">Ingresar factura</h2>
            <p>{target.title}. El folio y el archivo quedan vinculados a este registro.</p>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        <form onSubmit={save}>
          <div className="form-grid">
            <label>
              N° de factura *
              <input value={invoiceNumber} maxLength={80} onChange={(event) => setInvoiceNumber(event.target.value)} required />
            </label>
            <label>
              Archivo de factura *
              <input type="file" required accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <small>PDF, JPG o PNG · máximo 50 MB</small>
            </label>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
            <button type="submit" className="primary-button" disabled={saving}>{saving ? "Guardando…" : "Guardar factura"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
