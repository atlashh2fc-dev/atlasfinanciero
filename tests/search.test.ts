import assert from "node:assert/strict";
import test from "node:test";

import { matchesSearch, normalizeSearchText } from "../src/lib/search.ts";

test("normaliza tildes y mayúsculas", () => {
  assert.equal(normalizeSearchText("  Comunicación ÑUÑOA "), "comunicacion nunoa");
  assert.ok(matchesSearch("comunicacion", ["Servicios de Comunicación SpA"]));
});

test("encuentra folios con prefijos y separadores", () => {
  const fields = ["Proveedor Uno", "76.123.456-7", "4860", null];
  for (const query of ["4860", "4.860", "N° 4860", "nº 4.860", "F-4860", "folio 4860", "#4860"]) {
    assert.ok(matchesSearch(query, fields), query);
  }
  assert.ok(!matchesSearch("4861", fields));
});

test("encuentra folios numéricos guardados como número", () => {
  assert.ok(matchesSearch("12345", ["Proveedor", 12345]));
});

test("consulta vacía coincide con todo", () => {
  assert.ok(matchesSearch("   ", ["x"]));
});
