// RUT chileno: una sola forma canónica para escribir ("12345678-K", sin puntos)
// y una clave de comparación idéntica a la columna generada
// counterparties.normalized_tax_id de la base de datos.
// Sin dependencias para poder usarse en cliente, servidor y pruebas de Node.

export type Rut = { body: string; dv: string; formatted: string };

/** Dígito verificador (módulo 11) para un cuerpo numérico. */
export function rutCheckDigit(body: string) {
  let total = 0;
  let factor = 2;
  for (const digit of [...body].reverse()) {
    total += Number(digit) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const expected = 11 - (total % 11);
  return expected === 11 ? "0" : expected === 10 ? "K" : String(expected);
}

/** Valida y descompone un RUT; null si el formato o el dígito verificador no calzan. */
export function parseRut(value: string | null | undefined): Rut | null {
  const clean = (value ?? "").replace(/[^0-9kK]/g, "").toUpperCase();
  if (clean.length < 2) return null;
  const body = clean.slice(0, -1).replace(/^0+/, "");
  const dv = clean.at(-1)!;
  if (!/^\d{7,8}$/.test(body) || !/^[0-9K]$/.test(dv)) return null;
  return rutCheckDigit(body) === dv ? { body, dv, formatted: `${body}-${dv}` } : null;
}

/** "12.345.678-k" → "12345678-K"; null si no es un RUT válido. */
export function formatRut(value: string | null | undefined) {
  return parseRut(value)?.formatted ?? null;
}

/**
 * Valor a persistir en columnas tax_id: la forma canónica si el RUT es válido;
 * si no, el texto original recortado (nunca se descarta lo que ingresó la
 * persona ni lo que informó el SII). null cuando viene vacío.
 */
export function canonicalTaxId(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return formatRut(trimmed) ?? trimmed;
}

/**
 * Clave de comparación. Replica exactamente
 * NULLIF(upper(regexp_replace(tax_id, '[^0-9kK]', '', 'g')), '')
 * para consultar counterparties.normalized_tax_id.
 */
export function rutKey(value: string | null | undefined) {
  const key = (value ?? "").replace(/[^0-9kK]/g, "").toUpperCase();
  return key || null;
}

/** Igualdad de RUT ignorando puntos, guiones, mayúsculas y ceros a la izquierda. */
export function sameRut(first: string | null | undefined, second: string | null | undefined) {
  const a = rutKey(first)?.replace(/^0+/, "");
  const b = rutKey(second)?.replace(/^0+/, "");
  return Boolean(a) && a === b;
}
