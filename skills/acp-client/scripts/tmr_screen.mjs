/**
 * tmr_screen.mjs — layout split ao vivo do TMR: logs dos agentes à ESQUERDA,
 * quadro de métricas fixo à DIREITA, durante todo o processo (alternate screen
 * ANSI, zero dependências).
 *
 * - enter(): entra no buffer alternativo, esconde cursor, liga o render loop
 *   coalescido (~120ms) — cada linha da tela = log esquerdo (clipado) + gutter
 *   + linha do quadro direito.
 * - log(text): append no buffer esquerdo (suporta chunks sem \n — buffer de
 *   linha parcial; \r isolado vira quebra).
 * - setRight(lines): substitui o quadro direito (array de linhas com ANSI).
 * - setPrompt({question, typed, hint, menu}): quando um prompt TMR está ativo,
 *   o topo da coluna direita mostra a pergunta/estado (menus ↑↓ renderizam aí).
 * - exit(): restaura o terminal principal, despeja TODO o log esquerdo no
 *   scrollback real e devolve o cursor.
 *
 * Fallback: activate() retorna false fora de TTY, com NO_COLOR ou terminal
 * estreito (< 80 colunas) — o orquestrador usa o comportamento legado.
 */
import * as ui from "./tmr_ui.mjs";

const RIGHT_W = 48;
const MIN_COLS = 80;

const state = {
  active: false,
  rows: 24,
  cols: 80,
  leftW: 40,
  left: [],          // linhas do log (com ANSI)
  pending: "",       // chunk sem \n
  right: [],
  prompt: null,      // {question, typed, hint, menu:{options, idx}}
  timer: null,
  dirty: false,
  restored: false,
};

const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;

/** clipa a string em `width` colunas visíveis preservando códigos ANSI. */
function clipAnsi(s, width) {
  let out = "", vis = 0, i = 0;
  const str = String(s);
  while (i < str.length && vis < width) {
    if (str[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += str[i];
    if (!/[\u0300-\u036f]/.test(str[i])) vis += 1; // combining marks não ocupam coluna
    i += 1;
  }
  return out;
}

export function isActive() { return state.active; }

export function activate() {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  const rows = process.stdout.rows || Number(process.env.LINES) || 24;
  if (!process.stdout.isTTY || process.env.NO_COLOR || cols < MIN_COLS) return false;
  state.cols = cols;
  state.rows = rows;
  state.rightW = cols >= 110 ? RIGHT_W : 38;
  state.leftW = Math.max(24, cols - state.rightW - 3);
  process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + cursor off
  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || state.cols;
    state.rows = process.stdout.rows || state.rows;
    state.rightW = state.cols >= 110 ? RIGHT_W : 38;
    state.leftW = Math.max(24, state.cols - state.rightW - 3);
    state.dirty = true;
  });
  state.active = true;
  ui.setSpinnersQuiet(true);
  scheduleRender();
  return true;
}

export function log(text) {
  if (!state.active) { process.stdout.write(text + "\n"); return; }
  const parts = String(text).split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) { state.left.push(state.pending + parts[i]); state.pending = ""; }
    else state.pending += parts[i].replace(/\r/g, "");
  }
  if (state.pending.includes("\r")) { // progresso estilo \r vira linha nova
    const segs = state.pending.split("\r");
    for (let i = 0; i < segs.length - 1; i++) if (segs[i]) state.left.push(segs[i]);
    state.pending = segs[segs.length - 1];
  }
  if (state.left.length > 20_000) state.left.splice(0, state.left.length - 20_000);
  state.dirty = true;
  scheduleRender();
}

export function setRight(lines) {
  if (!state.active) return;
  state.right = lines ?? [];
  state.dirty = true;
  scheduleRender();
}

/** Prompt TMR ativo: pergunta/echo/menu aparecem no topo da coluna direita. */
export function setPrompt(p) {
  if (!state.active) return;
  state.prompt = p; // null limpa
  state.dirty = true;
  scheduleRender();
}

function scheduleRender() {
  if (state.timer || !state.active) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.dirty) render();
  }, 120);
}

function render() {
  if (!state.active) return;
  state.dirty = false;
  const rows = [];
  const visible = state.rows;
  const gutter = ui.paint.gray(" ┊ ");
  const rightBlock = buildRightBlock();
  const leftStart = Math.max(0, state.left.length - visible);
  for (let r = 0; r < visible; r++) {
    const l = clipAnsi(state.left[leftStart + r] ?? "", state.leftW).replace(/\t/g, "  ");
    const rLine = rightBlock[r] ?? "";
    const padL = " ".repeat(Math.max(0, state.leftW - visLen(l)));
    const padR = " ".repeat(Math.max(0, state.rightW - visLen(rLine)));
    rows.push(l + padL + gutter + rLine + padR + "\x1b[K");
  }
  process.stdout.write("\x1b[H\x1b[J" + rows.join("\n") + "\x1b[H");
}

function buildRightBlock() {
  const out = [];
  const w = state.rightW;
  const row = (s) => s + " ".repeat(Math.max(0, w - visLen(s)));
  const border = ui.paint.brightBlue;
  const bar = border("┌" + "─".repeat(w - 2) + "┐");
  const mid = (s) => border("│") + " " + s + " ".repeat(Math.max(0, w - 3 - visLen(s))) + border("│");
  const bottom = border("└" + "─".repeat(w - 2) + "┘");
  const p = state.prompt;
  if (p) {
    out.push(mid(ui.paint.boldMagenta("PROMPT TMR")));
    if (p.question) {
      for (const ql of String(p.question).split("\n")) out.push(mid(clipAnsi(ql, w - 4)));
    }
    if (p.hint) out.push(mid(ui.paint.gray(clipAnsi(p.hint, w - 4))));
    if (p.kind === "select" && p.menu) {
      // payload novo do tmr_input: {search, window:[{bullet,label}], footer}
      if (p.menu.search) out.push(mid(`${ui.paint.gray("buscar:")} ${ui.paint.bold(clipAnsi(p.menu.search, w - 12))}${ui.paint.gray("▌")}`));
      for (const r of p.menu.window ?? []) {
        out.push(mid(`${r.bullet} ${clipAnsi(r.label, w - 6)}`));
      }
      if (p.menu.footer) out.push(mid(ui.paint.gray(clipAnsi(p.menu.footer, w - 4))));
    } else if (p.kind === "text" || p.kind === "confirm") {
      out.push(mid(p.typed ? ui.paint.bold(clipAnsi(p.typed, w - 4)) : ui.paint.gray("⌷")));
    }
    out.push(bottom);
  }
  for (const l of state.right.slice(0, Math.max(0, visibleRows() - out.length))) out.push(l);
  return out.slice(0, visibleRows()).map((l) => row(clipAnsi(l, w)));
}

function visibleRows() { return state.rows; }

/** Sai do alt screen e despeja o log completo no scrollback real. */
export function exit() {
  if (!state.active || state.restored) return;
  state.restored = true;
  state.active = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  process.stdout.write("\x1b[?25h\x1b[?1049l"); // cursor on + volta ao buffer principal
  // despejo: histórico completo fica no scrollback do terminal
  const dump = [...state.left, state.pending].filter((l) => l !== "");
  process.stdout.write(dump.map((l) => clipAnsi(l, 400) + "\n").join(""));
  process.stdout.write("");
}
