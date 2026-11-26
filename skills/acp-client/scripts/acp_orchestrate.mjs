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
 *      destacados) — TUDO no terminal, via split screen do TMR.
 *
 * Uso:
 *   node skills/acp-client/scripts/acp_orchestrate.mjs [--cwd <repo>] \
 *        [--agent opencode|codex] [--model <provider/model>]
 *
 * Requer TTY (wizard interativo). Run simples de UMA subtask continua no
 * acp_client.mjs (usado pelos macros builder/planner internos).
 */
import { spawn, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Rpc, handleNotification } from "./acp_client.mjs";
import { ensureDeps } from "./ensure_deps.mjs";
import { loadModelPools, rankModels, chooseVariant, loadDefaults } from "../../../bin/lib/model-picker.js";
import * as ui from "./tmr_ui.mjs";
import * as input from "./tmr_input.mjs";
import * as review from "./tmr_review.mjs";
import * as screen from "./tmr_screen.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// scripts → acp-client → skills → raiz do pacote/repo
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const REVIEW_FIND_SKILL = path.join(SOURCE_ROOT, "skills", "find-skills", "scripts", "find_skill.py");

const AGENT_PRESETS = {
  opencode: { command: "opencode", args: ["acp"], authHint: "opencode auth login", platform: "opencode" },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    authHint: "codex login",
    platform: "codex",
  },
};

const ROLES = ["planner", "builder", "reviewer", "shipper", "supervisor"];
const ROLE_DESC = {
  planner: "planeja produto e arquitetura — produz PRD + PLAN em memória",
  builder: "implementa o plano — código, testes e verificação local",
  reviewer: "revisa arquitetura e risco — parecer APPROVED ou CHANGES_REQUESTED",
  shipper: "finaliza — branch/PR/CI via gh, encerra a issue, STATE/HANDOFF",
  supervisor: "auditoria final — hooks, métricas, rtk gain, riscos e pendências",
};

const fail = (msg, code = 1) => { console.error(`acp_orchestrate: ${msg}`); process.exit(code); };
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const mapStr = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(", ") || "—";

// wizard usa a camada TMR (raw mode + keypress próprios) — sempre visível e dinâmico
const ask = input.ask;
const askYN = input.confirm;

function printMenu(title, rows) {
  ui.panel(title, rows);
}

// ------------------------------------------------------------------- artefatos da squad
/** Instala os artefatos da squad (agents/skills/commands/hooks/plugins) + MCP
 *  para o harness escolhido — no RUNTIME, via bin/sdd-harness.js --artifacts-only. */
async function installArtifacts(cwd, harness) {
  const marker = { opencode: ".opencode/agents", claude: ".claude/agents", codex: ".codex" }[harness];
  const already = fsSync.existsSync(path.join(cwd, marker));
  ui.stepHeader(2, 4, "Artefatos da squad");
  if (already) {
    console.log(`  ${ui.icons.info} artefatos já presentes (${marker})`);
    if (!(await askYN("Atualizar (reinstalar) os artefatos?", "n"))) { console.log(`  ${ui.paint.gray("(mantidos)")}`); return; }
  } else if (!(await askYN(`Instalar artefatos da squad para ${harness} neste projeto? (agents/skills/hooks/plugins + MCP)`, "s"))) {
    console.log(`  ${ui.paint.yellow("⚠")} ${ui.paint.dim("sem artefatos — o harness roda com o ambiente que já tiver")}`);
    return;
  }
  console.log(`  ${ui.paint.gray("─")} instalando artefatos para ${harness} (saída ao vivo)…`);
  const installer = path.join(SOURCE_ROOT, "bin", "sdd-harness.js");
  // spawn async com linhas roteadas pelo console.log (compatível com split screen)
  const status = await new Promise((resolve) => {
    const child = spawn(process.execPath, [installer, `--${harness}`, "--target", cwd, "--artifacts-only"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const pump = (stream) => { stream.setEncoding("utf8"); let buf = ""; stream.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) console.log(`    ${ui.paint.gray(l)}`); } }); };
    pump(child.stdout); pump(child.stderr);
    child.on("exit", (code) => resolve(code));
  });
  if (status === 0) console.log(`  ${ui.icons.ok} ${ui.paint.green("artefatos instalados")} ${ui.paint.gray(`(${harness}) + MCP codegraph`)}`);
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

/** Lista de modelos DISPONÍVEIS no harness escolhido — sondada UMA vez por run
 *  e reutilizada em todas as fases (o catálogo do provider pode crescer ao vivo;
 *  sem isso a lista "multiplica" entre fases). */
function probeAvailableModels(harness) {
  if (harness === "opencode") {
    const r = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: 30_000 });
    if (r.status === 0) {
      const values = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.includes("/"));
      if (values.length) return values.map((v) => ({ value: v, name: v }));
    }
  }
  return null; // codex (e fallback): usa o catálogo do model-picker
}

async function pickModelForRole(harness, role, forcedModel, available) {
  const platform = AGENT_PRESETS[harness].platform;
  const pools = await loadModelPools([platform]);
  const pool = pools[platform] ?? [];
  let defaults = null;
  try { defaults = await loadDefaults(SOURCE_ROOT); } catch {}
  if (forcedModel) return { modelValue: forcedModel, label: forcedModel, input: null, output: null };

  const roleDefault = platform === "opencode" ? defaults?.opencode?.[role] : defaults?.codex?.[role];
  const ranked = rankModels(pool, platform, role, roleDefault);
  if (!ranked.length && !available?.length) {
    console.error(`(sem modelos no pool de ${platform} — usando default do papel)`);
    return { modelValue: roleDefault?.model ?? roleDefault ?? "", label: String(roleDefault?.model ?? roleDefault ?? "default"), input: null, output: null };
  }
  // disponíveis no harness: filtra o pool ranqueado; modelos fora do catálogo
  // de preços entram no fim com "custo desconhecido" — a lista é a COMPLETA
  // de disponíveis, estável por run (sondada uma vez, nunca re-cresce)
  const availSet = new Set((available ?? []).map((a) => a.value));
  const inPool = availSet.size ? ranked.filter((e) => availSet.has(e.modelValue)) : ranked;
  const inPoolSet = new Set(inPool.map((e) => e.modelValue));
  const extras = (available ?? [])
    .filter((a) => !inPoolSet.has(a.value))
    .map((a) => ({ modelValue: a.value, label: a.name ?? a.value, input: null, output: null, context: null }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const ranked_all = [...inPool, ...extras];
  const options = ranked_all.map((e, i) => {
    const varHint = e.input != null ? chooseVariant(e, role, roleDefault?.variant ?? null) : null;
    const rec = i === 0 ? `${ui.icons.star} ` : "";
    return `${rec}${e.label}  [${e.modelValue}]  ${priceOf(e)}  ctx ${fmtCtx(e.context)}${varHint ? ` · var ${varHint}` : ""}`;
  });
  const idx = await input.select(
    `Modelo para o agente ${role.toUpperCase()} — ${ranked_all.length} disponíveis no ${harness} (ordenado por qualidade × custo) · ↑↓ navega, enter escolhe`,
    options,
    1,
    (i) => `${ranked_all[i].label} (${ranked_all[i].modelValue})`,
  );
  const chosen = ranked_all[idx];
  console.log(`  ${ui.icons.ok} ${role}: ${ui.paint.bold(chosen.label)} ${ui.paint.gray(`(${chosen.modelValue})`)}`);
  return chosen;
}

// ------------------------------------------------------------------- métricas
const MARK_SKILL = /⟐\s*skill ✓\s*—?\s*skill\s+"?([\w.@/-]+)"?/g;
const MARK_HOOK = /⟐\s*hook ✓\s*—?\s*([\w-]+)/g;
const CMD_RE = /^(rtk|codegraph|ast-grep|sg|git|npm|npx|gh|node|py(thon3?)?|pytest|supabase|vercel)\b/;

class Metrics {
  constructor() {
    this.phases = new Map(ROLES.map((r) => [r, { tokensIn: 0, tokensOut: 0, cost: 0, turns: 0, skills: new Map(), hooks: new Map(), cmds: new Map() }]));
    this.times = new Map(); // role -> { startedAt, endedAt }
  }
  phase(role) { return this.phases.get(role) ?? { tokensIn: 0, tokensOut: 0, cost: 0, turns: 0, skills: new Map(), hooks: new Map(), cmds: new Map() }; }
  start(role) { if (!this.times.get(role)) this.times.set(role, { startedAt: Date.now() }); }
  end(role) { const t = this.times.get(role); if (t && !t.endedAt) t.endedAt = Date.now(); }
  duration(role) {
    const t = this.times.get(role);
    if (!t?.startedAt) return "—";
    const s = Math.max(0, Math.floor(((t.endedAt ?? Date.now()) - t.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
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

// ------------------------------------------------------------------- texto por fase + steering
const phaseText = new Map(ROLES.map((r) => [r, ""]));
const steeringQueue = {
  items: [],
  push(item) { this.items.push(item); console.log(`  ${ui.icons.arrow} ${ui.paint.yellow("steering")} ${ui.paint.dim(String(item.text).slice(0, 160))}`); },
  drain() { return this.items.splice(0); },
};
const phaseState = { currentRole: null, phaseActive: false };

/** Status da squad para o quadro: fases concluídas ✔, em curso ▶, pendentes ☐. */
function squadStatus(outputs) {
  return ROLES.map((r) =>
    outputs[r] ? ui.paint.green(`✔${r.slice(0, 1)}`) : phaseState.currentRole === r ? ui.paint.brightCyan(`▶${r.slice(0, 1)}`) : ui.paint.gray(`☐${r.slice(0, 1)}`)
  ).join(" ");
}

// ------------------------------------------------------------------- run de fase via ACP
async function runPhase({ preset, cwd, role, modelValue, rolePrompt, task, prevContext, metrics, renderer }) {
  const child = spawn(preset.command, preset.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let activeRenderer = renderer; // trocado pelo wrapper com spinner quando o turno começa
  const rpc = new Rpc(child, {
    onEvent: (msg) => {
      handleNotification(msg, { emit: (o) => activeRenderer.emit(o) });
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === "usage_update") metrics.addCost(role, u.cost?.amount ?? 0);
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        metrics.addTool(role, u.title);
        // marcadores ⟐ rtk ✓ / ⟐ hook ✓ / codegraph vivem na SAÍDA da tool
        // (content/rawOutput) — escaneia o evento inteiro, não só o título
        metrics.scanText(role, JSON.stringify(u));
      }
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
        // paths relativos resolvem contra o CWD DA SESSÃO, não do orquestrador
        const p = path.resolve(cwd, req.params?.path ?? "");
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
        const p = path.resolve(cwd, req.params?.path ?? "");
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

  // steering via terminal durante a fase — pela camada TMR (prompt pendente
  // tem precedência automática; teclas de y/N não vazam como steering)
  phaseState.phaseActive = true;
  const steerInFlight = [];
  input.setSteering((t) => {
    if (steeringSupported) {
      console.log(`  ${ui.icons.arrow} ${ui.paint.yellow("steering imediato")} ${ui.paint.gray(role)} ${ui.paint.dim(t.slice(0, 160))}`);
      steerInFlight.push(
        rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] })
          .then((r) => { metrics.addUsage(role, r?.usage); return r; })
          .catch(() => null));
    } else steeringQueue.push({ text: t, from: "terminal" });
  });

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
    const res2 = await rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: leftover.map((s) => s.text).join("\n\n") }],
    }).catch(() => null);
    metrics.addUsage(role, res2?.usage);
  }
  await Promise.allSettled(steerInFlight);

  const finalText = phaseText.get(role) ?? "";
  phaseText.set(role, "");

  input.setSteering(null);
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
        : role === "reviewer"
          ? `=== PARECER === (arquitetura/risco/bloqueios; verdict APPROVED ou CHANGES_REQUESTED).`
          : role === "shipper"
            ? `Rode o fluxo de ship da squad (git + gh): branch de origin/develop atualizada, commits, push, PR --base develop, acompanhe CI, atualize .planning/STATE.md e .planning/HANDOFF.md (apenas estes dois arquivos), e ENCERRE a issue do GitHub (gh issue close + Status Done no Project) se houver issue real. Saída: === SHIP === (branch, PR url, checks, issue encerrada, pendências).`
            : `Você é o supervisor: auditoria FINAL da execução. Leia .planning/STATE.md e .planning/HANDOFF.md (se existirem), verifique o que foi entregue no repo, rode 'rtk gain' para métricas de compressão e produza o parecer de auditoria. Saída: === SUPERVISOR === (entregas, hooks/marcadores observados, métricas, riscos, pendências).`;
    return `Você é o macro ${role.toUpperCase()} da squad SDD, executando via ACP em um harness externo. Siga o seu papel:\n\n${body.slice(0, 12_000)}\n\nCONTRATO DE SAÍDA (texto, no fim da resposta): ${contract}` +
      `\n\nFERRAMENTAS DA SQUAD: explore o repositório pelo MCP codegraph (codegraph_explore) em vez de ler arquivo a arquivo; os comandos bash passam automaticamente pelo proxy rtk (o marcador ⟐ rtk ✓ aparece na saída); os hooks determinísticos da squad (⟐ hook ✓) rodam nas edições. Use-os quando fizer sentido — eles alimentam as métricas da orquestração.`;
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
        if (!/^=+$/.test(obj.text) && !obj.text.includes("===")) console.log(obj.text);
      } else if (obj.type === "thought") {
        phaseText.set(role, (phaseText.get(role) ?? "") + obj.text);
      } else if (obj.type === "tool_call") {
        console.log(`  ${ui.paint.cyan("▸")} ${obj.title ?? ""} ${ui.paint.gray(`[${obj.kind ?? obj.status ?? ""}]`)}`);
      } else if (obj.type === "tool_update") {
        if (obj.status === "failed") console.log(`  ${ui.paint.red("✘")} ${obj.title}`);
      } else if (obj.type === "plan") {
        for (const e of obj.entries) console.log(`  ${e.status === "completed" ? ui.paint.green("☑") : e.status === "in_progress" ? ui.paint.cyan("▶") : ui.paint.gray("☐")} ${e.content}`);
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
  const forcedAgent = flag("--agent");
  const forcedModel = flag("--model");

  ensureDeps({ log: (s) => console.error(s) });
  if (!process.stdin.isTTY) fail("o orquestrador é interativo (wizard) — precisa de TTY. Para uma subtask única use acp_client.mjs.");
  ui.banner("ACP — Squad Orchestrator");

  // ── SPLIT SCREEN: logs à esquerda, quadro de métricas à direita, o run todo
  const split = !argv.includes("--no-split") && screen.activate();
  if (split) {
    console.log = (...a) => screen.log(a.map(String).join(" ") + "\n");
    console.error = (...a) => screen.log(ui.paint.red(a.map(String).join(" ")) + "\n");
    input.setPromptDisplay((p) => screen.setPrompt(p));
    console.log(`  ${ui.icons.info} ${ui.paint.gray("split screen ativo — logs à esquerda · quadro à direita (--no-split desliga)")}`);
  }

  // 1) harness
  let harness = forcedAgent;
  if (!harness) {
    ui.stepHeader(1, 4, "Escolha do harness");
    const idx = await input.select(
      "Qual harness vai executar a squad via ACP? (↑↓ navega, enter escolhe)",
      [
        "opencode  (nativo — opencode acp)",
        "codex     (adaptador oficial @agentclientprotocol/codex-acp)",
      ],
      1,
      (i) => ["opencode", "codex"][i],
    );
    harness = idx === 1 ? "codex" : "opencode";
  }
  if (!AGENT_PRESETS[harness]) fail(`harness desconhecido: ${harness}`, 2);
  console.log(`  ${ui.icons.ok} harness: ${ui.paint.bold(harness)}`);

  // catálogo de modelos DISPONÍVEIS — sondado uma vez, estável nas 5 fases
  const available = probeAvailableModels(harness);
  console.log(`  ${ui.icons.ok} ${ui.paint.dim(available ? `${available.length} modelos disponíveis (lista fixa para este run)` : "catálogo do model-picker")}`);

  // 2) artefatos da squad no projeto (runtime — a instalação não os copia mais)
  await installArtifacts(cwd, harness);

  // 3) limpar .planning (STATE/HANDOFF/specs) para começar do zero
  ui.stepHeader(3, 4, "Estado da squad (.planning/)");
  await maybeCleanPlanning(cwd);

  // 4) issue do GitHub — obrigatória antes do primeiro agente
  ui.stepHeader(4, 4, "Tarefa — issue do GitHub");
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

  const metrics = new Metrics();
  const renderer = makeRenderer();
  const models = {}; // escolhido POR FASE (gate de aprovação + select antes de cada agente)
  const outputs = {}; // saída de cada fase — declarado ANTES do refreshUI (evita TDZ crash)
  // re-render periódico do split screen (hero + processos + coluna direita)
  const refreshUI = () => {
    screen.setHero({ issue, harness });
    screen.setRuns(ui.runRows(metrics, models, outputs, issue, phaseState));
    screen.setSide(ui.sidePanels(metrics, models, { issue, outputs, phaseState }));
  };
  if (split) refreshUI();
  const uiTimer = setInterval(() => { try { if (split) refreshUI(); } catch {} }, 2000);

  // steering terminal entre fases — perguntas pendentes têm precedência
  input.setSteering((t) => {
    if (!phaseState.phaseActive) steeringQueue.push({ text: t, from: "terminal" });
  });

  // ── fases: planner → builder → reviewer (contexto encadeado em memória)
  // Por fase: anuncia o próximo agente → usuário APROVA → escolhe o modelo
  // (catálogo completo do harness) → executa → quadro de métricas atualiza.
  const rolePrompts = {};
  for (const r of ROLES) rolePrompts[r] = await rolePromptFor(r);
  const task = `Tarefa (issue #${issue.number} — ${issue.url ?? "manual"}):\n${issue.title}\n\n${issue.body}`;

  for (const role of ROLES) {
    phaseState.currentRole = role;
    screen.setTag(role);
    console.log(`\n  ${ui.icons.agent} ${ui.paint.boldMagenta(`PRÓXIMO AGENTE: ${role.toUpperCase()}`)} ${ui.paint.gray("·")} ${ui.paint.dim(ROLE_DESC[role] ?? "")}`);
    if (!(await askYN(`Chamar o ${role.toUpperCase()} agora?`, "s"))) {
      console.log(`  ${ui.icons.warn} ${ui.paint.yellow(`execução interrompida pelo usuário antes de ${role}`)}`);
      break;
    }
    const chosen = await pickModelForRole(harness, role, forcedModel, available);
    models[role] = chosen;
    const prev = role === "planner" ? "" : role === "builder"
      ? `=== CONTEXTO DO PLANNER ===\n${outputs.planner ?? ""}`
      : `=== CONTEXTO DO BUILDER (resumo de implementação) ===\n${outputs.builder ?? ""}`;
    metrics.start(role);
    const run = await runPhase({
      preset: AGENT_PRESETS[harness], cwd, role, modelValue: models[role].modelValue,
      rolePrompt: rolePrompts[role], task, prevContext: prev,
      metrics, renderer,
    });
    metrics.end(role);
    outputs[role] = run.output;
    const t = metrics.totals();
    console.log(`  ${ui.icons.ok} ${ui.paint.bold(role)} concluído ${ui.paint.gray(`(${run.stopReason})`)} — ${ui.paint.dim(`acumulado: ${t.tokensIn} in / ${t.tokensOut} out · $${t.cost.toFixed(4)}`)}`);
    // quadro do lado: issue+status, tokens, valor consumido e comandos — após cada fase
    if (split) refreshUI();
    ui.metricsSidePanel(metrics, models, { issue, status: squadStatus(outputs) });

    // ── Revisão no TERMINAL (sem Lavish): skills.sh locais + remotas ──
    if (role === "planner") {
      const suggestions = review.skillSuggestions(REVIEW_FIND_SKILL, task);
      console.log(`  ${ui.icons.info} skills LOCAIS relevantes à tarefa: ${suggestions.local.map((s) => s.name).join(", ") || "—"}`);
      let approvedSkills = [];
      if (suggestions.remote.length) {
        console.log(`  ${ui.icons.info} skills.sh sugeridas para a tarefa:`);
        for (const s of suggestions.remote) {
          console.log(`      ${ui.paint.dim("·")} ${ui.paint.bold(s.name)} ${ui.paint.gray(`— ${s.source} · ${s.installs} installs · ${s.url}`)}`);
        }
        // instalação por aprovação explícita (uma a uma; auditoria pública antes do add)
        const remaining = [...suggestions.remote];
        const approvedTexts = [];
        while (remaining.length) {
          const opts = [...remaining.map((s) => `${s.name} — ${s.source} · ${s.installs} installs`), "nenhuma — seguir sem instalar"];
          const pick = await input.select("Instalar alguma skill do skills.sh? (auditoria + npx skills add)", opts, opts.length, (i) => opts[i]);
          if (pick === opts.length - 1) break;
          const chosenSkill = remaining.splice(pick, 1)[0];
          approvedTexts.push(`SKILL APROVADA: ${chosenSkill.id}`);
        }
        approvedSkills = review.handleSkillFeedback(approvedTexts, REVIEW_FIND_SKILL);
      } else {
        console.log(`  ${ui.icons.warn} ${ui.paint.yellow("nenhuma sugestão do skills.sh — seguindo só com skills locais")}`);
      }
      const fbPlanner = (await ask("Feedback/dúvidas sobre o plano (vazio = nada a acrescentar)")).trim();
      const feedback = fbPlanner ? [fbPlanner] : [];
      if (feedback.length || approvedSkills.length) {
        outputs.planner += `\n\n=== FEEDBACK DA REVISÃO ===\n${feedback.join("\n")}` +
          (approvedSkills.length ? `\n=== SKILLS INSTALADAS COM APROVAÇÃO ===\n${approvedSkills.join("\n")}` : "");
        console.log(`  ${ui.icons.ok} ${ui.paint.bold(feedback.length)} feedback(s) + ${ui.paint.bold(approvedSkills.length)} skill(s) incorporados ao contexto do builder`);
      }
    }
    if (role === "supervisor") {
      const fb = (await ask("Observações do usuário sobre a auditoria (vazio = encerrar)")).trim();
      if (fb) {
        console.log(`  ${ui.icons.ok} ${ui.paint.bold("1")} observação do usuário na auditoria — repassando ao supervisor…`);
        const extra = await runPhase({
          preset: AGENT_PRESETS[harness], cwd, role: "supervisor", modelValue: models.supervisor?.modelValue,
          rolePrompt: rolePrompts.supervisor, task,
          prevContext: `=== AUDITORIA ANTERIOR ===\n${outputs.supervisor ?? ""}\n\n=== FEEDBACK DO USUÁRIO ===\n${fb}`,
          metrics, renderer,
        });
        outputs.supervisor = extra.output;
        ui.metricsSidePanel(metrics, models, { issue, status: `${squadStatus(outputs)} · revisão aplicada` });
      }
    }
  }

  clearInterval(uiTimer);
  input.setSteering(null);
  screen.exit(); // volta ao buffer principal — o histórico completo fica no scrollback
  console.log("");
  ui.metricsSidePanel(metrics, models, { issue, status: `${squadStatus(outputs)} · concluída` });
  ui.metricsPanel(metrics, models);
  console.log(`\n  ${ui.icons.ok} ${ui.paint.bold("TMR")} ${ui.paint.dim("orquestração concluída")}`);
  input.restore();
  process.exit(0);
}

main().catch((err) => fail(String(err?.stack ?? err), 1));
