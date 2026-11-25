import assert from "node:assert/strict";
import test from "node:test";

import { ROLE_ORDER } from "../bin/lib/model-catalog.js";
import { chooseVariant, rankModels, setFrontmatterModel } from "../bin/lib/model-picker.js";

function entry(id, scores, price, extra = {}) {
  return {
    id,
    modelValue: id,
    provider: id.split("/")[0],
    modelKey: id.replace(/^[^/]+\//, ""),
    label: id,
    general: scores[0],
    coding: scores[1],
    instruction: scores[2],
    speed: scores[3],
    reliability: scores[4] ?? 100,
    input: price[0],
    output: price[1],
    context: 1000000,
    variants: extra.variants ?? ["low", "medium", "high"],
    tags: { free: false, preview: false, legacy: false, console: false, ...extra.tags },
    ...extra,
  };
}

const pool = [
  entry("opencode-go/gpt-6-luna", [82, 80, 96, 96, 100], [0.1, 0.5]),
  entry("opencode-go/glm-5.3-flash", [90, 88, 90, 88, 98], [0.15, 0.5], { variants: ["low", "high", "max"] }),
  entry("opencode-go/claude-haiku-5-5", [88, 90, 90, 92, 100], [0.1, 0.5]),
  entry("opencode-go/gpt-6-sol", [96, 96, 95, 78, 100], [2, 10]),
  entry("opencode-go/kimi-k3.1-pro", [96, 95, 93, 55, 95], [2, 10]),
  entry("opencode-go/mimo-v2.6-flash", [83, 85, 84, 90, 100], [0.14, 0.28], { variants: [] }),
  entry("opencode/big-pickle", [74, 72, 80, 80, 60], [0, 0], {
    tags: { free: true, preview: false, legacy: false, console: false },
  }),
];

const defaults = {
  harness: { model: "opencode-go/gpt-6-luna", variant: "low" },
  planner: { model: "opencode-go/glm-5.3-flash", variant: "high" },
  builder: { model: "opencode-go/claude-haiku-5-5", variant: "medium" },
  reviewer: { model: "opencode-go/claude-haiku-5-5", variant: "high" },
  shipper: { model: "opencode-go/gpt-6-luna", variant: "medium" },
  supervisor: { model: "opencode-go/glm-5.3-flash", variant: "low" },
};

test("recomendação por papel mantém o padrão da squad no topo", () => {
  for (const role of ROLE_ORDER) {
    const ranked = rankModels(pool, "opencode", role, defaults[role]);
    assert.equal(ranked[0].modelValue, defaults[role].model, `${role} deve recomendar ${defaults[role].model}`);
  }
});

test("modelo caro e/ou de cota arriscada não passa na frente do custo-benefício", () => {
  const ranked = rankModels(pool, "opencode", "harness", defaults.harness);
  const expensive = ranked.findIndex((item) => item.modelValue === "opencode-go/gpt-6-sol");
  const free = ranked.findIndex((item) => item.modelValue === "opencode/big-pickle");
  assert.ok(expensive > 0, "gpt-6-sol não deve liderar o harness");
  assert.ok(free > 0, "modelo free com risco de cota não deve liderar o harness");
});

test("variante sugerida respeita o esforço do papel", () => {
  const haiku = pool.find((item) => item.modelValue === "opencode-go/claude-haiku-5-5");
  const glm = pool.find((item) => item.modelValue === "opencode-go/glm-5.3-flash");
  assert.equal(chooseVariant(haiku, "builder", "medium"), "medium");
  assert.equal(chooseVariant(haiku, "reviewer", "high"), "high");
  assert.equal(chooseVariant(glm, "builder", "medium"), "high");
  assert.equal(chooseVariant(glm, "harness", "low"), "low");
  assert.equal(chooseVariant(pool.find((item) => item.modelValue === "opencode-go/mimo-v2.6-flash"), "builder"), null);
});

test("frontmatter do OpenCode grava model + variant sem tocar no corpo", () => {
  const source = [
    "---",
    "description: teste",
    "model: opencode-go/gpt-6-luna",
    "variant: low",
    "steps: 30",
    "---",
    "",
    "Corpo do agente.",
    "",
  ].join("\n");

  const updated = setFrontmatterModel(source, "opencode-go/claude-haiku-5-5", "high");
  assert.match(updated, /^model: opencode-go\/claude-haiku-5-5$/m);
  assert.match(updated, /^variant: high$/m);
  assert.ok(updated.endsWith("Corpo do agente.\n"));

  const withoutVariant = setFrontmatterModel(updated, "opencode-go/mimo-v2.6-flash", null);
  assert.match(withoutVariant, /^model: opencode-go\/mimo-v2\.6-flash$/m);
  assert.doesNotMatch(withoutVariant, /^variant:/m);
  assert.ok(withoutVariant.endsWith("Corpo do agente.\n"));

  const withoutVariantLine = source.replace("variant: low\n", "");
  const inserted = setFrontmatterModel(withoutVariantLine, "opencode-go/glm-5.3-flash", "high");
  assert.match(inserted, /^variant: high\n---/m);
  assert.ok(inserted.endsWith("Corpo do agente.\n"));
});
