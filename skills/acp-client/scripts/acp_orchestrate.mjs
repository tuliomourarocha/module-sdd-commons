#!/usr/bin/env node
/**
 * acp_orchestrate.mjs — Orquestrador interativo da squad sobre ACP.
 *
 * Substitui o agente `harness` interno quando a squad roda via ACP: o fluxo
 * planner → builder → reviewer é executado por um harness externo (OpenCode ou
 * Codex) controlado por este client, com as decisões humanas NO INÍCIO:
 *
 *   1. Escolha do harness (opencode | codex)
 *   2. Limpar .planning/ (STATE.md, HANDOFF.md, specs) para começar do zero?
 *   3. Link da issue do GitHub com a tarefa (gh issue view → vira o input;
 *      sem gh → cola o texto manualmente)
 *   4. Por agente (planner/builder/reviewer): lista de modelos com custos e o
 *      RECOMENDADO para aquele papel (reusa bin/lib/model-picker.js — os mesmos
 *      pesos por papel e catálogo de preços da squad)
 *   5. Execução das fases via ACP com métricas REAIS do agente:
 *      tokens (usage do response do session/prompt) e custo em USD
 *      (notification usage_update) por agente; quadros de skills chamadas
 *      (⟐ skill ✓), hooks (⟐ hook ✓) e comandos invocados (rtk, codegraph
 *      destacados); com --ui lavish tudo isso vive no console HTML no browser.
 *
 * Uso:
 *   node skills/acp-client/scripts/acp_orchestrate.mjs [--cwd <repo>] \
 *        [--agent opencode|codex] [--model <provider/model>] [--ui lavish]
 *
 * Requer TTY (wizard interativo). Run simples de UMA subtask continua no
 * acp_client.mjs (usado pelos macros builder/planner internos).
 */
import { spawn, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { Rpc, handleNotification, LavishUi } from "./acp_client.mjs";
import { ensureDeps } from "./ensure_deps.mjs";
import { loadModelPools, rankModels, chooseVariant, loadDefaults } from "../../../bin/lib/model-picker.js";
import * as ui from "./tmr_ui.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// scripts → acp-client → skills → raiz do pacote/repo
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "../../..");

const AGENT_PRESETS = {
  opencode: { command: "opencode", args: ["acp"], authHint: "opencode auth login", platform: "opencode" },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    authHint: "codex login",
    platform: "codex",
  },
};

const ROLES = ["planner", "builder", "reviewer"];

const fail = (msg, code = 1) => { console.error(`acp_orchestrate: ${msg}`); process.exit(code); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const mapStr = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(", ") || "—";

// ------------------------------------------------------------------- wizard IO
let rl = null;
// Prompts SEM ANSI — o readline calcula a posição do cursor pelo comprimento
// visível; códigos de cor no prompt fazem o texto digitado ficar invisível.
const ask = (q, def = "") => new Promise((res) => {
  rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => res(String(a.trim() || def)));
});
const askYN = (q, def = "n") => ask(`${q} (s/N)`, def === "s" ? "s" : "n").then((a) => /^(s|si|sim|y|yes)$/i.test(a));

function printMenu(title, rows) {
  ui.panel(title, rows);
}

// ------------------------------------------------------------------- artefatos da squad
/** Instala os artefatos da squad (agents/skills/commands/hooks/plugins) + MCP
 *  para o harness escolhido — no RUNTIME, via bin/sdd-harness.js --artifacts-only. */
async function installArtifacts(cwd, harness) {
  const marker = { opencode: ".opencode/agents", claude: ".claude/agents", codex: ".codex" }[harness];
  const already = fsSync.existsSync(path.join(cwd, marker));
  ui.stepHeader(2, 5, "Artefatos da squad");
  if (already) {
    console.log(`  ${ui.icons.info} artefatos já presentes (${marker})`);
    if (!(await askYN("Atualizar (reinstalar) os artefatos?", "n"))) { console.log(`  ${ui.paint.gray("(mantidos)")}`); return; }
  } else if (!(await askYN(`Instalar artefatos da squad para ${harness} neste projeto? (agents/skills/hooks/plugins + MCP)`, "s"))) {
    console.log(`  ${ui.paint.yellow("⚠")} ${ui.paint.dim("sem artefatos — o harness roda com o ambiente que já tiver")}`);
    return;
  }
  console.log(`  ${ui.paint.gray("─")} instalando artefatos para ${harness} (saída ao vivo)…`);
  const installer = path.join(SOURCE_ROOT, "bin", "sdd-harness.js");
  const r = spawnSync(process.execPath, [installer, `--${harness}`, "--target", cwd, "--artifacts-only"], {
    cwd, stdio: "inherit",
  });
  if (r.status === 0) console.log(`  ${ui.icons.ok} ${ui.paint.green("artefatos instalados")} ${ui.paint.gray(`(${harness}) + MCP codegraph`)}`);
  else console.log(`  ${ui.icons.fail} ${ui.paint.red("instalação falhou")} — rode manualmente: sdd-harness --${harness} --target ${cwd} --artifacts-only`);
}

// ------------------------------------------------------------------- .planning
async function maybeCleanPlanning(cwd) {
  const dir = path.join(cwd, ".planning");
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") || f.endsWith(".json"));
  } catch { console.log("(.planning/ inexistente ou vazio — nada a limpar)"); return false; }
  if (!files.length) { console.log("(.planning/ vazio — nada a limpar)"); return false; }
  printMenu("limpar .planning/? estes arquivos serão apagados para começar do zero", files.map((f) => `• ${f}`));
  if (!(await askYN("Apagar e começar do zero", "n"))) { console.log("(mantidos)"); return false; }
  for (const f of files) await fs.rm(path.join(dir, f), { force: true });
  console.log(`✓ .planning/ limpo (${files.length} arquivos)`);
  return true;
}

// ------------------------------------------------------------------- issue gh
const execOut = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 20, timeout: 20_000 });
  return r.status === 0 ? r.stdout : null;
};

async function fetchIssue(input, cwd) {
  let m = input.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/);
  if (!m) m = input.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m && /^#?\d+$/.test(input.trim())) {
    const num = input.trim().replace("#", "");
    const url = execOut("git", ["-C", cwd, "remote", "get-url", "origin"])?.trim();
    const repo = url?.match(/[:/]([\w.-]+)\/([\w.-]+?)(\.git)?$/)?.slice(1, 3).join("/");
    if (!repo) return null;
    m = [null, ...repo.split("/"), num];
  }
  if (!m) return null;
  const [, owner, repo, num] = m;
  const out = execOut("gh", ["issue", "view", num, "-R", `${owner}/${repo}`, "--json", "number,title,body,labels,url"]);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    return {
      url: j.url, number: j.number, title: j.title,
      body: (j.body ?? "").slice(0, 6000),
      labels: (j.labels ?? []).map((l) => l.name ?? l).join(", "),
    };
  } catch { return null; }
}

// ------------------------------------------------------------------- modelos
const priceOf = (e) =>
  e.input == null && e.output == null ? "custo desconhecido" : `$${fmt$(e.input)}/M in · $${fmt$(e.output)}/M out`;
const fmt$ = (v) => (v == null ? "?" : String(v));
const fmtCtx = (c) => (c ? Math.round(c / 1000) + "k" : "?");

async function pickModelsForRoles(harness, forcedModel) {
  const platform = AGENT_PRESETS[harness].platform;
  const pools = await loadModelPools([platform]);
  const pool = pools[platform] ?? [];
  let defaults = null;
  try { defaults = await loadDefaults(SOURCE_ROOT); } catch {}
  const chosen = {};
  if (forcedModel) {
    for (const r of ROLES) chosen[r] = { modelValue: forcedModel, label: forcedModel, input: null, output: null };
    return chosen;
  }
  for (const role of ROLES) {
    const roleDefault = platform === "opencode" ? defaults?.opencode?.[role] : defaults?.codex?.[role];
    const ranked = rankModels(pool, platform, role, roleDefault);
    const top = ranked.slice(0, 10);
    if (!top.length) {
      console.error(`(sem modelos no pool de ${platform} — usando default do papel)`);
      chosen[role] = { modelValue: roleDefault?.model ?? roleDefault ?? "", label: String(roleDefault?.model ?? roleDefault ?? "default"), input: null, output: null };
      continue;
    }
    printMenu(`modelo para o agente ${role.toUpperCase()}`, top.map((e, i) => {
      const idx = i === 0 ? ui.icons.star : ui.paint.gray(`${i + 1})`);
      const label = i === 0 ? ui.paint.bold(e.label) : e.label;
      const varHint = chooseVariant(e, role, roleDefault?.variant ?? null);
      const price = ui.paint.dim(priceOf(e));
      const rec = i === 0 ? `  ${ui.icons.star} ${ui.paint.brightYellow("recomendado p/ este papel")}` : "";
      return `${idx} ${label}  ${ui.paint.gray(`[${e.modelValue}]`)}  ${price}  ${ui.paint.gray(`ctx ${fmtCtx(e.context)}`)}${varHint ? ui.paint.gray(` · var ${varHint}`) : ""}${rec}`;
    }));
    const ans = await ask(`Escolha o modelo do ${role} (número, enter = recomendado)`, "1");
    const idx = Math.min(Math.max(parseInt(ans, 10) || 1, 1), top.length);
    chosen[role] = top[idx - 1];
    console.log(`  ${ui.icons.ok} ${role}: ${ui.paint.bold(chosen[role].label)} ${ui.paint.gray(`(${chosen[role].modelValue})`)}`);
  }
  return chosen;
}

// ------------------------------------------------------------------- métricas
const MARK_SKILL = /⟐\s*skill ✓\s*—?\s*skill\s+"?([\w.@/-]+)"?/g;
const MARK_HOOK = /⟐\s*hook ✓\s*—?\s*([\w-]+)/g;
const CMD_RE = /^(rtk|codegraph|ast-grep|sg|git|npm|npx|gh|node|py(thon3?)?|pytest|supabase|vercel)\b/;

class Metrics {
  constructor() {
    this.phases = new Map(ROLES.map((r) => [r, { tokensIn: 0, tokensOut: 0, cost: 0, turns: 0, skills: new Map(), hooks: new Map(), cmds: new Map() }]));
  }
  phase(role) { return this.phases.get(role) ?? { tokensIn: 0, tokensOut: 0, cost: 0, turns: 0, skills: new Map(), hooks: new Map(), cmds: new Map() }; }
  addUsage(role, usage) {
    const p = this.phase(role);
    if (!usage) return;
    p.tokensIn += usage.inputTokens ?? 0;
    p.tokensOut += usage.outputTokens ?? 0;
    p.turns += 1;
  }
  addCost(role, amount) { this.phase(role).cost += amount ?? 0; }
  scanText(role, text) {
    if (!text) return;
    const p = this.phase(role);
    for (const m of text.matchAll(MARK_SKILL)) bump(p.skills, m[1]);
    for (const m of text.matchAll(MARK_HOOK)) bump(p.hooks, m[1]);
    if (/⟐\s*rtk ✓/.test(text)) bump(p.cmds, "rtk (proxy)");
    if (/codegraph_[a-z_]+|codegraph (explore|serve|init|status)/i.test(text)) bump(p.cmds, "codegraph");
  }
  addTool(role, title) {
    if (!title) return;
    const p = this.phase(role);
    const first = String(title).trim().split(/\s+/).slice(0, 2).join(" ");
    if (CMD_RE.test(first)) bump(p.cmds, first);
    this.scanText(role, String(title));
  }
  totals() {
    let tokensIn = 0, tokensOut = 0, cost = 0, turns = 0;
    const skills = new Map(), hooks = new Map(), cmds = new Map();
    for (const [, p] of this.phases) {
      tokensIn += p.tokensIn; tokensOut += p.tokensOut; cost += p.cost; turns += p.turns;
      for (const [k, v] of p.skills) bump(skills, k, v);
      for (const [k, v] of p.hooks) bump(hooks, k, v);
      for (const [k, v] of p.cmds) bump(cmds, k, v);
    }
    return { tokensIn, tokensOut, cost, turns, skills, hooks, cmds };
  }
  asciiSummary(models) {
    const lines = ["", "══ MÉTRICAS DA SQUAD (ACP — tokens reais do harness) ══"];
    for (const r of ROLES) {
      const p = this.phases.get(r);
      lines.push(`  ${r.padEnd(9)} ${String(p.tokensIn).padStart(9)} in · ${String(p.tokensOut).padStart(7)} out · $${p.cost.toFixed(4)} · ${models[r]?.label ?? "?"}`);
    }
    const t = this.totals();
    lines.push(`  ${"TOTAL".padEnd(9)} ${String(t.tokensIn).padStart(9)} in · ${String(t.tokensOut).padStart(7)} out · $${t.cost.toFixed(4)}`);
    lines.push(`  skills: ${mapStr(t.skills)}`);
    lines.push(`  hooks:  ${mapStr(t.hooks)}`);
    lines.push(`  comandos: ${mapStr(t.cmds)}`);
    return lines.join("\n");
  }
}

// ------------------------------------------------------------------- console HTML (dashboards)
function orchestratorHtml(state) {
  const { agent, cwd, sessionId, events, metrics, issue, models, currentRole } = state;
  const t = metrics?.totals?.() ?? { tokensIn: 0, tokensOut: 0, cost: 0, skills: new Map(), hooks: new Map(), cmds: new Map() };
  const rows = [...metrics.phases.entries()].map(([r, p]) =>
    `<tr><td>${esc(r)}${currentRole === r ? " ▶" : ""}</td><td>${esc(models[r]?.label ?? "—")}</td><td>${p.tokensIn}</td><td>${p.tokensOut}</td><td>$${p.cost.toFixed(4)}</td></tr>`).join("");
  const board = (m, hi = false) => [...m.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="chip ${hi && /rtk|codegraph|ast-grep|sg/i.test(k) ? "hi" : ""}">${esc(k)}×${v}</span>`).join(" ") || "<em>—</em>";
  const logRows = events.slice(-250).map((e) => `<div><span class="t">${esc(e.role ? `[${e.role}] ` : "")}${esc(e.t)}</span> ${esc(e.text)}</div>`).join("\n");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Squad ACP — ${esc(agent)}</title>
<style>
:root{color-scheme:light;background:#f6f7f9;color:#14181f}
body{margin:0 auto;max-width:1080px;padding:1.6rem;font:15px/1.55 system-ui}
h1{font-size:1.15rem;margin:0 0 .2rem} .sub{color:#67707d;font-size:.85rem;margin-bottom:1rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:.9rem}
.card h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:#67707d;margin:0 0 .6rem}
table{border-collapse:collapse;width:100%;font-size:.86rem}
td,th{border-bottom:1px solid #edf0f3;padding:.3rem .4rem;text-align:left}
.chip{display:inline-block;background:#eef2ff;border:1px solid #dbe3f5;border-radius:999px;padding:.05rem .55rem;margin:.1rem .25rem .1rem 0;font-size:.8rem}
.chip.hi{background:#ecfdf5;border-color:#b7e4c7;font-weight:600}
.log{white-space:pre-wrap;font:12.5px/1.5 ui-monospace,Menlo,monospace;max-height:42vh;overflow-y:auto;border-left:3px solid #3b82f6;padding-left:.8rem}
.t{color:#8a93a0}
.issue{font-size:.85rem;color:#3c4654;margin-bottom:1rem}
</style></head><body data-lavish-annotate="off">
<h1>Squad ACP — orquestração ${esc(agent)}</h1>
<div class="sub">cwd: ${esc(cwd)}${sessionId ? " · session: " + esc(sessionId) : ""} · fase atual: <b>${esc(currentRole ?? "—")}</b></div>
<div class="issue">📌 Issue: <b>${esc(issue?.title ?? "—")}</b>${issue?.url ? ` · ${esc(issue.url)}` : ""}</div>
<div class="grid">
  <div class="card"><h2>Métricas por agente (tokens reais + custo USD)</h2>
    <table><tr><th>agente</th><th>modelo</th><th>tokens in</th><th>tokens out</th><th>custo</th></tr>${rows}</table>
    <p style="font-size:.85rem"><b>TOTAL:</b> ${t.tokensIn} in · ${t.tokensOut} out · <b>$${t.cost.toFixed(4)}</b></p></div>
  <div class="card"><h2>Comandos invocados (rtk/codegraph destacados)</h2>
    <div>${board(t.cmds, true)}</div></div>
  <div class="card"><h2>Skills chamadas (⟐ skill ✓)</h2><div>${board(t.skills)}</div></div>
  <div class="card"><h2>Hooks determinísticos (⟐ hook ✓)</h2><div>${board(t.hooks)}</div></div>
</div>
<div class="card" style="margin-top:1rem"><h2>Logs dos processos agênticos</h2><div class="log">${logRows || "<em>aguardando…</em>"}</div>
<p class="sub">Fale na <b>Conversation panel</b> para interagir com o agente no meio do processo — entra no turno corrente (steering nativo) ou na fila do próximo.</p></div>
</body></html>`;
}

// ------------------------------------------------------------------- texto por fase + steering
const phaseText = new Map(ROLES.map((r) => [r, ""]));
const steeringQueue = {
  items: [],
  push(item) { this.items.push(item); console.log(`  ${ui.icons.arrow} ${ui.paint.yellow("steering")} ${ui.paint.dim(String(item.text).slice(0, 160))}`); },
  drain() { return this.items.splice(0); },
};
const phaseState = { currentRole: null, phaseActive: false };

// ------------------------------------------------------------------- run de fase via ACP
async function runPhase({ preset, cwd, role, modelValue, rolePrompt, task, prevContext, metrics, renderer, lavish }) {
  const child = spawn(preset.command, preset.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let activeRenderer = renderer; // trocado pelo wrapper com spinner quando o turno começa
  const rpc = new Rpc(child, {
    onEvent: (msg) => {
      handleNotification(msg, { emit: (o) => activeRenderer.emit(o) }, lavish);
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === "usage_update") metrics.addCost(role, u.cost?.amount ?? 0);
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") metrics.addTool(role, u.title);
      if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") metrics.scanText(role, u.content?.text);
    },
    onRequest: async (req) => {
      const m = req.method;
      if (m === "session/request_permission") {
        const options = req.params?.options ?? [];
        const allow = options.find((o) => o.kind?.startsWith("allow"));
        const reject = options.find((o) => o.kind === "reject_once");
        const kind = req.params?.toolCall?.kind ?? "";
        const title = req.params?.toolCall?.title ?? "";
        if (kind === "read" && allow) {
          renderer.emit({ type: "permission", kind, title, choice: "allow(auto)" });
          return { optionId: allow.optionId };
        }
        printMenu(`🔑 permissão pedida [${kind}]`, [title]);
        const ok = await askYN("Permitir", "n");
        if (ok && allow) return { optionId: allow.optionId };
        renderer.emit({ type: "permission", kind, title, choice: "reject" });
        return { optionId: reject?.optionId };
      }
      if (m === "fs/read_text_file") {
        const p = path.resolve(req.params?.path ?? "");
        if (!p.startsWith(cwd + path.sep) && p !== cwd) throw new Error(`fora do cwd: ${p}`);
        let text = await fs.readFile(p, "utf8");
        const { line, limit } = req.params ?? {};
        if (line !== undefined || limit !== undefined) {
          const lines = text.split("\n");
          const start = line !== undefined ? Math.max(0, line - 1) : 0;
          const end = limit !== undefined ? start + limit : lines.length;
          text = lines.slice(start, end).join("\n");
        }
        return { content: text };
      }
      if (m === "fs/write_text_file") {
        const p = path.resolve(req.params?.path ?? "");
        if (!p.startsWith(cwd + path.sep) && p !== cwd) throw new Error(`fora do cwd: ${p}`);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, req.params?.content ?? "", "utf8");
        return {};
      }
      throw new Error(`método não suportado: ${m}`);
    },
  });

  const init = await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true, readDirectory: true }, terminal: false },
  }, 60_000).catch((e) => {
    if (e.acpError?.code === -32003 || /auth/i.test(e.message)) fail(`harness pediu auth — rode: ${preset.authHint}`, 3);
    fail(`initialize falhou: ${e.message}`, 4);
  });
  const steeringSupported = Boolean(init?._meta?.steering?.supported);

  const newParams = { cwd, mcpServers: [] };
  if (modelValue) newParams.model = modelValue;
  const info = await rpc.request("session/new", newParams, 120_000);
  const sessionId = info?.sessionId;

  // steering via terminal durante a fase (listener próprio; o wizard não pergunta nada agora)
  const NO_STEER_RE = /^(s|si|sim|y|yes|n|nao|não|no)$/i;
  phaseState.phaseActive = true;
  const steerInFlight = [];
  const lineHandler = (line) => {
    const t = line.trim();
    if (!t || NO_STEER_RE.test(t)) return;
    if (steeringSupported) {
      console.log(`  ${ui.icons.arrow} ${ui.paint.yellow("steering imediato")} ${ui.paint.gray(role)} ${ui.paint.dim(t.slice(0, 160))}`);
      steerInFlight.push(
        rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] })
          .then((r) => { metrics.addUsage(role, r?.usage); return r; })
          .catch(() => null));
    } else steeringQueue.push({ text: t, from: "terminal" });
  };
  rl.on("line", lineHandler);

  const prompt = [rolePrompt, task, prevContext].filter(Boolean).join("\n\n");
  phaseState.currentRole = role;
  ui.phaseHeader(role, modelValue ?? "modelo default");
  const sp = ui.spinner(`${role} pensando com ${modelValue ?? "default"}`);
  let spStopped = false;
  const stopSp = (text, color) => { if (!spStopped) { spStopped = true; sp.stop(text, color); } };
  activeRenderer = {
    emit(obj) {
      if (obj.type === "agent_text") stopSp("agente respondendo");
      else if (obj.type === "tool_call") stopSp("executando tools");
      renderer.emit(obj);
    },
  };
  lavish?.event(`▶ ${role} — turno iniciado (${modelValue ?? "modelo default"})`);

  const res = await rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  }).catch((e) => {
    if (e.acpError?.code === -32003 || /auth/i.test(e.message)) fail(`auth exigida — rode: ${preset.authHint}`, 3);
    stopSp("prompt falhou", ui.paint.red);
    renderer.emit({ type: "status", message: `[${role}] prompt falhou: ${e.message}` });
    return null;
  });
  stopSp(`turno encerrado (${res?.stopReason ?? "error"})`, res?.stopReason === "end_turn" ? ui.paint.green : ui.paint.yellow);
  metrics.addUsage(role, res?.usage);

  // steering não-nativo (fila) ou pós-turno: entrega o resto como turno extra
  const leftover = steeringQueue.drain();
  if (leftover.length) {
    lavish?.event(`↪ steering aplicado ao ${role} (pós-turno)`);
    const res2 = await rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: leftover.map((s) => s.text).join("\n\n") }],
    }).catch(() => null);
    metrics.addUsage(role, res2?.usage);
  }
  await Promise.allSettled(steerInFlight);

  const finalText = phaseText.get(role) ?? "";
  phaseText.set(role, "");

  rl.off("line", lineHandler);
  phaseState.phaseActive = false;
  try { rpc.notify("session/cancel", { sessionId }); } catch {}
  child.stdin?.end();
  await new Promise((r) => { if (child.exitCode !== null) return r(); child.on("exit", r); setTimeout(() => { child.kill("SIGTERM"); r(); }, 3000); });

  return { sessionId, stopReason: res?.stopReason ?? "error", output: finalText };
}

// ------------------------------------------------------------------- role prompts
async function rolePromptFor(role) {
  const file = path.join(SOURCE_ROOT, "agents", `${role}.agent.md`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    const contract = role === "planner"
      ? `Seu escopo é PLANEJAR — NÃO implemente nem edite arquivos de código (isso é do builder). Se a tarefa estiver clara, NÃO entreviste — produza PRD/PLAN direto; use steering só se houver ambiguidade BLOQUEANTE. Saída: === PRD === (max 1 página) e === PLAN === (subtasks [Front]/[Back]/[Infra], dependências, critérios de aceite). NÃO escreva em .planning/.`
      : role === "builder"
        ? `=== RESUMO === (o que fez, arquivos alterados, decisões, pendências). Implemente direto nos arquivos do repo.`
        : `=== PARECER === (arquitetura/risco/bloqueios; verdict APPROVED ou CHANGES_REQUESTED).`;
    return `Você é o macro ${role.toUpperCase()} da squad SDD, executando via ACP em um harness externo. Siga o seu papel:\n\n${body.slice(0, 12_000)}\n\nCONTRATO DE SAÍDA (texto, no fim da resposta): ${contract}`;
  } catch {
    return `Você é o macro ${role.toUpperCase()} da squad SDD. Retorne === ${role.toUpperCase()} === no fim da resposta.`;
  }
}

// ------------------------------------------------------------------- renderer (terminal)
function makeRenderer() {
  const render = {
    emit(obj) {
      const role = phaseState.currentRole;
      if (obj.type === "agent_text") {
        phaseText.set(role, (phaseText.get(role) ?? "") + obj.text);
        if (!/^=+$/.test(obj.text) && !obj.text.includes("===")) process.stdout.write(obj.text);
      } else if (obj.type === "thought") {
        phaseText.set(role, (phaseText.get(role) ?? "") + obj.text);
      } else if (obj.type === "tool_call") {
        process.stdout.write(`\n  ${ui.paint.cyan("▸")} ${obj.title ?? ""} ${ui.paint.gray(`[${obj.kind ?? obj.status ?? ""}]`)}\n`);
      } else if (obj.type === "tool_update") {
        if (obj.status === "failed") process.stdout.write(`  ${ui.paint.red("✘")} ${obj.title}\n`);
      } else if (obj.type === "plan") {
        for (const e of obj.entries) process.stdout.write(`  ${e.status === "completed" ? ui.paint.green("☑") : e.status === "in_progress" ? ui.paint.cyan("▶") : ui.paint.gray("☐")} ${e.content}\n`);
      } else if (obj.type === "permission") {
        console.log(`  ${ui.paint.yellow("🔑")} ${ui.paint.dim(obj.kind ?? "?")}: ${obj.title ?? ""} ${ui.paint.gray(`→ ${obj.choice}`)}`);
      } else if (obj.type === "status") {
        console.log(`  ${ui.paint.gray("—")} ${ui.paint.dim(obj.message)}`);
      }
    },
  };
  return render;
}

// ------------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const cwd = flag("--cwd") ? path.resolve(flag("--cwd")) : process.cwd();
  const uiFlag = argv.includes("--ui");
  const forcedAgent = flag("--agent");
  const forcedModel = flag("--model");

  ensureDeps({ log: (s) => console.error(s) });
  if (!process.stdin.isTTY) fail("o orquestrador é interativo (wizard) — precisa de TTY. Para uma subtask única use acp_client.mjs.");
  ui.banner("ACP — Squad Orchestrator");
  rl = readline.createInterface({ input: process.stdin, terminal: true });

  // 1) harness
  let harness = forcedAgent;
  if (!harness) {
    ui.stepHeader(1, 5, "Escolha do harness");
    printMenu("qual harness vai executar a squad via ACP?", [
      `${ui.paint.brightCyan("1)")} opencode  ${ui.paint.dim("(nativo — opencode acp)")}`,
      `${ui.paint.white("2)")} codex     ${ui.paint.dim("(adaptador oficial @agentclientprotocol/codex-acp)")}`,
    ]);
    const ans = await ask("Escolha o harness", "1");
    harness = ans === "2" ? "codex" : "opencode";
  }
  if (!AGENT_PRESETS[harness]) fail(`harness desconhecido: ${harness}`, 2);
  console.log(`  ${ui.icons.ok} harness: ${ui.paint.bold(harness)}`);

  // 2) artefatos da squad no projeto (runtime — a instalação não os copia mais)
  await installArtifacts(cwd, harness);

  // 3) limpar .planning (STATE/HANDOFF/specs) para começar do zero
  ui.stepHeader(3, 5, "Estado da squad (.planning/)");
  await maybeCleanPlanning(cwd);

  // 4) issue do GitHub — obrigatória antes do primeiro agente
  ui.stepHeader(4, 5, "Tarefa — issue do GitHub");
  let issue = null;
  while (!issue) {
    const link = await ask("Link/ID da issue (https://github.com/owner/repo/issues/N, owner/repo#N ou #N)");
    if (!link) continue;
    issue = await fetchIssue(link, cwd);
    if (!issue) {
      const manual = await ask("gh falhou/não encontrou — cole o texto da tarefa manualmente (vazio = tentar outro link)");
      if (manual) issue = { title: manual.split("\n")[0].slice(0, 80), body: manual, url: null, labels: "", number: "manual" };
    }
  }
  console.log(`  ${ui.icons.ok} issue: ${ui.paint.bold(`#${issue.number ?? "manual"}`)} ${issue.title}${issue.labels ? ui.paint.gray(` [${issue.labels}]`) : ""}`);

  // 5) modelo por agente (lista completa + custos + recomendado por papel)
  ui.stepHeader(5, 5, "Modelo por agente");
  const models = await pickModelsForRoles(harness, forcedModel);
  for (const r of ROLES) console.log(`  ${ui.icons.ok} ${ui.paint.boldCyan(r.padEnd(8))} ${models[r].label} ${ui.paint.gray(`(${models[r].modelValue})`)} ${ui.paint.dim("·")} ${ui.paint.dim(priceOf(models[r]))}`);

  // UI/console Lavish com dashboards (opcional)
  const metrics = new Metrics();
  const renderer = makeRenderer();
  let lavish = null;
  if (uiFlag) {
    lavish = new LavishUi({ cwd }, { agentLabel: `squad ${harness}`, render: orchestratorHtml });
    Object.assign(lavish.state, { metrics, issue, models, currentRole: null });
    lavish.onFeedback = (p) => steeringQueue.push(p);
    await lavish.start();
  }
  // re-render periódico dos dashboards
  const uiTimer = lavish ? setInterval(() => lavish.refresh(), 2000) : null;

  // terminal steering fora das fases também é aceito
  const NO_STEER_RE = /^(s|si|sim|y|yes|n|nao|não|no)$/i;
  const idleSteer = (line) => {
    const t = line.trim();
    if (!t || NO_STEER_RE.test(t) || phaseState.phaseActive) return;
    steeringQueue.push({ text: t, from: "terminal" });
  };
  rl.on("line", idleSteer);

  // ── fases: planner → builder → reviewer (contexto encadeado em memória)
  const rolePrompts = {};
  for (const r of ROLES) rolePrompts[r] = await rolePromptFor(r);
  const task = `Tarefa (issue #${issue.number} — ${issue.url ?? "manual"}):\n${issue.title}\n\n${issue.body}`;
  const outputs = {};

  for (const role of ROLES) {
    phaseState.currentRole = role;
    lavish?.event(`══ FASE ${role.toUpperCase()} ══`);
    const prev = role === "planner" ? "" : role === "builder"
      ? `=== CONTEXTO DO PLANNER ===\n${outputs.planner ?? ""}`
      : `=== CONTEXTO DO BUILDER (resumo de implementação) ===\n${outputs.builder ?? ""}`;
    const run = await runPhase({
      preset: AGENT_PRESETS[harness], cwd, role, modelValue: models[role].modelValue,
      rolePrompt: rolePrompts[role], task, prevContext: prev,
      metrics, renderer, lavish,
    });
    outputs[role] = run.output;
    const t = metrics.totals();
    console.log(`  ${ui.icons.ok} ${ui.paint.bold(role)} concluído ${ui.paint.gray(`(${run.stopReason})`)} — ${ui.paint.dim(`acumulado: ${t.tokensIn} in / ${t.tokensOut} out · $${t.cost.toFixed(4)}`)}`);
  }

  clearInterval(uiTimer);
  rl.off("line", idleSteer);
  console.log("");
  ui.metricsPanel(metrics, models);
  console.log(`\n  ${ui.icons.ok} ${ui.paint.bold("TMR")} ${ui.paint.dim("orquestração concluída")}`);
  if (lavish) {
    lavish.event("■ orquestração concluída");
    await lavish.end();
  }
  rl.close();
  process.exit(0);
}

main().catch((err) => fail(String(err?.stack ?? err), 1));
