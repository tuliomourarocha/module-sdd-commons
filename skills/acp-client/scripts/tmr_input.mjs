/**
 * tmr_input.mjs — camada de input TMR: interação fluida e dinâmica no terminal.
 *
 * Raw mode + keypress próprios (sem depender do readline), com echo controlado:
 *  - ask(texto)     → digitação com feedback ao vivo (sempre visível), Enter envia
 *  - confirm(s/N)   → 'y'/'n' resolvem na hora, Enter usa o default
 *  - select(menu)   → setas ↑↓ + números + Enter com highlight que se move
 *  - steering       → modo livre durante as fases (digita, Enter envia ao agente)
 *
 * Perguntas pendentes têm precedência sobre o steering; teclas digitadas fora
 * de um prompt (durante spawns bloqueantes) são descartadas — nada vaza.
 * Fora de TTY (pipe/script) funciona igual: os bytes chegam como keypresses.
 */
import readline from "node:readline";
import * as ui from "./tmr_ui.mjs";

const TTY = process.stdin.isTTY && !process.env.NO_COLOR;

const state = {
  started: false,
  raw: false,
  pending: null,   // { type: "text"|"select"|"confirm", ... }
  steering: null,  // { onLine(text) } — modo livre durante as fases
  line: "",
  closed: false,
};

function enable() {
  if (state.started) return;
  state.started = true;
  readline.emitKeypressEvents(process.stdin);
  if (TTY && typeof process.stdin.setRawMode === "function" && !process.stdin.isRaw) {
    process.stdin.setRawMode(true);
    state.raw = true;
  }
  process.stdin.resume();
  process.stdin.on("keypress", onKeypress);
  process.on("exit", restore);
  process.on("SIGINT", () => { restore(); process.exit(130); });
}

export function restore() {
  if (state.raw && typeof process.stdin.setRawMode === "function") {
    try { process.stdin.setRawMode(false); } catch {}
    state.raw = false;
  }
}

const isEnter = (key) => key && (key.name === "return" || key.name === "enter");
const isBackspace = (key) => key && (key.name === "backspace");
const printable = (str, key) => str && str.length === 1 && str >= " " && !key?.ctrl && !key?.meta;

function onKeypress(str, key) {
  if (state.closed) return;
  if (key && key.ctrl && key.name === "c") { restore(); process.exit(130); }
  const p = state.pending;
  if (p) { handlePending(str, key, p); return; }
  // sem prompt pendente: modo steering (fases) — resto é descartado
  if (state.steering) handleSteering(str, key);
}

// ------------------------------------------------------------------ texto
function handlePending(str, key, p) {
  if (p.type === "select") return handleSelect(str, key, p);
  if (isEnter(key)) {
    process.stdout.write("\n");
    const answer = (p.type === "confirm" && !p.line) ? p.def : p.line.trim();
    state.pending = null; state.line = "";
    if (p.type === "confirm") p.resolve(/^(s|si|sim|y|yes)$/i.test(answer || p.def));
    else p.resolve(answer || p.def);
    return;
  }
  if (isBackspace(key)) {
    if (p.line.length) { p.line = p.line.slice(0, -1); process.stdout.write("\b \b"); }
    return;
  }
  if (key && key.name === "up" && p.onUp) return p.onUp();
  if (key && key.name === "down" && p.onDown) return p.onDown();
  if (printable(str, key)) {
    p.line += str;
    process.stdout.write(str); // echo nosso — sempre visível
  }
}

// ------------------------------------------------------------------ select
function renderSelect(p) {
  const lines = p.options.length + 1;
  if (p.rendered) process.stdout.write(`\x1b[${lines}A`);
  p.rendered = true;
  process.stdout.write(`  ${ui.paint.bold(p.question)}\n`);
  p.options.forEach((opt, i) => {
    const active = i === p.idx;
    const bullet = active ? ui.paint.brightCyan("❯") : ui.paint.gray(i === 9 ? ")" : String(i + 1) + ")");
    const label = active ? ui.paint.bold(opt) : ui.paint.dim(opt);
    process.stdout.write(`\x1b[2K  ${bullet} ${label}\n`);
  });
}

function handleSelect(str, key, p) {
  const last = p.options.length - 1;
  if (isEnter(key)) {
    state.pending = null;
    process.stdout.write(`\x1b[${p.options.length}A\x1b[J`); // limpa o menu, fica a resposta
    process.stdout.write(`  ${ui.icons.ok} ${ui.paint.dim(p.answerLabel(p.idx))}\n`);
    p.resolve(p.idx);
    return;
  }
  if (key && key.name === "up") { p.idx = p.idx === 0 ? last : p.idx - 1; renderSelect(p); return; }
  if (key && key.name === "down") { p.idx = p.idx === last ? 0 : p.idx + 1; renderSelect(p); return; }
  if (printable(str, key) && str >= "1" && str <= "9") {
    const n = Number(str) - 1;
    if (n <= last) { p.idx = n; renderSelect(p); }
    return;
  }
  if (key && key.name === "escape") { restore(); process.exit(130); }
}

// ------------------------------------------------------------------ API
export function ask(question, def = "") {
  enable();
  return new Promise((resolve) => {
    process.stdout.write(`  ${question}${def ? ui.paint.gray(` [${def}]`) : ""}: `);
    state.pending = { type: "text", def, line: "", resolve };
  });
}

export function confirm(question, def = "n") {
  enable();
  return new Promise((resolve) => {
    process.stdout.write(`  ${question} ${ui.paint.gray(def === "s" ? "(S/n)" : "(s/N)")}: `);
    state.pending = { type: "confirm", def, line: "", resolve };
  });
}

/** select(question, options, defaultIdx1Based, answerLabelFn) → índice 0-based */
export function select(question, options, defaultIdx1 = 1, answerLabel = (i) => options[i]) {
  enable();
  return new Promise((resolve) => {
    const p = { type: "select", question, options, idx: Math.min(Math.max(defaultIdx1 - 1, 0), options.length - 1), resolve, answerLabel };
    state.pending = p;
    renderSelect(p);
  });
}

// ------------------------------------------------------------------ steering (fases)
/** Modo livre: enquanto ativo, o que o usuário digita vai para onLine no Enter. */
export function setSteering(onLine) { state.steering = onLine ? { onLine } : null; }

function handleSteering(str, key) {
  const s = state.steering;
  if (isEnter(key)) {
    const t = s.line.trim();
    s.line = "";
    process.stdout.write("\n");
    if (t && !/^(s|si|sim|y|yes|n|nao|não|no)$/i.test(t)) s.onLine(t);
    return;
  }
  if (isBackspace(key)) { if (s.line.length) { s.line = s.line.slice(0, -1); process.stdout.write("\b \b"); } return; }
  if (printable(str, key)) { s.line += str; process.stdout.write(str); }
}

/** Info do prompt pendente (para render de status no console HTML, se preciso). */
export function isBusy() { return state.pending !== null; }
