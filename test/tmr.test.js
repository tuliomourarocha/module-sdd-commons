import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { observeRtk } from "../skills/acp-client/scripts/tmr_rtk.mjs";
import { observeMcp } from "../skills/acp-client/scripts/tmr_mcp.mjs";
import { SessionUsage, summarizeUsage } from "../skills/acp-client/scripts/tmr_usage.mjs";
import { applyReviewPrompts, approvedSkillsPrompt, availableApprovedSkills, buildReviewHtml } from "../skills/acp-client/scripts/tmr_review.mjs";

test("confirma o MCP quando recebe a lista de ferramentas da sessão", { timeout: 5000 }, async (t) => {
  const statuses = [];
  const server = observeMcp({ name: "codegraph", command: process.execPath, args: ["-e", `
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const {id, method} = JSON.parse(line);
      if (id != null) console.log(JSON.stringify({jsonrpc: '2.0', id, result:
        method === 'tools/list' ? {tools: [{name: 'codegraph_explore'}]} : {}}));
    });
  `], env: [] }, (status) => statuses.push(status));
  t.after(() => server.close());
  const child = spawn(server.server.command, server.server.args, { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const request = async (id, method) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`);
    const response = JSON.parse((await responses.next()).value);
    server.update();
    assert.equal(response.id, id);
    return response;
  };
  await request(1, "initialize");
  assert.deepEqual(statuses, ["connecting"]);
  const reply = await request("tools", "tools/list");
  assert.equal(reply.result.tools[0].name, "codegraph_explore");
  assert.deepEqual(statuses, ["connecting", "connected"]);
  child.stdin.end();
});

test("mantém explícito que a sessão terminou sem confirmar o MCP", () => {
  const statuses = [];
  const server = observeMcp({ command: "codegraph", args: [] }, (status) => statuses.push(status));
  server.close();
  assert.deepEqual(statuses, ["connecting", "unconfirmed"]);
});

test("registra falha quando o processo do MCP não inicia", { timeout: 5000 }, async () => {
  const statuses = [];
  const server = observeMcp({ command: path.join(tmpdir(), "sdd-mcp-bin-inexistente"), args: [] }, (status) => statuses.push(status));
  try {
    const child = spawn(server.server.command, server.server.args, { stdio: ["pipe", "ignore", "inherit"] });
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
  } finally {
    server.close();
  }
  assert.deepEqual(statuses, ["connecting", "failed"]);
});

test("só anuncia skills aprovadas com SKILL.md disponível para a fase", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "sdd-test-skills-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const common = ".agents/skills/example/SKILL.md";
  const legacy = ".opencode/skills/legacy/SKILL.md";
  for (const file of [common, legacy]) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), "---\nname: example\n---\n");
  }
  const approved = ["example", "legacy", "missing"].map((slug) => ({ id: `owner/repo/${slug}`, slug }));
  const opencode = await availableApprovedSkills(approved, cwd, "opencode");
  assert.deepEqual(opencode.map(({ file }) => file), [common, legacy]);
  const codex = await availableApprovedSkills(approved, cwd, "codex");
  assert.deepEqual(codex.map(({ file }) => file), [common]);
  assert.match(approvedSkillsPrompt(codex), /owner\/repo\/example · \.agents\/skills\/example\/SKILL\.md/);
  assert.doesNotMatch(approvedSkillsPrompt(codex), /legacy|missing/);
  await rm(path.join(cwd, common));
  assert.equal(approvedSkillsPrompt(await availableApprovedSkills(approved, cwd, "codex")), "");
});

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

test("soma turnos posteriores sem repetir o custo incluído em snapshots", () => {
  const planner = new SessionUsage();
  planner.update({ cost: { amount: 0.04, currency: "USD" } });
  const builder = new SessionUsage();
  const model = { input: 2, output: 8 };
  const turn = { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 };
  builder.update({ cost: { amount: 0.006, currency: "USD" } });
  builder.addTurn(turn, model, { reportVersion: 0 });
  builder.addTurn(turn, model, { reportVersion: 1 });
  builder.addTurn(null, model, { reportVersion: 1 });

  const restored = JSON.parse(JSON.stringify([planner, builder]));
  const total = summarizeUsage(restored);
  assert.equal(total.tokens, 3_000);
  assert.ok(Math.abs(total.cost - 0.052) < 1e-12);
  assert.equal(total.costEstimated, true);
  assert.equal(total.costPartial, true);

  builder.update({ cost: { amount: 0.013, currency: "USD" } });
  assert.deepEqual(summarizeUsage([builder]), { tokens: 3_000, cost: 0.013, costEstimated: false, costPartial: false });
});

test("preserva o texto final do Lavish e considera a última decisão enviada para cada skill", () => {
  const suggestions = { local: [], remote: [{ name: "<script>React</script>", url: "https://skills.sh/org/repo/react" }] };
  const state = { notes: [], decisions: new Map() };
  applyReviewPrompts(state, [
    { tag: "tmr-plan-review", prompt: '{"decisions":[["skill-0","aprovar"],["skill-1","aprovar"]],"feedback":"Usar React"}' },
    { tag: "tmr-plan-review", prompt: '{"decisions":[["skill-0","rejeitar"]]}' },
    { tag: "annotation", text: "Trecho selecionado", prompt: "Cobrir também a navegação por teclado." },
  ], suggestions);
  assert.deepEqual([...state.decisions], [[0, "rejeitar"]]);
  assert.deepEqual(state.notes, ["Usar React", "Cobrir também a navegação por teclado."]);
  const html = buildReviewHtml("Plano", "<img src=x>", suggestions);
  assert.ok(html.includes("&lt;img src=x&gt;"));
  assert.ok(html.includes("&lt;script&gt;React&lt;/script&gt;"));
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
    '  claude:) cat >/dev/null; echo \'{"hookSpecificOutput":{"updatedInput":{"command":"rtk git log"}}}\' ;;',
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
    assert.deepEqual(JSON.parse(hook("claude", [], '{"tool_input":{"command":"git log"}}').stdout), {
      hookSpecificOutput: { updatedInput: { command: "rtk git log" } },
    });
  } finally {
    audit.close();
  }
  assert.deepEqual(events, [
    { status: "reescrito", command: "git status" },
    { status: "sem reescrita", command: "pwd" },
    { status: "falhou", command: "false" },
    { status: "sem reescrita", command: "printf ok" },
    { status: "reescrito", command: "git log" },
  ]);
});
