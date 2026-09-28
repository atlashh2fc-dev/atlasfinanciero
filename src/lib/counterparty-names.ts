// Clave de comparación de nombres de empresas para detectar fichas duplicadas.
// Sin dependencias para poder probarse con Node directamente.

const legalSuffixes = new Set(["spa", "ltda", "limitada", "sa", "eirl", "chile"]);

/**
 * "SIPTEL CHILE S.A." y "Siptel" → "siptel"; "PEOPLEWORK SPA" y "People Work"
 * → "peoplework". Quita tildes, puntuación, espacios y sufijos societarios
 * finales (SPA, LTDA, LIMITADA, SA, S.A., EIRL, CHILE). null si queda muy corta.
 */
export function companyNameKey(value: string | null | undefined) {
  const tokens = (value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("es-CL")
    .replace(/\./g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  while (tokens.length > 1 && legalSuffixes.has(tokens.at(-1)!)) tokens.pop();
  const key = tokens.join("");
  return key.length >= 3 ? key : null;
}
