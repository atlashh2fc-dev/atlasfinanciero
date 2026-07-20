#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const component = read("src/components/public-market-crm.tsx");
const intelligence = read("src/lib/mercado-publico/intelligence.ts");
const api = read("src/app/api/mercado-publico/intelligence/route.ts");
const cron = read("src/app/api/mercado-publico/radar/route.ts");
const migration = read("supabase/migrations/20260720215122_add_public_market_commercial_intelligence.sql");
const vercel = JSON.parse(read("vercel.json"));

const includes = (source, fragment, label) => assert.ok(source.includes(fragment), label);

includes(cron, "CRON_SECRET", "El robot diario debe exigir un secreto de cron.");
includes(cron, "runDailyRadar", "El endpoint programado no ejecuta el radar comercial.");
assert.deepEqual(vercel.crons, [{ path: "/api/mercado-publico/radar", schedule: "30 11 * * *" }], "El radar debe ejecutarse diariamente durante la mañana en Chile.");

for (const capability of ["Contact Center", "Automatización", "BPO", "Seguridad Integral", "Data Intelligence", "Eficiencia Energética"]) {
  includes(intelligence, capability, `Falta la capacidad GEIMSER ${capability} en el match.`);
}
includes(intelligence, 'tier = score >= 65 ? "green" : score >= 35 ? "yellow" : "red"', "El semáforo comercial no conserva sus umbrales auditables.");
includes(component, "public-market-fit", "La vista no expone el semáforo de afinidad.");
includes(component, "Por qué encaja", "Falta explicar el resultado del match.");
includes(component, "Brechas y riesgos", "Falta explicar las brechas comerciales.");

for (const field of ["contractDuration", "paymentTerms", "guarantees", "fines", "evaluationCriteria", "renewal", "subcontracting"]) {
  includes(intelligence, field, `El resumen ejecutivo no cubre ${field}.`);
}
includes(component, "CONDICIONES CRÍTICAS", "La ficha no muestra condiciones críticas.");
includes(component, "MULTAS Y SANCIONES DETECTADAS", "La ficha no muestra multas detectadas.");

includes(intelligence, "downloadFromAttachmentPage", "No existe descarga de anexos oficiales.");
includes(intelligence, "/attachment/viewattachment.aspx", "No se conserva el acceso a anexos generales protegidos por ChileCompra.");
includes(intelligence, 'attribute("type")?.toLowerCase() !== "hidden"', "El formulario documental no tolera variaciones de orden en atributos HTML.");
includes(intelligence, "readLimited", "La descarga documental no tiene límite de seguridad.");
includes(intelligence, 'storage.from("public-market-documents").upload', "Los anexos no se conservan en almacenamiento privado.");
includes(api, 'body?.action === "capture_tender"', "La API no implementa la captura integral de licitación.");
includes(component, 'action: "capture_tender"', "El pipeline no dispara la preparación del expediente.");
includes(component, "captureExistingOpportunity", "Las oportunidades antiguas no pueden completar su expediente sin duplicarse.");
includes(intelligence, "captureTenderDossier", "La captura no está centralizada para altas nuevas y backfill.");
includes(cron, 'body?.action !== "backfill_pipeline"', "No existe backfill protegido para oportunidades históricas del pipeline.");
includes(cron, '.ilike("source", "Mercado Público%")', "El backfill no descubre oportunidades históricas de Mercado Público.");
includes(cron, "requestedCodes", "El backfill no permite reintentar una licitación específica sin reprocesar todo el pipeline.");
includes(intelligence, "response.status !== 429", "La conexión oficial no reintenta límites temporales de ChileCompra.");
includes(intelligence, '.in("download_status", ["failed", "source_only"])', "La descarga no limpia marcadores fallidos antiguos al recuperarse.");

includes(intelligence, "probable_predecessor", "No existe búsqueda de procesos predecesores comparables.");
includes(component, "Predecesor probable", "La inferencia histórica no está claramente rotulada.");
includes(intelligence, "similarity >= 45", "La inferencia histórica no tiene un umbral explícito.");

for (const table of ["public_market_radar_settings", "public_market_radar_runs", "public_market_tenders", "public_market_documents", "public_market_award_history"]) {
  includes(migration, `create table public.${table}`, `Falta la tabla ${table}.`);
  includes(migration, `alter table public.${table} enable row level security`, `Falta RLS en ${table}.`);
}
includes(migration, "members read public market document objects", "Los documentos privados no tienen una política de lectura por organización.");

console.log("✓ Radar diario, match GEIMSER, expediente, resumen, historia y RLS verificados.");
