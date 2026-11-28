#!/usr/bin/env node
/**
 * acp_client.mjs — Client ACP v1 da squad (zero dependências, Node >= 18).
 *
 * A squad (harness → planner → builder → reviewer) é o ACP CLIENT; os harness
 * externos rodam como ACP AGENTS em subprocessos:
 *   - opencode → `opencode acp` (nativo)
 *   - codex    → `npx -y @agentclientprotocol/codex-acp` (adaptador oficial)
 *
 * Uso:
 *   acp_client.mjs --agent opencode --cwd <dir> "implemente a subtask X"
 *   acp_client.mjs --agent codex    --cwd <dir> "implemente a subtask X"
 *   acp_client.mjs --command <bin>  --arg <a> --arg <b> "<prompt>"   # agente custom
 *   acp_client.mjs --agent opencode --session <id> --cwd <dir> "<prompt>"
 *
 * Interação no meio do processo (steering):
 *   - Terminal (stdin TTY): qualquer linha digitada vira mensagem; "stop" cancela
 *     o turno (session/cancel). Mensagens digitadas durante um turno são
 *     enfileiradas e enviadas ao fim do turno (estilo Zed).
 *   - --ui lavish: console HTML aberto via `npx -y lavish-axi` — status ao vivo
 *     do agente + campo de conversa do Lavish como entrada do usuário.
 *
 * Flags principais:
 *   --agent opencode|codex     qual harness iniciar (default: opencode)
 *   --cwd <dir>                diretório da sessão (default: cwd do processo)
 *   --session <id>             retomar sessão existente (session/load)
 *   --model <provider/model>   hint de modelo no session/new
 *   --permission safe|allow-all|ask
 *                              safe (default): allow "read"; edit/delete/move
 *                              dependem de TTY (y/n) ou são rejeitados.
 *                              allow-all: aceita todo allow_*; ask: pergunta sempre.
 *   --ui lavish                console HTML (Lavish) para interação ao vivo
 *   --json                     saída máquina (uma linha JSON por evento)
 *   --no-ensure                pula o bootstrap de dependências
 *   --doctor                   diagnostico das dependências e sai (sem run)
 *   --no-steer                 desliga leitura de stdin (runs não-interativos)
 *
 * Exit: 0 ok · 2 uso inválido · 3 auth_required · 4 falha de transporte/agente
 */
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ensureDeps } from "./ensure_deps.mjs";

const AGENT_PRESETS = {
  opencode: { command: "opencode", args: ["acp"], authHint: "opencode auth login" },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    authHint: "codex login (ou CODEX_PATH=/path/to/codex para usar seu binário)",
  },
};

// ---------------------------------------------------------------- CLI parsing
function parseArgs(argv) {
  const opts = {
    agent: "opencode",
    command: null,
    args: [],
    cwd: process.cwd(),
    session: null,
    model: null,
    mode: null,
    permission: "safe",
    ui: null,
    json: false,
    noEnsure: false,
    doctor: false,
    steer: null, // resolved later: TTY ? terminal : null
    promptParts: [],
  };
  let i = 0;
  const arg = () => {
    if (i >= argv.length) fail("flag sem valor", 2);
    return argv[i++];
  };
  while (i < argv.length) {
    const a = argv[i++];
    switch (a) {
      case "--agent": {
        const v = arg();
        if (!AGENT_PRESETS[v]) fail(`agente desconhecido: ${v} (use ${Object.keys(AGENT_PRESETS).join("|")} ou --command)`, 2);
        opts.agent = v;
        break;
      }
      case "--command": opts.command = arg(); break;
      case "--arg": opts.args.push(arg()); break;
      case "--cwd": opts.cwd = path.resolve(arg()); break;
      case "--session": opts.session = arg(); break;
      case "--model": opts.model = arg(); break;
      case "--mode": opts.mode = arg(); break;
      case "--permission": {
        const v = arg();
        if (!["safe", "allow-all", "ask"].includes(v)) fail(`--permission inválido: ${v}`, 2);
        opts.permission = v;
        break;
      }
      case "--ui": {
        const v = arg();
        if (v !== "lavish") fail(`--ui inválido: ${v} (apenas lavish)`, 2);
        opts.ui = v;
        break;
      }
      case "--json": opts.json = true; break;
      case "--no-ensure": opts.noEnsure = true; break;
      case "--doctor": opts.doctor = true; break;
      case "--no-steer": break; // steer resolve a baixo; flag mantida por compat
      case "--help":
      case "-h":
        console.log(readFileSyncSafe(new URL("./acp_client.mjs", import.meta.url)).match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? "acp_client.mjs");
        process.exit(0);
        break;
      case "--": break;
      default:
        if (a.startsWith("--")) fail(`flag desconhecida: ${a}`, 2);
        opts.promptParts.push(a);
        break;
    }
  }
  // steering: TTY (terminal) ou --ui lavish; nunca em stdin pipeado sem TTY
  opts.steer = opts.ui ?? (process.stdin.isTTY ? "terminal" : null);
  if (!opts.command && !AGENT_PRESETS[opts.agent]) fail("sem agente", 2);
  return opts;
}

function readFileSyncSafe(p) {
  try { return fsSync.readFileSync(p, "utf8"); } catch { return ""; }
}

function fail(msg, code = 1) {
  console.error(`acp_client: ${msg}`);
  process.exit(code);
}

// ------------------------------------------------------------- JSON-RPC/ndjson
export class Rpc {
  constructor(child, { onEvent, onRequest }) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buffer = "";
    this.onEvent = onEvent;   // notification (session/update, etc.)
    this.onRequest = onRequest; // request do agente (fs/*, session/request_permission)
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => process.stderr.write(c)); // logs do agente (stdout é protocolo)
    const close = (error) => {
      this.closed = error;
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
    child.on("error", close);
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      close(new Error(`agente saiu (code=${code} signal=${signal})`));
    });
  }

  #onChunk(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // linha suja nunca derruba o transporte
      if (msg.id === undefined && msg.method) this.onEvent(msg);
      else if (msg.id !== undefined && msg.method) this.#onRequestMsg(msg);
      else if (msg.id !== undefined) this.#onResponse(msg);
    }
  }

  #onResponse(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? "erro ACP"), { acpError: msg.error }));
    else p.resolve(msg.result);
  }

  #onRequestMsg(msg) {
    Promise.resolve(this.onRequest(msg))
      .then((result) => this.#send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }))
      .catch((err) =>
        this.#send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: String(err?.message ?? err) },
        }));
  }

  #send(obj) {
    if (this.child.stdin.destroyed) return false;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  request(method, params, timeoutMs = 0) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`timeout em ${method} (${timeoutMs}ms)`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      if (!this.#send({ jsonrpc: "2.0", id, method, params: params ?? {} })) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error("stdin do agente fechado"));
      }
    });
  }

  notify(method, params) { this.#send({ jsonrpc: "2.0", method, params: params ?? {} }); }
}

// ------------------------------------------------------------------- Renderer
class Renderer {
  constructor(json) {
    this.json = json;
    this.textBuf = "";
    this.thoughtBuf = "";
  }
  emit(obj) {
    if (this.json) console.log(JSON.stringify(obj));
    else this.#human(obj);
  }

  #human(obj) {
    switch (obj.type) {
      case "agent_text":
        process.stdout.write(obj.text);
        break;
      case "thought":
        process.stdout.write(`\n💬 ${obj.text}`);
        break;
      case "tool_call":
        process.stdout.write(`\n  ▸ [${obj.status ?? obj.kind ?? "tool"}] ${obj.title}`);
        if (obj.kind && obj.status) process.stdout.write(` (${obj.kind})`);
        process.stdout.write("\n");
        break;
      case "tool_update":
        process.stdout.write(`  ✔ ${obj.title} → ${obj.status}\n`);
        break;
      case "plan":
        for (const e of obj.entries)
          process.stdout.write(`  ${e.status === "completed" ? "☑" : e.status === "in_progress" ? "▶" : "☐"} ${e.content}\n`);
        break;
      case "mode": process.stdout.write(`\n— modo: ${obj.mode}\n`); break;
      case "permission":
        process.stdout.write(`\n🔑 permissão [${obj.kind ?? "?"}]: ${obj.title} — opção: ${obj.choice}\n`);
        break;
      case "steer":
        process.stdout.write(`\n↪ steering ${obj.action}: ${obj.text}\n`);
        break;
      case "status":
        process.stdout.write(`\n— ${obj.message}\n`);
        break;
      case "result":
        process.stdout.write(`\n■ turno encerrado (${obj.stopReason}) — session: ${obj.sessionId}\n`);
        break;
      default: break;
    }
  }
}

function rendererJsonLog(opts, line) {
  if (opts.json) console.error(line); // log de setup vai a stderr; stdout é evento JSON
  else console.error(line);
}

// ------------------------------------------------------------------ Permissões
const SAFE_KINDS = new Set(["read"]);

async function answerPermission(req, opts, rl) {
  const tc = req.params?.toolCall ?? {};
  const options = req.params?.options ?? [];
  const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
  const reject = options.find((o) => o.kind === "reject_once");
  let choice = null;
  if (opts.permission === "allow-all") choice = allow;
  else if (opts.permission === "safe" && SAFE_KINDS.has(tc.kind ?? "")) choice = allow;
  else if (process.stdin.isTTY && rl) {
    const names = options.map((o) => `${o.optionId ?? o.name}:${o.kind}`).join(", ");
    process.stdout.write(`\n🔑 permissão pedida [${tc.kind ?? "?"}] ${tc.title ?? ""} (${names})\n`);
    const ans = await new Promise((res) => rl.question("permitir? [s/N] ", res));
    if (/^(s|si|sim|y|yes)$/i.test(ans.trim())) choice = allow;
  }
  if (!choice && reject) choice = reject;
  const picked = choice?.optionId ?? choice?.name ?? null;
  return { picked, option: choice };
}

// ------------------------------------------------------------------ FS callbacks
function withinRoots(p, roots, base) {
  // paths relativos resolvem contra o CWD DA SESSÃO, não do processo client
  const abs = path.resolve(base, p);
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

async function handleAgentRequest(req, ctx) {
  const m = req.method;
  if (m === "session/request_permission") {
    const { picked, option } = await answerPermission(req, ctx.opts, ctx.rl);
    ctx.renderer.emit({
      type: "permission",
      kind: req.params?.toolCall?.kind,
      title: req.params?.toolCall?.title,
      choice: option?.kind ?? "none",
    });
    if (!picked) throw new Error("nenhuma opção de permissão disponível");
    return { optionId: picked };
  }
  if (m === "fs/read_text_file") {
    const { path: p, line, limit } = req.params ?? {};
    if (!withinRoots(p, ctx.roots, ctx.opts.cwd)) throw new Error(`fora das raízes permitidas: ${p}`);
    let text = await fs.readFile(path.resolve(ctx.opts.cwd, p), "utf8");
    if (line !== undefined || limit !== undefined) {
      const lines = text.split("\n");
      const start = line !== undefined ? Math.max(0, line - 1) : 0;
      const end = limit !== undefined ? start + limit : lines.length;
      text = lines.slice(start, end).join("\n");
    }
    return { content: text };
  }
  if (m === "fs/write_text_file") {
    const { path: p, content } = req.params ?? {};
    if (!withinRoots(p, ctx.roots, ctx.opts.cwd)) throw new Error(`fora das raízes permitidas: ${p}`);
    if (ctx.opts.permission !== "allow-all" && ctx.opts.permission !== "ask") {
      // safe: escrita via fs só se o turno já liberou edit — conservador: nega
      throw new Error(`escrita negada pela policy '${ctx.opts.permission}': ${p}`);
    }
    await fs.mkdir(path.dirname(path.resolve(ctx.opts.cwd, p)), { recursive: true });
    await fs.writeFile(path.resolve(ctx.opts.cwd, p), content ?? "", "utf8");
    return {};
  }
  if (m.startsWith("terminal/")) throw new Error("terminal não habilitado neste client");
  throw new Error(`método não suportado: ${m}`);
}

// ---------------------------------------------------------------------- Lavish UI
const CONSOLE_CSS = `
  :root { color-scheme: light dark; }
  body { background: #0f1115; color: #e6e6e6; font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
         margin: 0; padding: 2rem; }
  h1 { font-size: 1.1rem; letter-spacing: .02em; margin: 0 0 .3rem; }
  .sub { color: #9aa0aa; font-size: .85rem; margin-bottom: 1.4rem; }
  .log { white-space: pre-wrap; border-left: 3px solid #3b82f6; padding-left: 1rem;
         max-height: 60vh; overflow-y: auto; }
  .log .t { color: #6b7280; }
  .hint { margin-top: 1.6rem; color: #9aa0aa; font-size: .85rem; }
`;

function consoleHtml(state) {
  const { agent, cwd, sessionId, events, prompt } = state;
  const rows = events
    .slice(-200)
    .map((e) => `<div><span class="t">${escapeHtml(e.t)}</span> ${escapeHtml(e.text)}</div>`)
    .join("\n");
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>SDD ACP Console — ${escapeHtml(agent)}</title>
<style>${CONSOLE_CSS}</style>
</head>
<body data-lavish-annotate="off">
  <h1>SDD ACP Console — ${escapeHtml(agent)}</h1>
  <div class="sub">cwd: ${escapeHtml(cwd)}${sessionId ? " · session: " + escapeHtml(sessionId) : ""}</div>
  <div class="log">${rows || "<em>aguardando eventos do agente…</em>"}</div>
  <div class="hint">Digite na <strong>Conversation panel</strong> (chrome do Lavish) para falar com o agente
  no meio do processo — cada mensagem é enfileirada e entregue ao fim do turno atual.
  Prompt em execução: <em>${escapeHtml(prompt)}</em></div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class LavishUi {
  constructor(opts, { agentLabel, render = consoleHtml } = {}) {
    this.file = path.join(os.tmpdir(), `sdd-acp-console-${Date.now()}.html`);
    this.state = { agent: agentLabel, cwd: opts.cwd, sessionId: null, events: [], prompt: "" };
    this.render = render;
    this.lastWrite = 0;
    this.writeTimer = null;
    this.pollChild = null;
  }
  async start() {
    await this.#write(true);
    const open = spawn("npx", ["-y", "lavish-axi", this.file], { stdio: ["ignore", "ignore", "inherit"] });
    await new Promise((res) => open.on("exit", res));
    this.#pollLoop().catch(() => {});
  }
  async #write(immediate = false) {
    const now = Date.now();
    if (!immediate && now - this.lastWrite < 1500) {
      if (!this.writeTimer)
        this.writeTimer = setTimeout(() => { this.writeTimer = null; this.#write(true); }, 1600 - (now - this.lastWrite));
      return;
    }
    this.lastWrite = now;
    await fs.writeFile(this.file, this.render(this.state), "utf8");
  }
  event(text) {
    this.state.events.push({ t: new Date().toLocaleTimeString("pt-BR"), text });
    this.#write();
  }
  /** re-render sem adicionar evento de log (atualiza dashboards) */
  refresh() { this.#write(true); }
  setSession(id) { this.state.sessionId = id; this.#write(true); }
  setPrompt(p) { this.state.prompt = p; this.#write(true); }

  /** Loop supervisado: um `lavish-axi poll` por vez; feedback vira steering. */
  async #pollLoop() {
    for (;;) {
      if (this.stopped) return;
      const feedback = await this.#pollOnce();
      if (!feedback || this.stopped) return;
      if (feedback.ended) { this.event("— sessão Lavish encerrada pelo usuário (Send & End)."); this.stopped = true; return; }
      for (const p of feedback.prompts) this.onFeedback?.(p);
    }
  }
  #pollOnce() {
    return new Promise((resolve) => {
      // reply curto com status e depois long-poll — um child por vez, supervisionado
      const args = ["-y", "lavish-axi", "poll", this.file];
      const child = spawn("npx", args, { stdio: ["ignore", "pipe", "ignore"] });
      this.pollChild = child;
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (out += c));
      child.on("exit", () => {
        this.pollChild = null;
        if (this.stopped) return resolve(null);
        const parsed = parsePollResponse(out);
        if (parsed.status === "browser_disconnected")
          this.event("— aba do Lavish fechada; sessão segue resumível (reabra com lavish-axi se quiser).");
        resolve(parsed);
      });
    });
  }
  async end() {
    this.stopped = true;
    this.pollChild?.kill("SIGTERM");
    try { await fs.unlink(this.file); } catch {}
  }
}

/** Resposta do poll: leniente — extrai prompts/texto de qualquer shape. */
export function parsePollResponse(raw) {
  let data = null;
  try { data = JSON.parse(raw); } catch { /* TOON/linha única */ }
  const status = data?.status ?? (raw.includes("ended") ? "ended" : "feedback");
  const prompts = [];
  const visit = (node, depth = 0) => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    if (typeof node !== "object") return;
    if (typeof node.text === "string" && node.text.trim()) prompts.push({ text: node.text, raw: node });
    else if (typeof node.message === "string" && node.message.trim()) prompts.push({ text: node.message, raw: node });
    else if (typeof node.content === "string" && node.content.trim()) prompts.push({ text: node.content, raw: node });
    else Object.values(node).forEach((v) => visit(v, depth + 1));
  };
  if (data) visit(data.prompts ?? data.feedback ?? data);
  if (!prompts.length && data == null && raw.trim()) prompts.push({ text: raw.trim(), raw: null });
  return { status, prompts, raw: data };
}

// ------------------------------------------------------------------------- main
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // bootstrap de dependências: lavish-axi + codegraph + rtk + opencode
  // (idempotente, instala o que falta; --no-ensure ou ACP_SKIP_ENSURE=1 pula)
  if (opts.doctor) {
    const results = ensureDeps({ doctor: true });
    if (opts.json) console.log(JSON.stringify(results));
    process.exit(results.some((r) => r.required && !r.version) ? 4 : 0);
  }
  if (!opts.noEnsure && !process.env.ACP_SKIP_ENSURE) {
    ensureDeps({ log: (s) => rendererJsonLog(opts, s) });
  }

  if (!withinRoots(opts.cwd, [path.resolve(opts.cwd)])) fail("--cwd inválido", 2);
  const promptText = opts.promptParts.join(" ").trim();
  if (!promptText && !opts.session) fail("informe o prompt (ou --session para retomar)", 2);

  await fs.access(opts.cwd).catch(() => fail(`--cwd não existe: ${opts.cwd}`, 2));

  const preset = opts.command ? { command: opts.command, args: opts.args, authHint: "verifique o login do agente custom" } : AGENT_PRESETS[opts.agent];
  const renderer = new Renderer(opts.json);
  const rl = process.stdin.isTTY && !opts.ui ? readline.createInterface({ input: process.stdin, terminal: true }) : null;

  const ui = opts.ui ? new LavishUi(opts, { agentLabel: opts.command ?? opts.agent }) : null;
  if (ui) ui.onFeedback = (p) => steering.push({ text: p.text, from: "lavish" });

  // fila de steering; items chegam do terminal ou do Lavish
  let steeringSupported = false; // setado pós-initial (openCode: _meta.steering.supported)
  const steerPromises = [];
  const steering = {
    queue: [],
    turnActive: false,
    cancelled: false,
    push(item) {
      renderer.emit({ type: "steer", action: "enfileirado", text: item.text.slice(0, 200), from: item.from });
      ui?.event(`↪ mensagem do usuário enfileirada: ${item.text.slice(0, 120)}`);
      // steering nativo (openCode anuncia _meta.steering.supported): entra no meio do turno
      if (steeringSupported && this.turnActive) {
        renderer.emit({ type: "steer", action: "enviado (steering nativo, no meio do turno)", text: item.text.slice(0, 200) });
        ui?.event(`↪ steering imediato: ${item.text.slice(0, 120)}`);
        steerPromises.push(
          rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: item.text }] })
            .then((r) => renderer.emit({ type: "result", sessionId, stopReason: r?.stopReason ?? "steer_end" }))
            .catch((e) => {
              if (!this.cancelled) {
                this.queue.push(item);
                renderer.emit({ type: "status", message: `envio imediato falhou (${e.message}); mensagem na fila para o próximo turno` });
              }
            })
        );
        return;
      }
      this.queue.push(item);
      // sem turno ativo → dispara já (fora do fluxo do prompt em curso)
      if (!this.turnActive) this.flush?.();
    },
  };

  const roots = [path.resolve(opts.cwd)];

  let child;
  try {
    child = spawn(preset.command, preset.args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    fail(`não consegui iniciar o agente (${preset.command}): ${err.message}`, 4);
  }

  const ctx = { opts, rl, roots, renderer };
  const rpc = new Rpc(child, {
    onEvent: (msg) => handleNotification(msg, renderer, ui),
    onRequest: (msg) => handleAgentRequest(msg, ctx),
  });

  renderer.emit({ type: "status", message: `iniciando agente: ${preset.command} ${preset.args.join(" ")}` });
  ui?.event(`▶ agente iniciado: ${preset.command}`);

  // 1) initialize
  let init;
  try {
    init = await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true, readDirectory: true }, terminal: false },
    }, 60_000);
  } catch (err) {
    if (err.acpError?.code === -32003 || /auth/i.test(err.message)) {
      console.error(`acp_client: agente pediu autenticação (${err.message}).`);
      console.error(`acp_client: rode antes: ${preset.authHint}`);
      process.exit(3);
    }
    fail(`initialize falhou: ${err.message}`, 4);
  }
  steeringSupported = Boolean(init?._meta?.steering?.supported);

  // 2) session/new ou session/load
  let sessionId;
  try {
    if (opts.session) {
      const loaded = await rpc.request("session/load", { sessionId: opts.session, cwd: opts.cwd, mcpServers: [] }, 120_000);
      sessionId = loaded?.sessionId ?? opts.session;
      renderer.emit({ type: "status", message: `sessão retomada: ${sessionId}` });
    } else {
      const params = { cwd: opts.cwd, mcpServers: [] };
      if (opts.mode) params.mode = opts.mode;
      if (opts.model) params.model = opts.model;
      const info = await rpc.request("session/new", params, 120_000);
      sessionId = info?.sessionId;
      renderer.emit({ type: "status", message: `sessão criada: ${sessionId}` });
    }
  } catch (err) {
    fail(`session/new|load falhou: ${err.message}`, 4);
  }
  ui?.setSession(sessionId);

  // 3) turn loop: prompt → fim do turno → flush de steering → próximo prompt
  steering.flush = async () => {
    if (!steering.queue.length) return;
    const batch = steering.queue.splice(0).map((s) => s.text).join("\n\n");
    renderer.emit({ type: "steer", action: "enviado", text: batch.slice(0, 200) });
    await runTurn(batch);
  };

  async function runTurn(text) {
    steering.turnActive = true;
    ui?.setPrompt(text.slice(0, 160));
    ui?.event(`▶ prompt enviado: ${text.slice(0, 160)}`);
    let stopReason = null;
    try {
      const res = await rpc.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      stopReason = res?.stopReason ?? "end_turn";
    } catch (err) {
      if (err.acpError?.code === -32003 || /auth/i.test(err.message)) {
        console.error(`acp_client: autenticação exigida. rode: ${preset.authHint}`);
        process.exit(3);
      }
      renderer.emit({ type: "status", message: `prompt falhou: ${err.message}` });
      stopReason = "error";
    }
    steering.turnActive = false;
    ui?.event(`■ turno encerrado (${stopReason})`);
    renderer.emit({ type: "result", sessionId, stopReason });
  }

  // entrada do terminal (se TTY)
  if (rl) {
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      if (t === "stop" || t === "/stop") {
        steering.cancelled = true;
        rpc.notify("session/cancel", { sessionId });
        renderer.emit({ type: "steer", action: "cancelamento enviado", text: "session/cancel" });
        return;
      }
      steering.push({ text: t, from: "terminal" });
    });
    rl.prompt?.();
    process.stdout.write("\n> digite para falar com o agente no meio do processo (ou 'stop' para cancelar)\n");
  }

  if (ui) await ui.start();

  // primeiro turno
  await runTurn(promptText);

  // esvazia fila (mensagens que chegaram durante o turno)
  await steering.flush();
  // espera steering nativo em voo e esvazia o que chegou enquanto isso
  await Promise.allSettled(steerPromises);
  await steering.flush();

  // fim: encerra UI e agente
  if (ui) await ui.end();
  try { rpc.notify("session/cancel", { sessionId }); } catch {}
  child.stdin?.end();
  const exited = await new Promise((res) => {
    if (child.exitCode !== null || child.signalCode) return res(null);
    child.on("exit", () => res(null));
    setTimeout(() => { child.kill("SIGTERM"); res(null); }, 3000);
  });
  process.exit(0);
}

// ------------------------------------------------------------- notificações ACP
export function handleNotification(msg, renderer, ui) {
  if (msg.method !== "session/update") return;
  const u = msg.params?.update ?? {};
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const t = blockText(u.content);
      if (t) { renderer.emit({ type: "agent_text", text: t }); ui?.event(`agente: ${t}`); }
      break;
    }
    case "agent_thought_chunk": {
      const t = blockText(u.content);
      if (t) renderer.emit({ type: "thought", text: t });
      break;
    }
    case "tool_call": {
      renderer.emit({ type: "tool_call", title: u.title, kind: u.kind, status: u.status });
      ui?.event(`▸ ${u.status ?? ""} ${u.title ?? ""}`);
      break;
    }
    case "tool_call_update": {
      if (u.status && u.status !== "in_progress")
        renderer.emit({ type: "tool_update", title: u.title ?? "(tool)", status: u.status });
      break;
    }
    case "plan": {
      const entries = (u.entries ?? []).map((e) => ({ content: e.content, status: e.status }));
      renderer.emit({ type: "plan", entries });
      ui?.event(`plano: ${entries.filter((e) => e.status === "in_progress").map((e) => e.content).join(", ") || (entries.at(-1)?.content ?? "")}`);
      break;
    }
    case "current_mode_update":
      renderer.emit({ type: "mode", mode: u.currentModeId });
      break;
    default:
      break; // available_commands_update, user_message_chunk, config_option_update… ignorados
  }
}

function blockText(block) {
  if (!block) return "";
  if (typeof block === "string") return block;
  if (block.type === "text") return block.text ?? "";
  if (block.type === "resource_link") return `[${block.name ?? block.uri ?? ""}](${block.uri ?? ""})`;
  if (block.type === "image") return "[imagem]";
  if (block.type === "audio") return "[áudio]";
  if (block.type === "resource") return block.resource?.text ?? `[recurso ${block.resource?.uri ?? ""}]`;
  return "";
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((err) => fail(String(err?.stack ?? err), 1));
}
