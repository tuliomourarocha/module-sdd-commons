import test from "node:test";
import assert from "node:assert/strict";
import { mergeAvailableModels, modelDisplayName, sessionModels } from "../skills/acp-client/scripts/tmr_models.mjs";

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
  assert.equal(modelDisplayName({ label: "a", modelValue: "p/a" }), "p/a");
});

test("consolida opções agrupadas e o catálogo legado da mesma sessão ACP", () => {
  const { available, current } = sessionModels({
    configOptions: [{ category: "model", type: "select", currentValue: "p/a",
      options: [{ group: "P", options: [{ value: "p/a", name: "Modelo A" }, { value: "p/a" }] }] }],
    models: { availableModels: [{ modelId: "p/a" }, { modelId: "q/a", name: "Modelo A" }] },
  });
  assert.equal(current, "p/a");
  assert.deepEqual(available, [{ value: "p/a", name: "Modelo A" }, { value: "q/a", name: "Modelo A" }]);
});
