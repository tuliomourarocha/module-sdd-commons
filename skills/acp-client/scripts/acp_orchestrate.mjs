#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Rpc, handleNotification } from "./acp_client.mjs";
import { ensureDeps } from "./ensure_deps.mjs";
import { loadModelPools, modelPricing, rankModels, chooseVariant, loadDefaults } from "../../../bin/lib/model-picker.js";
import { mergeAvailableModels, modelDisplayName } from "./tmr_models.mjs";
import * as ui from "./tmr_ui.mjs";
import * as input from "./tmr_web_input.mjs";
import * as review from "./tmr_review.mjs";
import { serveTmr } from "./tmr_web.mjs";
import { editDetails, observeFiles, prepareTools, toolOutput } from "./tmr_tools.mjs";
import { observeRtk } from "./tmr_rtk.mjs";
import { SessionUsage, summarizeUsage } from "./tmr_usage.mjs";

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

const fail = (msg, code = 1) => { console.error(`acp_orchestrate: ${msg}`); process.exitCode = code; throw new Error(msg); };
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const ask = input.ask;
const askYN = input.confirm;

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
    child.on("error", (error) => { console.error(error.message); resolve(1); });
    child.on("close", (code) => resolve(code));
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
  if (!(await askYN("Apagar estes arquivos de .planning/?", "n", files.join("\n")))) { console.log("(mantidos)"); return false; }
  for (const f of files) await fs.rm(path.join(dir, f), { force: true });
  console.log(`✓ .planning/ limpo (${files.length} arquivos)`);
  return true;
}

// ------------------------------------------------------------------- issue gh
const execOut = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 20, timeout: 20_000 });
  return r.status === 0 ? r.stdout : null;
};

async function fetchIssue(input, cwd) {
  let m = input.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/);
  if (!m) m = input.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m && /^#?\d+$/.test(input.trim())) {
    const num = input.trim().replace("#", "");
    const url = execOut("git", ["-C", cwd, "remote", "get-url", "origin"], cwd)?.trim();
    const repo = url?.match(/[:/]([\w.-]+)\/([\w.-]+?)(\.git)?$/)?.slice(1, 3).join("/");
    if (!repo) return null;
    m = [null, ...repo.split("/"), num];
  }
  if (!m) return null;
  const [, owner, repo, num] = m;
  const out = execOut("gh", ["issue", "view", num, "-R", `${owner}/${repo}`, "--json", "number,title,body,labels,url"], cwd);
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
  if (forcedModel) return modelPricing(harness, forcedModel);
  const platform = AGENT_PRESETS[harness].platform;
  const pools = await loadModelPools([platform]);
  const pool = pools[platform] ?? [];
  let defaults = null;
  try { defaults = await loadDefaults(SOURCE_ROOT); } catch {}

  const roleDefault = platform === "opencode" ? defaults?.opencode?.[role] : defaults?.codex?.[role];
  const ranked = rankModels(pool, platform, role, roleDefault);
  if (!ranked.length && !available?.length) {
    console.error(`(sem modelos no pool de ${platform} — usando default do papel)`);
    return { modelValue: roleDefault?.model ?? roleDefault ?? "", label: String(roleDefault?.model ?? roleDefault ?? "default"), input: null, output: null };
  }
  // disponíveis no harness: filtra o pool ranqueado; modelos fora do catálogo
  // de preços entram no fim com "custo desconhecido" — a lista é a COMPLETA
  // de disponíveis, estável por run (sondada uma vez, nunca re-cresce)
  const ranked_all = mergeAvailableModels(ranked, available);
  const options = ranked_all.map((e, i) => {
    const varHint = e.input != null ? chooseVariant(e, role, roleDefault?.variant ?? null) : null;
    const rec = i === 0 ? `${ui.icons.star} ` : "";
    return `${rec}${modelDisplayName(e)}  ${priceOf(e)}  ctx ${fmtCtx(e.context)}${varHint ? ` · var ${varHint}` : ""}`;
  });
  const idx = await input.select(
    `Modelo para o agente ${role.toUpperCase()} — ${ranked_all.length} disponíveis no ${harness} (ordenado por qualidade × custo)`,
    options,
    1,
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
    this.phases = new Map(ROLES.map((r) => [r, { sessions: [], skills: new Map(), hooks: new Map(), cmds: new Map() }]));
    this.times = new Map(); // role -> { startedAt, endedAt }
  }
  phase(role) { return this.phases.get(role); }
  start(role) { if (!this.times.get(role)) this.times.set(role, { startedAt: Date.now() }); }
  end(role) { const t = this.times.get(role); if (t && !t.endedAt) t.endedAt = Date.now(); }
  duration(role) {
    const t = this.times.get(role);
    if (!t?.startedAt) return "—";
    const s = Math.max(0, Math.floor(((t.endedAt ?? Date.now()) - t.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  scanToolOutput(role, text) {
    if (!text) return;
    const p = this.phase(role);
    for (const m of text.matchAll(MARK_SKILL)) bump(p.skills, m[1]);
    for (const m of text.matchAll(MARK_HOOK)) bump(p.hooks, m[1]);
    if (/⟐\s*codegraph ✓/.test(text)) bump(p.cmds, "codegraph");
  }
  addTool(role, title) {
    if (!title) return;
    const p = this.phase(role);
    const first = String(title).trim().split(/\s+/).slice(0, 2).join(" ");
    if (CMD_RE.test(first)) bump(p.cmds, first);
  }
  totals() {
    const sessions = [];
    const skills = new Map(), hooks = new Map(), cmds = new Map();
    for (const [, p] of this.phases) {
      sessions.push(...p.sessions);
      for (const [k, v] of p.skills) bump(skills, k, v);
      for (const [k, v] of p.hooks) bump(hooks, k, v);
      for (const [k, v] of p.cmds) bump(cmds, k, v);
    }
    return { ...summarizeUsage(sessions), skills, hooks, cmds };
  }
}

const phaseText = new Map();
const steeringQueue = [];
const tools = new Map();

// ------------------------------------------------------------------- run de fase via ACP
async function runPhase({ preset, cwd, role, model, rolePrompt, task, prevContext, metrics, renderer, mcpServer }) {
  const toolCalls = new Map();
  const uniqueSession = tools.size;
  const modelValue = model.modelValue;
  const usage = new SessionUsage();
  metrics.phase(role).sessions.push(usage);
  let rtkCalls = 0;
  const warn = (message) => input.log("warn", message);
  const audit = observeRtk(({ status, command }) => {
    rtkCalls++;
    bump(metrics.phase(role).cmds, `RTK · ${status}`);
    const marker = status === "reescrito" ? "⟐ rtk ✓" : "⟐ rtk";
    input.log(status === "falhou" ? "warn" : "tool", `${marker} · ${status} · ${command}`);
  }, warn);
  const files = await observeFiles(cwd, (message) => input.log("file", message));
  const child = spawn(preset.command, preset.args, { cwd, env: audit?.env, stdio: ["pipe", "pipe", "pipe"] });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
    console.error(error.message);
  });
  child.stdin.on("error", () => {});
  let sessionId;
  const rpc = new Rpc(child, {
    onEvent: (msg) => {
      handleNotification(msg, { emit: (o) => renderer.emit(o) });
      const u = msg.params?.update ?? {};
      if (u.sessionUpdate === "usage_update" && msg.params.sessionId === sessionId && !u._meta?.["opencode/child-session"]) {
        usage.update(u);
      }
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const previous = toolCalls.get(u.toolCallId);
        const tool = { ...previous, ...u };
        toolCalls.set(u.toolCallId, tool);
        const key = `${uniqueSession}:${role}:${u.toolCallId}`;
        const rawCommand = tool.rawInput?.command;
        const title = typeof rawCommand === "string" ? rawCommand : tool.title ?? "Ferramenta ACP";
        if (u.toolCallId) tools.set(key, { title, role, status: tool.status ?? "pending" });
        if (u.sessionUpdate === "tool_call") {
          metrics.addTool(role, title);
          if (title !== u.title) input.log("tool", title);
        }
        if (tool.status === "completed") {
          for (const [file, action] of editDetails(tool)) files.log(file, action);
          if (tool.name === "skill") {
            const skill = tool.rawInput?.name ?? tool.rawInput?.id ?? tool.rawInput?.skill;
            if (typeof skill === "string" && /^[\w.@/-]+$/.test(skill)) bump(metrics.phase(role).skills, skill);
          }
          if (/(?:^|[_./\s])codegraph(?:[_./\s]|$)/i.test(`${tool.name ?? ""} ${title}`)) bump(metrics.phase(role).cmds, "CodeGraph · consulta ACP");
        }
        // ACP pode fornecer marcadores nas partes de saída, separados do título.
        const output = toolOutput(u, tool.status);
        metrics.scanToolOutput(role, output);
      }
    },
    onRequest: async (req) => {
      const m = req.method;
      if (m === "session/request_permission") {
        const options = req.params?.options ?? [];
        const allow = options.find((o) => o.kind === "allow_once");
        const reject = options.find((o) => o.kind === "reject_once");
        const tool = req.params?.toolCall ?? {};
        const kind = tool.kind ?? "ACP";
        const title = tool.title ?? "Ferramenta ACP";
        const details = [title, ...(tool.locations ?? []).map(({ path }) => path)];
        const approved = allow && (kind === "read" || await askYN(`Permitir ferramenta · ${kind}?`, "n", details.join("\n")));
        const chosen = approved ? allow : reject;
        renderer.emit({ type: "permission", kind, title, choice: approved ? "permitida" : "recusada" });
        return { outcome: chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" } };
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
        files.log(p, "Gravado");
        return {};
      }
      throw new Error(`método não suportado: ${m}`);
    },
  });

  try {
    const init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    }, 60_000).catch((e) => {
      if (e.acpError?.code === -32003 || /auth/i.test(e.message)) fail(`harness pediu auth — rode: ${preset.authHint}`, 3);
      fail(`initialize falhou: ${e.message}`, 4);
    });
    const steeringSupported = Boolean(init?._meta?.steering?.supported);

    const newParams = { cwd, mcpServers: [mcpServer] };
    if (modelValue) newParams.model = modelValue;
    const info = await rpc.request("session/new", newParams, 120_000).catch((error) => {
      if (error.acpError?.code === -32000 || /auth/i.test(error.message)) fail(`Harness requer autenticação. Execute ${preset.authHint}.`, 3);
      throw error;
    });
    sessionId = info?.sessionId;
    if (!sessionId) throw new Error("O harness não abriu uma sessão ACP.");
    const modelOption = info.configOptions?.find((option) => option.category === "model" && option.type === "select");
    if (modelOption && modelValue && modelOption.currentValue !== modelValue) {
      await rpc.request("session/set_config_option", { sessionId, configId: modelOption.id, value: modelValue }, 30_000);
    } else if (!modelOption && info.models && modelValue && info.models.currentModelId !== modelValue) {
      await rpc.request("session/set_model", { sessionId, modelId: modelValue }, 30_000);
    }
    const activeModel = modelValue || modelOption?.currentValue || info.models?.currentModelId;
    const pricing = activeModel && activeModel !== modelValue ? await modelPricing(preset.platform, activeModel) : model;

    let stopRequested = false;
    let resolveStopped;
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });
    input.setStopPhase(() => {
      if (stopRequested) return;
      stopRequested = true;
      steeringQueue.length = 0;
      try { rpc.notify("session/cancel", { sessionId }); } catch {}
      console.log("Parando agente; a fase poderá ser iniciada novamente.");
      resolveStopped({ stopReason: "cancelled" });
    });
    const steerInFlight = [];
    input.setSteering((t) => {
      if (steeringSupported) {
        steerInFlight.push(
          rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] })
            .then((r) => usage.addTurn(r?.usage, pricing, { steering: true }))
            .catch((error) => {
              if (!stopRequested) {
                steeringQueue.push(t);
                console.error(`Envio imediato falhou (${error.message}); mensagem na fila para o próximo turno.`);
              }
            }));
      } else {
        steeringQueue.push(t);
        console.log("Mensagem na fila para o próximo turno.");
      }
    });

    const prompt = [rolePrompt, task, prevContext].filter(Boolean).join("\n\n");
    const res = await Promise.race([stopped, rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    }).catch((e) => {
      if (e.acpError?.code === -32003 || /auth/i.test(e.message)) fail(`auth exigida — rode: ${preset.authHint}`, 3);
      throw e;
    })]);
    input.setSteering(null);
    if (stopRequested) {
      phaseText.set(role, "");
      return { stopReason: "cancelled", output: "" };
    }
    usage.addTurn(res?.usage, pricing);

    // steering não-nativo (fila) ou pós-turno: entrega o resto como turno extra
    await Promise.allSettled(steerInFlight);
    const leftover = steeringQueue.splice(0);
    if (leftover.length) {
      const res2 = await rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: leftover.join("\n\n") }],
      });
      usage.addTurn(res2?.usage, pricing);
    }

    const finalText = phaseText.get(role) ?? "";
    phaseText.set(role, "");

    return { stopReason: res?.stopReason ?? "error", output: finalText };
  } catch (error) {
    throw spawnError ?? error;
  } finally {
    input.setStopPhase(null);
    input.setSteering(null);
    if (sessionId) { try { rpc.notify("session/cancel", { sessionId }); } catch {} }
    child.stdin?.end();
    child.kill();
    try { audit?.close(); } catch (error) { warn(`Falha ao concluir o log do RTK · ${error.message}`); }
    const shellCalls = [...toolCalls.values()].filter((tool) => tool.status === "completed" &&
      (tool.kind === "execute" && typeof tool.rawInput?.command === "string" ||
        /^(?:bash|shell|exec_command|unifiedExec)$/.test(tool.name ?? ""))).length;
    if (audit && rtkCalls < shellCalls) {
      warn("Há comandos de shell no ACP sem registro do RTK. Confira se o hook nativo está carregado e autorizado.");
    }
    await files.stop();
  }
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
      `\n\nFERRAMENTAS DA SQUAD: comece a exploração de código e impacto pelo MCP codegraph (codegraph_explore). Nos comandos shell, use o hook nativo do RTK para reescrita automática; os hooks determinísticos da squad (⟐ hook ✓) rodam nas edições. Use-os quando fizer sentido — eles alimentam as métricas da orquestração.`;
  } catch {
    return `Você é o macro ${role.toUpperCase()} da squad SDD. Retorne === ${role.toUpperCase()} === no fim da resposta.`;
  }
}

function reportSetupTool(title, status) {
  tools.set(`setup:${title}`, { title, kind: "Comando", status });
  input.send({ type: "state", data: { tools: [...tools.values()] } });
  if (status === "running") input.log("tool", title);
  else input.log(status === "failed" ? "warn" : "tool", `${title} · ${status === "failed" ? "falhou" : "concluído"}`);
}

function makeRenderer(role) {
  return {
    emit(obj) {
      if (obj.type === "agent_text") {
        phaseText.set(role, (phaseText.get(role) ?? "") + obj.text);
        input.log("info", obj.text, true);
      } else if (obj.type === "tool_call") {
        input.log("tool", obj.title ?? "Ferramenta ACP");
      } else if (obj.type === "tool_update" && obj.status === "failed") {
        input.log("warn", `Falha em ${obj.title}`);
      } else if (obj.type === "plan") {
        for (const e of obj.entries) input.log("info", `${e.status} · ${e.content}`);
      } else if (obj.type === "permission") {
        input.log("tool", `${obj.title} · ${obj.choice}`);
      }
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const cwd = process.cwd();
  const forcedModel = flag("--model");

  let saved = await input.receiveResume();
  if (saved && !(await askYN("Retomar a execução anterior?", "s", `Issue: ${saved.issue?.title ?? "—"}\nO contexto está disponível enquanto este servidor permanecer aberto.`))) {
    input.send({ type: "clear_checkpoint" });
    saved = null;
  }
  let harness = saved?.harness ?? flag("--agent");
  if (!harness) {
    const options = ["OpenCode · ACP nativo", "Codex · adaptador oficial"];
    harness = ["opencode", "codex"][await input.select("Escolha o harness", options, 1)];
  }
  if (!Object.hasOwn(AGENT_PRESETS, harness)) fail(`Harness desconhecido: ${harness}`, 2);
  input.send({ type: "state", data: { harness } });
  if (!argv.includes("--no-ensure") && process.env.ACP_SKIP_ENSURE !== "1") {
    ensureDeps({ inherit: false, exclude: ["lavish-axi", ...(harness === "codex" ? ["opencode"] : [])],
      log: (message) => input.log(/falhou|NÃO instalado|não iniciou|aviso:/i.test(message) ? "warn" : "info", message) });
  }

  const available = forcedModel ? null : probeAvailableModels(harness);
  if (!saved) {
    await installArtifacts(cwd, harness);
    await maybeCleanPlanning(cwd);
  }

  let issue = saved?.issue;
  while (!issue) {
    const link = await ask("Issue do GitHub", { hint: "Link da issue, organização/repo#123 ou #123", required: true });
    while (spawnSync("gh", ["auth", "status"], { cwd, stdio: "ignore", timeout: 20_000 }).status !== 0) {
      if (!(await askYN("GitHub CLI requer autenticação. Verificar novamente?", "n", "Execute gh auth login, depois volte a esta página."))) return "cancelled";
    }
    issue = await fetchIssue(link, cwd);
    if (!issue) console.error("Issue indisponível. Confira o link e o acesso ao repositório.");
  }

  input.send({ type: "state", data: { issue } });
  const integrations = await prepareTools({ harness, cwd, ask: askYN, onTool: reportSetupTool });
  if (!integrations) return "cancelled";
  const semanticContext = saved?.semanticContext ?? (await integrations.semanticContext(issue.title)).slice(0, 10000);
  const outputs = saved?.outputs ?? {};
  const models = saved?.models ?? {};
  const statuses = Object.fromEntries(ROLES.map((role) => [role, saved?.statuses?.[role] === "completed" ? "completed" : "queued"]));
  const checkpoint = () => input.send({ type: "checkpoint", data: { harness, issue, semanticContext, outputs, models, statuses } });
  checkpoint();
  const metrics = new Metrics();
  const publish = () => {
    const totals = metrics.totals();
    const session = metrics.phase(input.role())?.sessions.at(-1);
    input.send({ type: "state", data: {
      issue, stages: ROLES.map((role) => ({ role, status: statuses[role], model: models[role]?.label, duration: metrics.duration(role) })),
      tokens: totals.tokens, cost: totals.cost, costEstimated: totals.costEstimated, costPartial: totals.costPartial,
      contextUsed: session?.contextUsed ?? null, contextSize: session?.contextSize ?? null,
      tools: [...[...tools].filter(([key]) => key.startsWith("setup:")).map(([, tool]) => tool),
        ...[...tools].filter(([key]) => !key.startsWith("setup:")).slice(-20).map(([, tool]) => tool)],
      skills: [...totals.skills.keys()], hooks: [...totals.hooks.keys()], commands: [...totals.cmds.keys()],
    } });
  };
  const timer = setInterval(publish, 600);
  const task = `Tarefa (issue #${issue.number} — ${issue.url}):\n${issue.title}\n\n${issue.body}${semanticContext ? `\n\n=== CONTEXTO DO CODEGRAPH ===\n${semanticContext}` : ""}`;
  publish();
  try {
    for (const role of ROLES) {
      if (statuses[role] === "completed") continue;
      input.setRole(role);
      statuses[role] = "waiting";
      publish();
      if (!(await askYN(`Iniciar o agente ${role}?`, "s", ROLE_DESC[role]))) return "cancelled";
      models[role] = await pickModelForRole(harness, role, forcedModel, available);
      const rolePrompt = await rolePromptFor(role);
      const prevContext = Object.entries(outputs).map(([name, output]) => `=== CONTEXTO · ${name.toUpperCase()} ===\n${output}`).join("\n\n");
      const run = (context) => runPhase({
        preset: AGENT_PRESETS[harness], cwd, role, model: models[role],
        rolePrompt, task, prevContext: context, metrics, renderer: makeRenderer(role), mcpServer: integrations.mcpServer,
      });
      statuses[role] = "running";
      metrics.start(role);
      publish();
      const runWithRestart = async (context) => {
        let result = await run(context);
        while (result.stopReason === "cancelled") {
          phaseText.set(role, "");
          statuses[role] = "waiting";
          checkpoint();
          publish();
          if (!(await askYN(`Reiniciar o agente ${role}?`, "s", "O agente interrompido será iniciado novamente com o contexto das etapas concluídas."))) return null;
          statuses[role] = "running";
          publish();
          result = await run(context);
        }
        return result;
      };
      const result = await runWithRestart(prevContext);
      if (!result) return "cancelled";
      if (!["end_turn", "max_tokens"].includes(result.stopReason)) throw new Error(`${role}: ${result.stopReason}`);
      outputs[role] = result.output;

      if (role === "planner" || role === "supervisor") {
        statuses[role] = "waiting";
        publish();
        const suggestions = role === "planner" ? review.skillSuggestions(REVIEW_FIND_SKILL, task) : null;
        const feedback = await input.review(role === "planner" ? "Revisar plano" : "Revisar auditoria", result.output, suggestions);
        if (role === "planner") {
          const selected = suggestions.remote.filter((_, index) => feedback.skills.includes(index));
          const installed = review.handleSkillFeedback(selected.map((skill) => `SKILL APROVADA: ${skill.id}`), REVIEW_FIND_SKILL, console.log, cwd);
          if (feedback.text) outputs.planner += `\n\n=== FEEDBACK DA REVISÃO ===\n${feedback.text}`;
          if (installed.length) outputs.planner += `\n\n=== SKILLS INSTALADAS COM APROVAÇÃO ===\n${installed.join("\n")}`;
        } else if (feedback.text) {
          statuses[role] = "running";
          publish();
          const extra = await runWithRestart(`${prevContext}\n\n=== AUDITORIA ANTERIOR ===\n${outputs.supervisor}\n\n=== FEEDBACK DO USUÁRIO ===\n${feedback.text}`);
          if (!extra) return "cancelled";
          if (!["end_turn", "max_tokens"].includes(extra.stopReason)) throw new Error(`${role}: ${extra.stopReason}`);
          outputs[role] = extra.output;
        }
      }
      metrics.end(role);
      statuses[role] = "completed";
      checkpoint();
      publish();
    }
    input.send({ type: "clear_checkpoint" });
    return "completed";
  } catch (error) {
    if (input.role()) {
      statuses[input.role()] = "failed";
      metrics.end(input.role());
    }
    throw error;
  } finally {
    clearInterval(timer);
    publish();
  }
}

if (process.send) {
  input.connect();
  try {
    input.send({ type: "finish", status: await main() });
  } catch (error) {
    input.log("warn", error.message);
    input.send({ type: "finish", status: "failed" });
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
} else {
  await serveTmr(process.argv.slice(2));
}
