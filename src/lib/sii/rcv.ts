// Registro de Compras y Ventas (RCV) del SII: fuente oficial de todos los DTE
// emitidos y recibidos del contribuyente. El SII no publica este servicio como
// API documentada: son los endpoints JSON que usa su propia interfaz web
// (consdcvinternetui), autenticados con el mismo token semilla/firma del
// certificado digital que ya usa el WS de Registro de Aceptación o Reclamo.
// Por eso el parseo es tolerante y cada fila cruda se conserva como payload.
import { getSiiToken, parseRut } from "@/lib/sii/dte";

export type RcvOperation = "COMPRA" | "VENTA";

export type RcvEntry = {
  documentType: number;
  folio: number;
  counterpartTaxId: string;
  counterpartName: string | null;
  issueDate: string | null;
  receptionDate: string | null;
  acknowledgmentDate: string | null;
  receptorEvent: string | null;
  exemptAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  otherTaxesAmount: number | null;
  totalAmount: number | null;
  raw: Record<string, unknown>;
};

const RCV_BASE = "https://www4.sii.cl/consdcvinternetui/services/data/facadeService";
const NAMESPACE_PREFIX = "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService";

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const candidate = text(value)?.replace(/\./g, "").replace(",", ".");
  if (!candidate) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

// El SII entrega fechas como "dd/mm/yyyy" o "dd/mm/yyyy hh:mm:ss".
function siiDate(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const match = candidate.match(/^(\d{2})[/-](\d{2})[/-](\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return /^\d{4}-\d{2}-\d{2}/.test(candidate) ? candidate.slice(0, 10) : null;
  const [, day, month, year, hour, minute, second] = match;
  if (!hour) return `${year}-${month}-${day}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}-04:00`;
}

function pick(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return undefined;
}

// Recorre la respuesta completa buscando filas con la forma esperada, sin
// depender de la ruta exacta dentro del JSON (el SII la ha cambiado antes).
function collectRows(value: unknown, matcher: (row: Record<string, unknown>) => boolean, found: Record<string, unknown>[] = [], seen = new Set<unknown>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRows(item, matcher, found, seen);
    return found;
  }
  const row = value as Record<string, unknown>;
  if (matcher(row)) {
    found.push(row);
    return found;
  }
  for (const child of Object.values(row)) collectRows(child, matcher, found, seen);
  return found;
}

async function postRcv(method: string, token: string, data: Record<string, unknown>) {
  const body = {
    metaData: {
      namespace: `${NAMESPACE_PREFIX}/${method}`,
      conversationId: token,
      transactionId: "0",
      page: null,
    },
    data,
  };
  let response: Response;
  try {
    response = await fetch(`${RCV_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: "https://www4.sii.cl/consdcvinternetui/",
        Cookie: `TOKEN=${token}; NETSCAPE_LIVEWIRE.locexp=${token}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("sii_rcv_timeout");
    throw new Error("sii_rcv_unavailable");
  }
  const raw = await response.text();
  return { status: response.status, raw };
}

function parseRcvResponse(status: number, raw: string) {
  // El SII incluye la descripción del problema en el cuerpo incluso con
  // HTTP 500 (por ejemplo, campos no reconocidos por Jackson). Ese detalle se
  // propaga para diagnóstico en la bitácora de sincronizaciones.
  if (status < 200 || status >= 300) {
    const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 220);
    throw new Error(`sii_rcv_http_${status}${snippet ? `:${snippet}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`sii_rcv_invalid_response:${raw.replace(/\s+/g, " ").trim().slice(0, 220)}`);
  }
  const payload = parsed as { metaData?: { errors?: unknown }; data?: unknown } | null;
  const errors = payload?.metaData?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors.map((item) => (typeof item === "object" && item ? Object.values(item).map(String).join(" ") : String(item))).join("; ");
    throw new Error(`sii_rcv_error:${detail.slice(0, 300)}`);
  }
  return parsed;
}

// El contrato exacto del payload ha cambiado con los años (busquedaInicial,
// campos recaptcha). Se intentan variantes conocidas en orden y se conserva el
// último error con el detalle textual del SII.
async function callRcv(method: string, token: string, data: Record<string, unknown>) {
  const variants: Record<string, unknown>[] = [
    data,
    { ...data, busquedaInicial: true },
    { ...data, accionRecaptcha: "RCV_DETC", tokenRecaptcha: "c3" },
    { ...data, busquedaInicial: true, accionRecaptcha: "RCV_DETC", tokenRecaptcha: "c3" },
  ];
  let lastError: Error | null = null;
  for (const variant of variants) {
    const { status, raw } = await postRcv(method, token, variant);
    try {
      return parseRcvResponse(status, raw);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("sii_rcv_unavailable");
      // Sólo reintentar con otra variante ante errores que sugieren contrato
      // de payload (500/400); un 401/403 es de autenticación y no se resuelve
      // cambiando campos.
      if (!/^sii_rcv_(http_(400|500)|error:)/.test(lastError.message)) throw lastError;
    }
  }
  throw lastError ?? new Error("sii_rcv_unavailable");
}

function summaryDocumentTypes(response: unknown): number[] {
  const rows = collectRows(response, (row) => pick(row, "rsmnTipoDocInteger", "rsmnTipoDoc", "tipoDoc") !== undefined && pick(row, "rsmnTotDoc", "totDoc", "totalDocumentos") !== undefined);
  const types = new Set<number>();
  for (const row of rows) {
    const type = numeric(pick(row, "rsmnTipoDocInteger", "rsmnTipoDoc", "tipoDoc"));
    const total = numeric(pick(row, "rsmnTotDoc", "totDoc", "totalDocumentos"));
    if (type && type >= 1 && type <= 999 && total && total > 0) types.add(Math.trunc(type));
  }
  return [...types];
}

function detailEntries(response: unknown): RcvEntry[] {
  const rows = collectRows(response, (row) => pick(row, "detNroDoc", "detFolioDoc") !== undefined && pick(row, "detRutDoc", "detRutEmisor") !== undefined);
  const entries: RcvEntry[] = [];
  for (const row of rows) {
    const folio = numeric(pick(row, "detNroDoc", "detFolioDoc"));
    const documentType = numeric(pick(row, "detTipoDoc", "dcvTipoDoc", "tipoDoc"));
    const rutBody = text(pick(row, "detRutDoc", "detRutEmisor"));
    const rutVerifier = text(pick(row, "detDvDoc", "detDvEmisor"));
    if (!folio || folio <= 0 || !documentType || !rutBody) continue;
    const parsedRut = parseRut(`${rutBody}-${rutVerifier ?? ""}`);
    entries.push({
      documentType: Math.trunc(documentType),
      folio: Math.trunc(folio),
      counterpartTaxId: parsedRut?.formatted ?? `${rutBody.replace(/\D/g, "")}-${(rutVerifier ?? "").toUpperCase()}`,
      counterpartName: text(pick(row, "detRznSoc", "detRznSocEmisor", "razonSocial")),
      issueDate: siiDate(pick(row, "detFchDoc", "fechaEmision"))?.slice(0, 10) ?? null,
      receptionDate: siiDate(pick(row, "detFecRecepcion", "fechaRecepcion")),
      acknowledgmentDate: siiDate(pick(row, "detFecAcuse", "fechaAcuse")),
      receptorEvent: text(pick(row, "detEventoReceptorLeyenda", "detEventoReceptor")),
      exemptAmount: numeric(pick(row, "detMntExe", "montoExento")),
      netAmount: numeric(pick(row, "detMntNeto", "montoNeto")),
      vatAmount: numeric(pick(row, "detMntIVA", "montoIva")),
      otherTaxesAmount: numeric(pick(row, "detMntTotalOtrosImp", "detMntImp", "otrosImpuestos")),
      totalAmount: numeric(pick(row, "detMntTotal", "montoTotal")),
      raw: row,
    });
  }
  return entries;
}

// Descarga el registro completo de un período: primero el resumen por tipo de
// documento y luego el detalle de cada tipo con documentos.
export async function fetchRcvPeriod(taxpayerRut: string, period: string, operation: RcvOperation, sharedToken?: string) {
  const rut = parseRut(taxpayerRut);
  if (!rut) throw new Error("sii_rcv_invalid_rut");
  if (!/^\d{6}$/.test(period)) throw new Error("sii_rcv_invalid_period");
  // El RCV sólo existe en el ambiente real del SII.
  const token = sharedToken ?? await getSiiToken("production");
  const baseData = {
    rutEmisor: rut.body,
    dvEmisor: rut.dv,
    ptributario: period,
    estadoContab: "REGISTRO",
    operacion: operation,
  };
  const summary = await callRcv("getResumen", token, baseData);
  const documentTypes = summaryDocumentTypes(summary);
  const detailMethod = operation === "COMPRA" ? "getDetalleCompra" : "getDetalleVenta";
  const entries: RcvEntry[] = [];
  for (const documentType of documentTypes) {
    const detail = await callRcv(detailMethod, token, { ...baseData, codTipoDoc: String(documentType) });
    for (const entry of detailEntries(detail)) {
      // El detalle por tipo puede omitir el tipo en cada fila: usa el consultado.
      entries.push(entry.documentType >= 1 ? entry : { ...entry, documentType });
    }
  }
  const deduplicated = new Map<string, RcvEntry>();
  for (const entry of entries) deduplicated.set(`${entry.counterpartTaxId}|${entry.documentType}|${entry.folio}`, entry);
  return { token, entries: [...deduplicated.values()], documentTypes };
}
