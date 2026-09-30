/**
 * Códigos jerárquicos de centros de costo ("8.2.1.0" = grupo 8, subcentro 2,
 * sub-subcentro 1). El grupo es el primer segmento y su centro raíz es el que
 * tiene ceros en el resto ("8.0.0.0"). Quien crea un centro elige de qué
 * centro depende y el código se calcula aquí: nadie tiene que conocer la
 * convención para que el centro quede anidado y no como una línea suelta.
 * Sin dependencias para poder usarse en cliente, servidor y pruebas de Node.
 */

/** Largo usado cuando la organización aún no tiene códigos numéricos. */
export const DEFAULT_COST_CENTER_CODE_LENGTH = 3;

/** Segmentos numéricos iniciales ("3.1.0 LEGALES" → [3, 1, 0]); null si no hay. */
export function costCenterCodeSegments(code: string) {
  const match = /^\s*(\d+(?:\.\d+)*)/.exec(code);
  return match ? match[1].split(".").map(Number) : null;
}

/** Niveles significativos: "8.2.0.0" → 2, "8.0.0.0" → 1, "CASA" → 1, "CASA.2" → 2. */
export function costCenterDepth(code: string) {
  const segments = costCenterCodeSegments(code);
  if (!segments) return code.split(".").filter(Boolean).length || 1;
  let depth = segments.length;
  while (depth > 1 && segments[depth - 1] === 0) depth -= 1;
  return depth;
}

export function costCenterGroupKey(code: string) {
  return code.split(".")[0].trim() || "Otros";
}

/** Largo de código más usado en la organización (Geimser 4, otras 3). */
export function costCenterCodeLength(codes: string[]) {
  const counts = new Map<number, number>();
  for (const code of codes) {
    const segments = costCenterCodeSegments(code);
    if (segments && segments.length > 1) counts.set(segments.length, (counts.get(segments.length) ?? 0) + 1);
  }
  let best = DEFAULT_COST_CENTER_CODE_LENGTH;
  let bestCount = 0;
  for (const [length, count] of counts)
    if (count > bestCount || (count === bestCount && length > best)) {
      best = length;
      bestCount = count;
    }
  return best;
}

function pad(segments: number[], length: number) {
  return [...segments, ...Array(Math.max(0, length - segments.length)).fill(0)].join(".");
}

/** Código del siguiente grupo principal: uno más que el mayor grupo numérico. */
export function nextRootCostCenterCode(codes: string[]) {
  const top = Math.max(0, ...codes.map((code) => costCenterCodeSegments(code)?.[0] ?? 0));
  return pad([top + 1], costCenterCodeLength(codes));
}

/**
 * Código del siguiente subcentro directo de `parentCode`, sin chocar con los
 * existentes: "8.2.0.0" con hijos 8.2.1.0 y 8.2.3.0 → "8.2.4.0".
 */
export function nextChildCostCenterCode(parentCode: string, codes: string[]) {
  const taken = new Set(codes.map((code) => code.trim().toUpperCase()));
  const parent = costCenterCodeSegments(parentCode);
  if (!parent) {
    // Código libre ("CASA"): los hijos cuelgan como CASA.1, CASA.2…
    const base = parentCode.trim().toUpperCase();
    let next = 1;
    while (taken.has(`${base}.${next}`)) next += 1;
    return `${base}.${next}`;
  }
  const depth = costCenterDepth(parentCode);
  const prefix = parent.slice(0, depth);
  const length = Math.max(parent.length, depth + 1, costCenterCodeLength(codes));
  const siblings = codes
    .map((code) => costCenterCodeSegments(code))
    .filter((segments): segments is number[] =>
      Boolean(segments) && prefix.every((value, index) => segments![index] === value) && (segments![depth] ?? 0) > 0,
    )
    .map((segments) => segments[depth]);
  let next = Math.max(0, ...siblings) + 1;
  while (taken.has(pad([...prefix, next], length))) next += 1;
  return pad([...prefix, next], length);
}

/** Nombre del grupo: su centro raíz ("8", "8.0" o "8.0.0.0"), o el primero. */
export function costCenterGroupName<T extends { code: string; name: string }>(key: string, centers: T[]) {
  const root = centers.find((center) => {
    const code = center.code.trim();
    return code === key || (costCenterGroupKey(code) === key && costCenterCodeSegments(code) !== null && costCenterDepth(code) === 1);
  });
  return root?.name ?? (centers.length === 1 ? centers[0].name : `Grupo ${key}`);
}
