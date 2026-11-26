/**
 * tmr_screen.mjs — layout split ao vivo do TMR (alternate screen ANSI, zero
 * dependências). Simples e fixo:
 *
 *   ┌ TOPO-ESQUERDA: caixa TMR — escolhas/prompts, evidente o processo TODO ┐
 *   ├ BAIXO-ESQUERDA: processo e logs dos agentes (rolando)                 ┤
 *   └ DIREITA: quadro de métricas enquadrado, centralizado verticalmente    ┘
 *
 * - enter(): entra no buffer alternativo, esconde cursor, liga o render loop
 *   coalescido (~120ms).
 * - log(text): append no buffer de logs (suporta chunks sem \n; \r vira quebra).
 * - setRight(lines): conteúdo do quadro direito (linhas SEM borda — a moldura
 *   e o centralizador vertical são do render). SÓ métricas, nunca escolhas.
 * - setPrompt({question, typed, hint, menu}): prompt TMR ativo aparece dentro
 *   da caixa TMR no topo; sem prompt, a caixa fica compacta (idle/steering).
 * - exit(): restaura o terminal principal, despeja TODO o log no scrollback real.
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
  const visible = state.rows;
  const gutter = ui.paint.gray(" ┊ ");
  const rightBlock = buildRightBlock(); // exatamente `visible` linhas

  // coluna esquerda: CAIXA TMR no topo (sempre presente) + logs embaixo
  const tmrBlock = buildTmrBlock();
  const H = Math.min(tmrBlock.length, Math.max(3, visible - 3)); // deixa ≥3 linhas de log
  const leftRows = [...tmrBlock.slice(0, H)];
  const logAvail = Math.max(1, visible - H);
  const logStart = Math.max(0, state.left.length - logAvail);
  for (let r = 0; r < logAvail; r++) {
    leftRows.push(clipAnsi(state.left[logStart + r] ?? "", state.leftW).replace(/\t/g, "  "));
  }

  const rows = [];
  for (let r = 0; r < visible; r++) {
    const l = clipAnsi(leftRows[r] ?? "", state.leftW);
    const rLine = rightBlock[r] ?? "";
    const padL = " ".repeat(Math.max(0, state.leftW - visLen(l)));
    const padR = " ".repeat(Math.max(0, state.rightW - visLen(rLine)));
    rows.push(l + padL + gutter + rLine + padR + "\x1b[K");
  }
  process.stdout.write("\x1b[H\x1b[J" + rows.join("\n") + "\x1b[H");
}

/** Caixa TMR no TOPO da coluna esquerda — presente durante TODO o processo.
 *  Com prompt ativo: pergunta, digitação, menu e rodapé dentro dela.
 *  Sem prompt: compacta, mostra o estado (idle ou steering). */
function buildTmrBlock() {
  const w = state.leftW;
  const innerW = w - 4;
  const border = ui.paint.boldMagenta;
  const p = state.prompt;
  const inner = [];
  if (p && p.kind === "steering") {
    inner.push(`${ui.paint.boldMagenta("◈ TMR · steering")} ${ui.paint.gray("— enter envia ao agente em curso")}`);
    inner.push(p.typed ? `${ui.paint.gray("▸ ")}${ui.paint.bold(p.typed)}${ui.paint.gray("▌")}` : `${ui.paint.gray("▸ ▌")}`);
  } else if (p) {
    inner.push(`${ui.paint.boldMagenta("◈ TMR")} ${ui.paint.brightCyan("· aguardando você")}`);
    for (const ql of String(p.question ?? "").split("\n")) inner.push(ui.paint.bold(ql));
    if (p.hint) inner.push(ui.paint.gray(p.hint));
    if (p.kind === "select" && p.menu) {
      // payload do tmr_input: {search, window:[{bullet,label}], footer}
      if (p.menu.search) inner.push(`${ui.paint.gray("buscar:")} ${ui.paint.bold(p.menu.search)}${ui.paint.gray("▌")}`);
      for (const r of p.menu.window ?? []) inner.push(`${r.bullet} ${r.label}`);
      if (p.menu.footer) inner.push(ui.paint.gray(p.menu.footer));
    } else if (p.kind === "text" || p.kind === "confirm") {
      inner.push(p.typed ? `${ui.paint.gray("▸ ")}${ui.paint.bold(p.typed)}${ui.paint.gray("▌")}` : `${ui.paint.gray("▸ ▌")}`);
    }
  } else {
    inner.push(`${ui.paint.boldMagenta("◈ TMR")} ${ui.paint.gray("— processo em curso · digite para steering ao agente")}`);
  }
  const rows = [border("┌" + "─".repeat(w - 2) + "┐")];
  const maxInner = Math.max(2, Math.floor(state.rows * 0.6) - 2);
  for (const l of inner.slice(0, maxInner)) {
    const c = clipAnsi(l, innerW);
    rows.push(border("│") + "  " + c + " ".repeat(Math.max(0, innerW - visLen(c))) + "  " + border("│"));
  }
  rows.push(border("└" + "─".repeat(w - 2) + "┘"));
  return rows;
}

/** Quadro de métricas: moldura completa ┌─┐/│/└─┘ em torno do conteúdo de
 *  setRight (linhas sem borda) e centralização VERTICAL na coluna direita. */
function buildRightBlock() {
  const w = state.rightW;
  const row = (s) => s + " ".repeat(Math.max(0, w - visLen(s)));
  const border = ui.paint.brightBlue;
  const innerW = w - 6;
  const inner = (state.right ?? []).map((l) => clipAnsi(l, innerW));
  const topPad = Math.max(0, Math.floor((visibleRows() - inner.length - 2) / 2));
  const out = [];
  for (let i = 0; i < topPad; i++) out.push("");
  out.push(border("┌" + "─".repeat(w - 2) + "┐"));
  for (const l of inner) {
    out.push(border("│") + "  " + l + " ".repeat(Math.max(0, innerW - visLen(l))) + "  " + border("│"));
  }
  out.push(border("└" + "─".repeat(w - 2) + "┘"));
  return out.slice(0, visibleRows()).map(row);
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
