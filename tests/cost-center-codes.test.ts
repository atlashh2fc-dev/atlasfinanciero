import assert from "node:assert/strict";
import test from "node:test";

import {
  costCenterDepth,
  costCenterGroupName,
  nextChildCostCenterCode,
  nextRootCostCenterCode,
} from "../src/lib/cost-center-codes.ts";

const geimser = ["1.0.0.0", "1.1.0.0", "8.0.0.0", "8.2.0.0", "8.2.1.0", "8.2.1.1", "8.2.3.0", "8.10.0.0"];

test("mide la profundidad significativa del código", () => {
  assert.equal(costCenterDepth("8.0.0.0"), 1);
  assert.equal(costCenterDepth("8.2.0.0"), 2);
  assert.equal(costCenterDepth("8.2.1.1"), 4);
  assert.equal(costCenterDepth("3.1.0 LEGALES"), 2);
  assert.equal(costCenterDepth("CASA"), 1);
});

test("un grupo nuevo toma el siguiente número con el largo de la organización", () => {
  assert.equal(nextRootCostCenterCode(geimser), "9.0.0.0");
  assert.equal(nextRootCostCenterCode(["1.0.0", "1.1.0"]), "2.0.0");
  assert.equal(nextRootCostCenterCode([]), "1.0.0");
  assert.equal(nextRootCostCenterCode(["CASA", "HIJOS"]), "1.0.0");
});

test("un subcentro cuelga del centro elegido sin chocar con sus hermanos", () => {
  assert.equal(nextChildCostCenterCode("8.0.0.0", geimser), "8.11.0.0");
  assert.equal(nextChildCostCenterCode("8.2.0.0", geimser), "8.2.4.0");
  assert.equal(nextChildCostCenterCode("8.2.1.0", geimser), "8.2.1.2");
  assert.equal(nextChildCostCenterCode("1.0.0", ["1.0.0"]), "1.1.0");
  assert.equal(nextChildCostCenterCode("8.2.1.1", geimser), "8.2.1.1.1");
  assert.equal(nextChildCostCenterCode("CASA", ["CASA", "CASA.1"]), "CASA.2");
});

test("el grupo se nombra con su centro raíz", () => {
  assert.equal(costCenterGroupName("8", [{ code: "8.0.0.0", name: "Operaciones" }, { code: "8.2.0.0", name: "Link" }]), "Operaciones");
  assert.equal(costCenterGroupName("1", [{ code: "1.0.0", name: "Casa" }]), "Casa");
  assert.equal(costCenterGroupName("3", [{ code: "3.1.0 LEGALES", name: "Legales" }, { code: "3.1.1", name: "Laboral" }]), "Grupo 3");
  assert.equal(costCenterGroupName("HIJOS", [{ code: "HIJOS", name: "Bay" }]), "Bay");
});
