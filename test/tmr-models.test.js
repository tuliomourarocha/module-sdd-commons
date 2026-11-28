import test from "node:test";
import assert from "node:assert/strict";
import { mergeAvailableModels, modelDisplayName } from "../skills/acp-client/scripts/tmr_models.mjs";

test("catálogo combina modelos disponíveis sem IDs duplicados", () => {
  const ranked = [{ modelValue: "p/a", label: "Modelo A" }, { modelValue: "p/a", label: "A repetido" }, { modelValue: "p/b", label: "Indisponível" }];
  const available = [{ value: "p/a" }, { value: "p/a" }, { value: "p/c" }, { value: "p/c" }];
  const result = mergeAvailableModels(ranked, available);
  assert.deepEqual(result.map((entry) => entry.modelValue), ["p/a", "p/c"]);
  assert.equal(result[0].label, "Modelo A");
  assert.equal(result[1].input, null);
});

test("exibe o identificador apenas uma vez quando coincide com o nome", () => {
  assert.equal(modelDisplayName({ label: "p/a", modelValue: "p/a" }), "p/a");
  assert.equal(modelDisplayName({ label: "Modelo A", modelValue: "p/a" }), "Modelo A  [p/a]");
});
