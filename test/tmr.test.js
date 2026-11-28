import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { observeRtk } from "../skills/acp-client/scripts/tmr_rtk.mjs";
import { SessionUsage, summarizeUsage } from "../skills/acp-client/scripts/tmr_usage.mjs";

test("parar o agente encerra pergunta pendente e aciona cancelamento da fase", async (t) => {
  const moduleUrl = new URL("../skills/acp-client/scripts/tmr_web_input.mjs", import.meta.url).href;
  const script = `import * as input from ${JSON.stringify(moduleUrl)};
    input.connect();
    input.setStopPhase(() => input.send({ type: "stopped" }));
    input.confirm("Permitir?", "n").then((value) => input.send({ type: "resolved", value }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => child.kill());
  const messages = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout aguardando cancelamento")), 5000);
    child.on("error", reject);
    child.on("message", (message) => {
      messages.push(message);
      if (message.type === "prompt") child.send({ type: "stop-phase" });
      if (message.type === "resolved") { clearTimeout(timer); resolve(); }
    });
  });
  assert.ok(messages.some(({ type }) => type === "answered"));
  assert.ok(messages.some(({ type }) => type === "stopped"));
  assert.equal(messages.find(({ type }) => type === "resolved").value, false);
});

test("acumula custo por sessão com cache e substitui a estimativa pelo snapshot ACP", () => {
  const model = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
  const turn = { totalTokens: 1_500, inputTokens: 400, outputTokens: 100, cachedReadTokens: 900, cachedWriteTokens: 100, thoughtTokens: 50 };
  const codex = new SessionUsage();
  codex.update({ used: 16_000, size: 200_000 });
  codex.addTurn(turn, model);
  codex.addTurn(turn, model);
  const opencode = new SessionUsage();
  opencode.addTurn(turn, model);
  opencode.update({ cost: { amount: 0.005, currency: "USD" } });
  opencode.update({ cost: { amount: 0.01, currency: "USD" } });
  const missing = new SessionUsage();
  missing.addTurn(turn, {});

  assert.equal(summarizeUsage([codex]).cost, 0.00892);
  assert.equal(summarizeUsage([opencode]).cost, 0.01);
  assert.deepEqual(summarizeUsage([codex, opencode, missing]), {
    tokens: 6_000, cost: 0.01892, costEstimated: true, costPartial: true,
  });
  assert.equal(codex.contextUsed, 16_000);
});

test("registra cada consulta do RTK e preserva a resposta do hook nativo", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sdd-test-rtk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "rtk");
  await writeFile(binary, [
    "#!/bin/sh",
    'case "$2:$3" in',
    '  opencode:--help) echo ajuda ;;',
    '  opencode:"git status") echo \'{"command":"rtk git status"}\' ;;',
    '  opencode:pwd) echo \'{}\' ;;',
    '  opencode:false) echo "erro" >&2; exit 3 ;;',
    '  codex:) cat >/dev/null ;;',
    'esac',
    "",
  ].join("\n"), { mode: 0o700 });
  const previousPath = process.env.PATH;
  const events = [];
  let audit;
  try {
    process.env.PATH = [dir, previousPath].join(path.delimiter);
    audit = observeRtk((event) => events.push(event), assert.fail);
  } finally {
    process.env.PATH = previousPath;
  }
  const hook = (harness, command, input) => spawnSync("rtk", ["hook", harness, ...command], { env: audit.env, encoding: "utf8", input });
  try {
    assert.equal(hook("opencode", ["--help"]).stdout.trim(), "ajuda");
    assert.deepEqual(JSON.parse(hook("opencode", ["git status"]).stdout), { command: "rtk git status" });
    assert.equal(hook("opencode", ["pwd"]).stdout.trim(), "{}");
    assert.equal(hook("opencode", ["false"]).status, 3);
    assert.equal(hook("codex", [], '{"tool_input":{"command":"printf ok"}}').stdout, "");
  } finally {
    audit.close();
  }
  assert.deepEqual(events, [
    { status: "reescrito", command: "git status" },
    { status: "sem reescrita", command: "pwd" },
    { status: "falhou", command: "false" },
    { status: "sem reescrita", command: "printf ok" },
  ]);
});
