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
import * as screen from "./tmr_screen.mjs";

const TTY = process.stdin.isTTY && !process.env.NO_COLOR;

const state = {
  started: false,
  raw: false,
  pending: null,   // { type: "text"|"select"|"confirm", ... }
  steering: null,  // { onLine(text) } — modo livre durante as fases
  line: "",
  closed: false,
  display: null,   // fn(p) — no split screen, prompt/menu renderizam no rodapé da coluna esquerda
};

/** No split screen, prompts/menus renderizam via display fn (rodapé da coluna
 *  ESQUERDA — a direita fica só com o quadro de métricas). fn(null) limpa. */
export function setPromptDisplay(fn) { state.display = fn; }
const show = (p) => { if (state.display) state.display(p); };

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
  // EOF de stdin (pipe fechado): resolve prompts pendentes com o default —
  // evita hang/crash quando a entrada acaba no meio do wizard
  const onEnd = () => {
    state.closed = true;
    const p = state.pending;
    if (p) {
      state.pending = null;
      show(null);
      if (p.type === "select") p.resolve(p.idx);
      else p.resolve(p.def ?? "");
    }
  };
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onEnd);
  process.on("exit", restore);
  process.on("SIGINT", () => { if (screen.isActive()) screen.exit(); restore(); process.exit(130); });
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
  if (key && key.ctrl && key.name === "c") { if (screen.isActive()) screen.exit(); restore(); process.exit(130); }
  const p = state.pending;
  if (p) { handlePending(str, key, p); return; }
  // sem prompt pendente: modo steering (fases) — resto é descartado
  if (state.steering) handleSteering(str, key);
}

// ------------------------------------------------------------------ texto
function handlePending(str, key, p) {
  if (p.type === "select") return handleSelect(str, key, p);
  if (isEnter(key)) {
    const answer = (p.type === "confirm" && !p.line) ? p.def : p.line.trim();
    state.pending = null; state.line = "";
    show(null);
    console.log(`  ${ui.icons.arrow} ${ui.paint.gray(`${p.q ?? ""}:`)} ${ui.paint.bold(answer || p.def || "⏎")}`);
    if (p.type === "confirm") p.resolve(/^(s|si|sim|y|yes)$/i.test(answer || p.def));
    else p.resolve(answer || p.def);
    return;
  }
  if (isBackspace(key)) {
    if (p.line.length) { p.line = p.line.slice(0, -1); if (!state.display) process.stdout.write("\b \b"); else show(refresh(p)); }
    return;
  }
  if (key && key.name === "up" && p.onUp) return p.onUp();
  if (key && key.name === "down" && p.onDown) return p.onDown();
  if (printable(str, key)) {
    p.line += str;
    if (state.display) show(refresh(p));
    else process.stdout.write(str); // echo nosso — sempre visível
  }
}

const refresh = (p) => ({ kind: p.type === "select" ? "select" : p.type, question: p.q ?? "", hint: p.hint ?? "", typed: p.line, menu: p.menu });

// ------------------------------------------------------------------ select
function renderSelect(p) {
  const rows = windowRows(p);
  if (state.display) { show(refresh(p)); return; }
  const lines = rows.length + 4; // pergunta + busca + opções + rodapé
  if (p.rendered) process.stdout.write(`\x1b[${p.rendered}A`);
  p.rendered = lines;
  process.stdout.write(`  ${ui.paint.bold(p.question)}\n`);
  process.stdout.write(`\x1b[2K  ${ui.paint.gray("buscar:")} ${ui.paint.bold(p.search)}${ui.paint.gray("▌")}\n`);
  for (const r of rows) {
    process.stdout.write(`\x1b[2K  ${r.bullet} ${r.label}\n`);
  }
  process.stdout.write(`\x1b[2K  ${ui.paint.gray(p.footer)}\n`);
}

/** Janela deslizante + rodapé de página para o select com busca. */
function windowRows(p) {
  const win = state.display ? 9 : 12;
  const filtered = p.filtered;
  const start = Math.max(0, Math.min(p.fpos - Math.floor(win / 2), filtered.length - win));
  const rows = [];
  for (let i = start; i < Math.min(filtered.length, start + win); i++) {
    const active = i === p.fpos;
    rows.push({
      bullet: active ? ui.paint.brightCyan("❯") : ui.paint.gray(`${filtered[i].i + 1})`),
      label: active ? ui.paint.bold(filtered[i].o) : ui.paint.dim(filtered[i].o),
    });
  }
  if (!rows.length) rows.push({ bullet: ui.paint.gray("∅"), label: ui.paint.gray("nenhum modelo casa com a busca") });
  const pages = Math.max(1, Math.ceil(filtered.length / win));
  const page = Math.min(pages, Math.floor(p.fpos / win) + 1);
  p.footer = `página ${page}/${pages} · ${p.fpos + 1}/${filtered.length} de ${p.options.length} · ↑↓ navega · digite=filtrar · PgUp/PgDn=página`;
  return rows;
}

function applyFilter(p) {
  const q = p.search.toLowerCase();
  p.filtered = p.options.map((o, i) => ({ o, i })).filter((x) => !q || x.o.toLowerCase().includes(q));
  if (p.fpos >= p.filtered.length) p.fpos = Math.max(0, p.filtered.length - 1);
  p.idx = p.filtered[p.fpos]?.i ?? 0;
  p.menu = { search: p.search, window: windowRows(p), footer: p.footer };
}

function handleSelect(str, key, p) {
  if (isEnter(key)) {
    state.pending = null;
    if (state.display) show(null);
    else {
      process.stdout.write(`\x1b[${p.rendered}A\x1b[J`);
      process.stdout.write(`  ${ui.icons.ok} ${ui.paint.dim(p.answerLabel(p.idx))}\n`);
    }
    console.log(`  ${ui.icons.ok} ${ui.paint.gray("escolhido:")} ${ui.paint.bold(p.answerLabel(p.idx))}`);
    p.resolve(p.idx);
    return;
  }
  const last = p.filtered.length - 1;
  if (key && key.name === "up") { p.fpos = p.fpos <= 0 ? last : p.fpos - 1; }
  else if (key && key.name === "down") { p.fpos = p.fpos >= last ? 0 : p.fpos + 1; }
  else if (key && key.name === "pageup") { p.fpos = Math.max(0, p.fpos - 12); }
  else if (key && key.name === "pagedown") { p.fpos = Math.min(last, p.fpos + 12); }
  else if (isBackspace(key)) { p.search = p.search.slice(0, -1); p.fpos = 0; }
  else if (printable(str, key)) { p.search += str; p.fpos = 0; }
  else if (key && key.name === "escape") {
    if (p.search) { p.search = ""; p.fpos = 0; } // esc limpa a busca; não mata o processo
    else return;
  } else return;
  applyFilter(p);
  renderSelect(p);
}

// ------------------------------------------------------------------ API
export function ask(question, def = "") {
  enable();
  return new Promise((resolve) => {
    const p = { type: "text", def, line: "", resolve, q: question, hint: def ? `enter = ${def}` : "" };
    state.pending = p;
    if (state.display) show(refresh(p));
    else process.stdout.write(`  ${question}${def ? ui.paint.gray(` [${def}]`) : ""}: `);
  });
}

export function confirm(question, def = "n") {
  enable();
  return new Promise((resolve) => {
    const p = { type: "confirm", def, line: "", resolve, q: question, hint: def === "s" ? "S/n — enter = sim" : "s/N — enter = não" };
    state.pending = p;
    if (state.display) show(refresh(p));
    else process.stdout.write(`  ${question} ${ui.paint.gray(def === "s" ? "(S/n)" : "(s/N)")}: `);
  });
}

/** select(question, options, defaultIdx1Based, answerLabelFn) → índice 0-based */
export function select(question, options, defaultIdx1 = 1, answerLabel = (i) => options[i]) {
  enable();
  return new Promise((resolve) => {
    const p = { type: "select", question, options, search: "", fpos: Math.min(Math.max(defaultIdx1 - 1, 0), options.length - 1), idx: 0, filtered: null, menu: null, footer: "", resolve, answerLabel, q: question, hint: "↑↓ navega · digite para filtrar · enter escolhe" };

    state.pending = p;
    applyFilter(p);
    renderSelect(p);
  });
}

// ------------------------------------------------------------------ steering (fases)
/** Modo livre: enquanto ativo, o que o usuário digita vai para onLine no Enter.
 *  No split screen o eco vai para a caixa TMR (via display fn) — nunca direto
 *  no stdout, que corromperia o alt screen. */
export function setSteering(onLine) { state.steering = onLine ? { onLine, line: "" } : null; }

const steerRefresh = (s) => ({ kind: "steering", question: "", hint: "enter envia ao agente em curso", typed: s.line ?? "" });

function handleSteering(str, key) {
  const s = state.steering;
  if (s.line == null) s.line = "";
  if (isEnter(key)) {
    const t = s.line.trim();
    s.line = "";
    if (state.display) show(steerRefresh(s));
    else process.stdout.write("\n");
    if (t && !/^(s|si|sim|y|yes|n|nao|não|no)$/i.test(t)) s.onLine(t);
    return;
  }
  if (isBackspace(key)) {
    if (s.line.length) { s.line = s.line.slice(0, -1); if (!state.display) process.stdout.write("\b \b"); else show(steerRefresh(s)); }
    return;
  }
  if (printable(str, key)) {
    s.line += str;
    if (state.display) show(steerRefresh(s));
    else process.stdout.write(str);
  }
}

/** Info do prompt pendente (para render de status no console HTML, se preciso). */
export function isBusy() { return state.pending !== null; }
