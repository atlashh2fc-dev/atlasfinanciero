// Referencias de un DTE (sección <Referencia> del XML o detTipoDocRef /
// detFolioDocRef del RCV). Se guardan en received_documents.sii_references y
// un trigger de base de datos construye los vínculos documentales desde ahí.
// Sin dependencias para poder probarse con Node directamente.

export type DteReference = {
  /** Código SII del documento referenciado (33, 52, 61, 801 = orden de compra…); null si es un código textual desconocido. */
  type: number | null;
  folio: string;
  date: string | null;
  /** CodRef: 1 anula, 2 corrige texto, 3 corrige montos. */
  code: number | null;
  reason: string | null;
};

export const PURCHASE_ORDER_REFERENCE_TYPE = 801;

// Algunos emisores informan el tipo como texto en vez del código SII.
const TEXT_REFERENCE_TYPES: Record<string, number> = {
  OC: PURCHASE_ORDER_REFERENCE_TYPE,
  ORDENDECOMPRA: PURCHASE_ORDER_REFERENCE_TYPE,
};

function scalar(value: unknown) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "string" || typeof candidate === "number") return String(candidate).trim();
  if (candidate && typeof candidate === "object" && "#text" in candidate) return String((candidate as Record<string, unknown>)["#text"] ?? "").trim();
  return "";
}

export function referenceType(value: unknown): number | null {
  const raw = scalar(value);
  if (!raw) return null;
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  const compact = raw.toUpperCase().replace(/[\s.]+/g, "");
  return TEXT_REFERENCE_TYPES[compact] ?? null;
}

function referenceDate(value: unknown) {
  const raw = scalar(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function referenceCode(value: unknown) {
  const raw = scalar(value);
  return /^\d{1,3}$/.test(raw) ? Number(raw) : null;
}

/** Convierte los nodos <Referencia> ya parseados (objeto o arreglo) en referencias normalizadas. */
export function parseDteReferences(value: unknown): DteReference[] {
  const nodes = (Array.isArray(value) ? value : [value])
    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object");
  const references: DteReference[] = [];
  for (const node of nodes) {
    const folio = scalar(node.FolioRef);
    if (!folio) continue;
    references.push({
      type: referenceType(node.TpoDocRef),
      folio: folio.slice(0, 100),
      date: referenceDate(node.FchRef),
      code: referenceCode(node.CodRef),
      reason: scalar(node.RazonRef).slice(0, 500) || null,
    });
  }
  return references;
}

/** Folio de la orden de compra: sólo desde una referencia tipo 801, nunca de otro documento citado. */
export function purchaseOrderReference(references: DteReference[]) {
  return references.find((reference) => reference.type === PURCHASE_ORDER_REFERENCE_TYPE)?.folio ?? null;
}

/** Referencia informada por el RCV (sólo tipo y folio del documento citado). */
export function rcvReference(type: number | null, folio: string | null): DteReference[] {
  const cleanFolio = folio?.trim();
  if (!cleanFolio || cleanFolio === "0") return [];
  return [{ type, folio: cleanFolio.slice(0, 100), date: null, code: null, reason: null }];
}
