// Búsqueda de texto para listados cargados en memoria: ignora mayúsculas y
// tildes, y permite encontrar folios escritos como "N° 4.860", "F-4860" o
// "4860" aunque el documento guarde solo "4860".

export function normalizeSearchText(value: string | number | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es-CL")
    .trim();
}

// Quita prefijos habituales de folio ("n°", "nº", "no.", "#", "f-", "folio")
// y separadores de miles para comparar solo los dígitos.
function folioDigits(query: string) {
  const stripped = query
    .replace(/\b(folio|factura|fact|nro|num|no)\b\.?/g, "")
    .replace(/[\s.\-_#°º/]/g, "")
    .replace(/^[a-z]{1,2}(?=\d)/, "");
  return /^\d+$/.test(stripped) ? stripped : "";
}

export function matchesSearch(
  query: string,
  fields: Array<string | number | null | undefined>,
) {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  const haystack = normalizeSearchText(fields.filter((v) => v != null).join(" "));
  if (haystack.includes(needle)) return true;
  const digits = folioDigits(needle);
  return digits.length > 0 && haystack.replace(/\./g, "").includes(digits);
}
