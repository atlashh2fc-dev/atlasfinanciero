import assert from "node:assert/strict";
import test from "node:test";

import { companyNameKey } from "../src/lib/counterparty-names.ts";
import { canonicalTaxId, formatRut, parseRut, rutCheckDigit, rutKey, sameRut } from "../src/lib/rut.ts";
import { parseDteReferences, purchaseOrderReference, rcvReference, referenceType } from "../src/lib/sii/dte-references.ts";

test("formatea RUT válidos en forma canónica", () => {
  assert.equal(formatRut("76.859.313-2"), "76859313-2");
  assert.equal(formatRut("80313300k"), "80313300-K");
  assert.equal(formatRut(" 70.856.400-1 "), "70856400-1");
  assert.equal(formatRut("060908000-0"), "60908000-0");
  assert.equal(formatRut("7.107.889-3"), null);
  assert.deepEqual(parseRut("99.593.200-8"), { body: "99593200", dv: "8", formatted: "99593200-8" });
});

test("rechaza dígito verificador incorrecto o cuerpos inválidos", () => {
  assert.equal(formatRut("76859313-3"), null);
  assert.equal(formatRut("11111111"), null);
  assert.equal(formatRut("123"), null);
  assert.equal(formatRut(""), null);
  assert.equal(formatRut(null), null);
  assert.equal(rutCheckDigit("80313300"), "K");
  assert.equal(rutCheckDigit("60908000"), "0");
});

test("canonicalTaxId conserva el texto original cuando no es un RUT válido", () => {
  assert.equal(canonicalTaxId("77.737.445-1"), "77737445-1");
  assert.equal(canonicalTaxId(" 11111111 "), "11111111");
  assert.equal(canonicalTaxId("   "), null);
  assert.equal(canonicalTaxId(undefined), null);
});

test("rutKey replica counterparties.normalized_tax_id", () => {
  assert.equal(rutKey("76.076.626-7"), "760766267");
  assert.equal(rutKey("80313300k"), "80313300K");
  assert.equal(rutKey("sin rut"), null);
  assert.ok(sameRut("77.615.116-5", "776151165"));
  assert.ok(sameRut("076076626-7", "76076626-7"));
  assert.ok(!sameRut("76076626-7", "76859313-2"));
  assert.ok(!sameRut(null, null));
});

test("clave de nombre agrupa variantes de la misma empresa", () => {
  assert.equal(companyNameKey("SIPTEL CHILE SA"), "siptel");
  assert.equal(companyNameKey("Siptel"), "siptel");
  assert.equal(companyNameKey("PEOPLEWORK SPA"), "peoplework");
  assert.equal(companyNameKey("People Work"), "peoplework");
  assert.equal(companyNameKey("Natura Cosméticos S.A."), "naturacosmeticos");
  assert.equal(companyNameKey("NATURA COSMETICOS SA"), "naturacosmeticos");
  assert.equal(companyNameKey("Constructora Ltda."), "constructora");
  assert.equal(companyNameKey("Servicios E.I.R.L."), "servicios");
  assert.equal(companyNameKey("SA"), null);
});

test("referencias DTE: todas se conservan y la OC sólo sale del tipo 801", () => {
  const references = parseDteReferences([
    { NroLinRef: "1", TpoDocRef: "33", FolioRef: "3654", FchRef: "2026-08-01", CodRef: "1", RazonRef: "ANULA FACTURA" },
    { NroLinRef: "2", TpoDocRef: "801", FolioRef: "4500123", FchRef: "2026-07-30" },
    { NroLinRef: "3", TpoDocRef: "HES", FolioRef: "1000234" },
    { NroLinRef: "4", TpoDocRef: "52", FolioRef: "" },
  ]);
  assert.deepEqual(references, [
    { type: 33, folio: "3654", date: "2026-08-01", code: 1, reason: "ANULA FACTURA" },
    { type: 801, folio: "4500123", date: "2026-07-30", code: null, reason: null },
    { type: null, folio: "1000234", date: null, code: null, reason: null },
  ]);
  assert.equal(purchaseOrderReference(references), "4500123");
});

test("una factura que sólo cita una guía no tiene OC", () => {
  const references = parseDteReferences({ TpoDocRef: "52", FolioRef: "8812", FchRef: "2026-09-01" });
  assert.deepEqual(references, [{ type: 52, folio: "8812", date: "2026-09-01", code: null, reason: null }]);
  assert.equal(purchaseOrderReference(references), null);
  assert.deepEqual(parseDteReferences(undefined), []);
});

test("tipo de referencia textual OC equivale a 801", () => {
  assert.equal(referenceType("OC"), 801);
  assert.equal(referenceType("o.c."), 801);
  assert.equal(referenceType("Orden de compra"), 801);
  assert.equal(referenceType(" 801 "), 801);
  assert.equal(referenceType("SET"), null);
  assert.equal(purchaseOrderReference(parseDteReferences({ TpoDocRef: "OC", FolioRef: "OC-77" })), "OC-77");
});

test("referencia informada por el RCV", () => {
  assert.deepEqual(rcvReference(33, "138"), [{ type: 33, folio: "138", date: null, code: null, reason: null }]);
  assert.deepEqual(rcvReference(null, null), []);
  assert.deepEqual(rcvReference(33, "0"), []);
});
