#!/usr/bin/env node

/**
 * Contrato estático del workspace CRM.
 *
 * Este verificador no reemplaza un E2E con sesión autenticada. Su objetivo es
 * impedir regresiones estructurales: volver a una página monolítica, perder
 * etapas del pipeline o cortar el enlace Mercado Público -> oportunidad CRM.
 *
 * Ejecutar: node scripts/verify-crm-workspace.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const absolute = (path) => resolve(root, path);
const read = (path) => readFileSync(absolute(path), "utf8");

const componentDirectory = "src/components";
const crmComponentPaths = readdirSync(absolute(componentDirectory))
  .filter((name) => /(?:crm|commercial|customer|public-market|finance-dashboard)/i.test(name))
  .filter((name) => /\.tsx?$/.test(name))
  .map((name) => `${componentDirectory}/${name}`);

assert.ok(
  crmComponentPaths.length > 0,
  "No se encontraron componentes CRM para verificar en src/components.",
);

const components = crmComponentPaths
  .map((path) => `\n/* FILE: ${path} */\n${read(path)}`)
  .join("\n");
const styles = read("src/app/globals.css");
const publicMarket = read("src/components/public-market-crm.tsx");
const commercialApi = read("src/app/api/commercial-control/route.ts");

const failures = [];
function contract(label, verifier) {
  try {
    verifier();
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function has(source, fragment, message) {
  assert.ok(source.includes(fragment), message ?? `Falta \`${fragment}\`.`);
}

function matches(source, expression, message) {
  assert.match(source, expression, message);
}

// 1. Cinco espacios diferenciados y navegables, no cinco bloques apilados.
const expectedViews = [
  { key: "summary", label: "Resumen" },
  { key: "pipeline", label: "Pipeline" },
  { key: "customers", label: "Clientes 360" },
  { key: "contracts", label: "Contratos y proyectos" },
  { key: "evolution", label: "Evolución" },
];

contract("Navegación principal", () => {
  for (const { key, label } of expectedViews) {
    has(components, label, `Falta la vista visible \`${label}\`.`);
    matches(
      components,
      new RegExp(`(?:activeView|workspaceView|view|tab)\\s*===\\s*["']${key}["']`),
      `La vista \`${label}\` no tiene render condicional propio; podría volver el scroll monolítico.`,
    );
  }
  matches(
    components,
    /role=["']tablist["'][\s\S]{0,2500}(?:aria-selected|role=["']tab["'])/,
    "La navegación CRM debe exponer tablist y estado/rol de sus pestañas.",
  );
});

contract("Aislamiento contra scroll eterno", () => {
  const conditionalViews = new Set(
    [...components.matchAll(/(?:activeView|workspaceView|view|tab)\s*===\s*["'](summary|pipeline|customers|contracts|evolution)["']/g)]
      .map((match) => match[1]),
  );
  assert.deepEqual(
    [...conditionalViews].sort(),
    expectedViews.map(({ key }) => key).sort(),
    "Las cinco vistas deben montarse selectivamente, no renderizarse juntas.",
  );
  assert.ok(
    /overflow-x\s*:\s*auto/.test(styles),
    "El tablero horizontal necesita overflow-x:auto para no alargar la página.",
  );
  assert.ok(
    /max-height\s*:|height\s*:\s*(?:min\(|calc\(|clamp\(|[4-9]\dvh)/.test(styles),
    "Falta una altura controlada para listas/tableros con scroll interno.",
  );
});

// 2. Embudo comercial completo y horizontal.
const expectedStages = [
  ["exploration", "Exploración"],
  ["meeting", "Reunión / demo"],
  ["quotation", "Cotización pendiente"],
  ["proposal", "Propuesta enviada"],
  ["pilot", "MVP / inicio"],
  ["negotiation", "Negociación / contrato"],
  ["won", "Cerrada / ejecución"],
  ["lost", "Baja propuesta"],
];

contract("Pipeline de ocho etapas", () => {
  for (const [key, label] of expectedStages) {
    matches(
      components,
      new RegExp(`key\\s*:\\s*["']${key}["'][^}]{0,160}label\\s*:\\s*["']${label}["']`),
      `Falta la etapa \`${label}\` (${key}) en la definición del pipeline.`,
    );
    assert.ok(
      commercialApi.includes(`"${key}"`),
      `La API comercial no acepta la etapa \`${key}\`.`,
    );
  }
  matches(
    components,
    /stages\.map\([\s\S]{0,5000}item\.stage\s*===\s*stage\.key/,
    "El tablero no distribuye oportunidades por las ocho etapas declaradas.",
  );
  matches(
    styles,
    /(?:pipeline|kanban)[^{]*\{[^}]*overflow-x\s*:\s*auto[^}]*\}/s,
    "El pipeline no está implementado como tablero horizontal desplazable.",
  );
});

contract("Pipeline arrastrable con persistencia y alternativa accesible", () => {
  matches(
    components,
    /draggable=\{canManage[\s\S]{0,700}onDragStart=/,
    "Las tarjetas administrables deben ser arrastrables.",
  );
  matches(
    components,
    /onDragOver=[\s\S]{0,800}onDrop=/,
    "Las columnas del Kanban deben aceptar soltar oportunidades.",
  );
  matches(
    components,
    /dropOpportunity[\s\S]{0,1200}changeOpportunityStage/,
    "Soltar una tarjeta debe usar el cambio de etapa persistente existente.",
  );
  matches(
    components,
    /crm-stage-control[\s\S]{0,500}<select[^>]*aria-label=/,
    "El drag and drop debe conservar un selector accesible como alternativa de teclado.",
  );
});

contract("Detalle de oportunidad en modal", () => {
  matches(
    components,
    /selectedOpportunity\s*&&[\s\S]{0,1200}<CommercialModal/,
    "Seleccionar una oportunidad debe abrir un modal de detalle.",
  );
  matches(
    components,
    /function\s+CommercialModal[\s\S]{0,1200}role=["']dialog["']/,
    "CommercialModal debe materializar el detalle como un diálogo accesible.",
  );
  matches(
    components,
    /role=["']dialog["'][^>]*aria-modal=["']true["']/,
    "El modal CRM debe declarar role=dialog y aria-modal=true.",
  );
  matches(
    components,
    /(?:setSelectedOpportunity|openOpportunity|selectOpportunity)/,
    "Las tarjetas del pipeline no exponen una acción para abrir su detalle.",
  );
});

// 3. La evolución debe seguir siendo analítica y acotable.
contract("Filtros de evolución", () => {
  matches(
    components,
    /(?:customerYear|selectedYear|evolutionYear|yearFilter)/,
    "La vista Evolución no conserva un filtro anual explícito.",
  );
  matches(
    components,
    />\s*Año\s*</,
    "El filtro anual no tiene una etiqueta visible `Año`.",
  );
  matches(
    components,
    /(?:activeView|workspaceView|view|tab)\s*===\s*["']evolution["'][\s\S]{0,4500}(?:type=["']search["']|placeholder=["'][^"']*(?:Buscar|cliente)|Buscar cliente)/i,
    "La vista Evolución debe ofrecer su propio buscador/filtro de clientes.",
  );
  matches(
    components,
    /\.filter\([\s\S]{0,900}(?:year|customerYear|selectedYear|evolutionYear)/,
    "El año seleccionado no se aplica a los registros comerciales.",
  );
});

// 4. Mercado Público no puede transformarse en una isla del CRM.
contract("Continuidad Mercado Público -> oportunidad", () => {
  has(publicMarket, 'action: "save_opportunity"', "Mercado Público no invoca save_opportunity.");
  has(publicMarket, "/api/commercial-control", "Mercado Público no usa la API canónica del CRM.");
  matches(
    publicMarket,
    /source:\s*`Mercado Público\s*·\s*\$\{selected\.code\}`/,
    "La oportunidad no conserva el código de Mercado Público en su origen.",
  );
  matches(
    commercialApi,
    /body\?\.action\s*===\s*["']save_opportunity["'][\s\S]{0,4000}(?:commercial_opportunities|opportunities)/,
    "La API no persiste la acción save_opportunity en el pipeline comercial.",
  );
  matches(
    components,
    /selectedTenderCode[\s\S]{0,4500}\/api\/mercado-publico\/intelligence/,
    "El modal del pipeline no consulta el expediente canónico de Mercado Público.",
  );
  for (const label of ["Análisis", "Archivos", "Historial"]) {
    has(components, label, `El modal de oportunidad no expone la pestaña \`${label}\`.`);
  }
  has(components, "document.signedUrl || document.source_url", "Los archivos del expediente no conservan la apertura de copia privada o fuente oficial.");
  has(components, "No hay un adjudicatario publicado ni un proceso histórico suficientemente similar", "El historial vacío debe explicarse sin inventar antecedentes.");
});

// 5. Accesibilidad mínima para teclado/lectores de pantalla.
contract("Accesibilidad básica", () => {
  has(components, 'role="tablist"', "El selector de vistas no declara role=tablist.");
  has(components, 'role="dialog"', "Los detalles/editables no declaran role=dialog.");
  matches(
    components,
    /aria-(?:label|labelledby)=["'][^"']+["']/,
    "La navegación o el modal carecen de nombre accesible.",
  );
  matches(
    components,
    /aria-modal=["']true["']/,
    "Los modales CRM no se identifican como modales para tecnologías de asistencia.",
  );
});

if (failures.length) {
  console.error("\nCRM WORKSPACE CONTRACT: FAIL\n");
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  console.error("\nCorrige estos contratos antes de desplegar el workspace CRM.\n");
  process.exitCode = 1;
} else {
  console.log(
    "CRM WORKSPACE CONTRACT: PASS — navegación, pipeline, detalle, filtros, Mercado Público y accesibilidad verificados.",
  );
}
