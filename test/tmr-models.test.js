import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("cliente Claude aplica --model na criação e retomada e orienta login ACP", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "sdd-claude-acp-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../bin/sdd-acp.js", import.meta.url));
  const adapter = path.join(cwd, "adapter.cjs");
  await writeFile(path.join(cwd, "npx"), '#!/bin/sh\nexec "$SDD_TEST_NODE" "$SDD_TEST_ADAPTER" "$@"\n', { mode: 0o700 });
  await writeFile(adapter, `
    const assert = require("node:assert/strict");
    assert.deepEqual(process.argv.slice(2), ["-y", "@agentclientprotocol/claude-agent-acp"]);
    const model = { id: "model", category: "model", type: "select", currentValue: "sonnet" };
    let current = "sonnet";
    let promptId;
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params, result } = JSON.parse(line);
      if (id === 999 && !method) {
        assert.deepEqual(result, { outcome: { outcome: "selected", optionId: process.env.SDD_EXPECT_PERMISSION } });
        console.log(JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }));
        return;
      }
      if (id == null) return;
      const reply = (data) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...data }));
      if (method === "initialize") {
        assert.equal(params.protocolVersion, 1);
        reply({ result: { protocolVersion: 1 } });
      } else if (method === "session/new" || method === "session/load") {
        if (process.env.SDD_TEST_AUTH_REQUIRED) {
          reply({ error: { code: -32000, message: "Login necessário" } });
          return;
        }
        assert.equal(params.model, undefined);
        assert.equal(params.sessionId, method === "session/load" ? "claude-test" : undefined);
        reply({ result: { sessionId: "claude-test", configOptions: [model] } });
      } else if (method === "session/set_config_option") {
        assert.deepEqual(params, { sessionId: "claude-test", configId: "model", value: "opus" });
        current = params.value;
        reply({ result: { configOptions: [{ ...model, currentValue: current }] } });
      } else if (method === "session/prompt") {
        assert.equal(current, "opus");
        if (process.env.SDD_EXPECT_PERMISSION) {
          promptId = id;
          console.log(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "session/request_permission", params: {
            toolCall: { kind: "execute", title: "Comando" },
            options: [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "reject" }],
          } }));
        } else reply({ result: { stopReason: "end_turn" } });
      } else {
        assert.fail(method);
      }
    });
  `);
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [
    cli, "client", "--agent", "claude", "--cwd", cwd, "--no-ensure", "--model", "opus", "--json", ...args, "Olá",
  ], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, PATH: cwd, SDD_TEST_NODE: process.execPath, SDD_TEST_ADAPTER: adapter, ...extraEnv },
  });
  for (const args of [[], ["--session", "claude-test"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.at(-1), { type: "result", sessionId: "claude-test", stopReason: "end_turn" });
  }
  const unauthenticated = run([], { SDD_TEST_AUTH_REQUIRED: "1" });
  assert.equal(unauthenticated.status, 3);
  assert.match(unauthenticated.stderr, /claude-agent-acp --cli auth login/);
  for (const [args, expected] of [[[], "allow"], [["--permission", "safe"], "reject"]]) {
    const result = run(args, { SDD_EXPECT_PERMISSION: expected });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).stopReason, "end_turn");
  }
});
