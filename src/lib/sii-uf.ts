const monthKeys = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export type SiiUfQuote = {
  date: string;
  value: number;
  source: "SII";
  sourceUrl: string;
};

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseSiiNumber(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Obtiene la UF diaria desde la tabla oficial del SII para la fecha indicada. */
export async function getSiiUfQuote(date: string): Promise<SiiUfQuote> {
  if (!isIsoDate(date)) throw new Error("invalid_uf_date");
  const year = Number(date.slice(0, 4));
  const monthIndex = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  if (year < 1990 || monthIndex < 0 || monthIndex > 11) throw new Error("unsupported_uf_date");

  const sourceUrl = `https://www.sii.cl/valores_y_fechas/uf/uf${year}.htm`;
  const response = await fetch(sourceUrl, {
    headers: { Accept: "text/html" },
    next: { revalidate: 86_400 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("sii_uf_unavailable");

  const html = await response.text();
  const sectionExpression = new RegExp(`<div[^>]*\\bid=["']mes_${monthKeys[monthIndex]}["'][^>]*>`, "i");
  const sectionMatch = sectionExpression.exec(html);
  if (!sectionMatch || sectionMatch.index === undefined) throw new Error("sii_uf_date_unavailable");

  const contentAfterSection = html.slice(sectionMatch.index + sectionMatch[0].length);
  const nextSection = contentAfterSection.search(/<div[^>]*\bclass=["']meses["'][^>]*>/i);
  const monthHtml = nextSection < 0 ? contentAfterSection : contentAfterSection.slice(0, nextSection);
  const dayValueExpression = /<th[^>]*>\s*<strong>\s*(\d{1,2})\s*<\/strong>\s*<\/th>\s*<td[^>]*>\s*([^<]*)\s*<\/td>/gi;

  for (const match of monthHtml.matchAll(dayValueExpression)) {
    if (Number(match[1]) !== day) continue;
    const value = parseSiiNumber(match[2]);
    if (value !== null) return { date, value, source: "SII", sourceUrl };
  }

  throw new Error("sii_uf_date_unavailable");
}
