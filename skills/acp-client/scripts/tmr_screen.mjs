/**
 * tmr_screen.mjs — console TMR no terminal (alternate screen ANSI, zero deps).
 * Replica o protótipo web "TMR · Console ACP":
 *
 *   ┌ HERO (largura toda): TMR. · CENTRO DE OPERAÇÕES · PROTOCOLO ACP V.01 ┐
 *   ├ ESQUERDA: painel "Processos" (tabela) + painel "Logs dos agentes"   ┤
 *   └ DIREITA: "Issue em foco" · "Uso e custos" · "Rastreamento de
 *     agentes" · "Comandos e skills" — painéis independentes enquadrados ┘
 *
 * Prompts do TMR (escolha de modelo, confirms, issue) abrem como DIALOG
 * centralizado sobre o dashboard — como os dialogs do protótipo. Steering
 * aparece no rodapé do painel de logs.
 *
 * Fallback: activate() retorna false fora de TTY, com NO_COLOR ou terminal
 * estreito (< 80 colunas) — o orquestrador usa o comportamento legado.
 */
import * as ui from "./tmr_ui.mjs";

const MIN_COLS = 80;

const state = {
  active: false,
  rows: 24,
  cols: 80,
  leftW: 60,
  rightW: 48,
  left: [],          // linhas de log (já decoradas com hora/kind/agente)
  pending: "",       // chunk sem \n
  hero: null,        // { issue, harness }
  runs: [],          // [{ id, title, agent, status, dur }]
  side: [],          // [{ title, lines }]
  tag: "",           // agente corrente (coluna AGENTE do log)
  prompt: null,      // dialog TMR ativo (ou {kind:"steering"} no rodapé)
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
    if (!/[\u0300-\u036f]/.test(str[i])) vis += 1;
    i += 1;
  }
  return out;
}

const cell = (s, w) => { const c = clipAnsi(s ?? "", w); return c + " ".repeat(Math.max(0, w - visLen(c))); };

export function isActive() { return state.active; }

export function activate() {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  const rows = process.stdout.rows || Number(process.env.LINES) || 24;
  if (!process.stdout.isTTY || process.env.NO_COLOR || cols < MIN_COLS) return false;
  state.cols = cols;
  state.rows = rows;
  resizeCols();
  process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + cursor off
  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || state.cols;
    state.rows = process.stdout.rows || state.rows;
    resizeCols();
    state.dirty = true;
  });
  state.active = true;
  ui.setSpinnersQuiet(true);
  scheduleRender();
  return true;
}

function resizeCols() {
  const total = state.cols - 3; // gutter ┊
  state.rightW = Math.min(50, Math.max(34, Math.floor(total * 0.34)));
  state.leftW = Math.max(30, total - state.rightW);
}

const mark = () => { state.dirty = true; scheduleRender(); };

/** Linha de log crua → formato do protótipo: hora | kind | agente | mensagem. */
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
function decorate(text) {
  const t = String(text);
  const kind = /✘|⚠|falha|falhou|interrompid|erro/i.test(t) ? ui.paint.yellow("AVISO ")
    : /▸|🔑|⟐|rtk|codegraph/i.test(t) ? ui.paint.brightBlue("TOOL  ")
    : ui.paint.gray("INFO  ");
  return `${ui.paint.gray(stamp())} ${kind} ${ui.paint.gray((state.tag || "squad").padEnd(8))} ${t}`;
}

export function log(text) {
  if (!state.active) { process.stdout.write(text + "\n"); return; }
  const parts = String(text).split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) { state.left.push(decorate(state.pending + parts[i])); state.pending = ""; }
    else state.pending += parts[i].replace(/\r/g, "");
  }
  if (state.pending.includes("\r")) {
    const segs = state.pending.split("\r");
    for (const s of segs.slice(0, -1)) if (s) state.left.push(decorate(s));
    state.pending = segs[segs.length - 1];
  }
  if (state.left.length > 20_000) state.left.splice(0, state.left.length - 20_000);
  mark();
}

export function setHero(data) { state.hero = data ?? null; mark(); }
export function setRuns(rows) { state.runs = rows ?? []; mark(); }
export function setSide(panels) { state.side = panels ?? []; mark(); }
export function setTag(tag) { state.tag = String(tag ?? ""); }

/** Dialog TMR ativo (null limpa). kind "steering" vai para o rodapé dos logs. */
export function setPrompt(p) { state.prompt = p; mark(); }

function scheduleRender() {
  if (state.timer || !state.active) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.dirty) render();
  }, 120);
}

// ------------------------------------------------------------------ render
function render() {
  if (!state.active) return;
  state.dirty = false;
  const visible = state.rows;
  const hero = buildHero(state.cols);
  const heroH = Math.min(hero.length, visible);
  const dash = Math.max(4, visible - heroH);
  const left = buildLeft(dash);
  const right = buildRight(dash);
  const rows = [];
  for (let r = 0; r < heroH; r++) rows.push(clipAnsi(hero[r] ?? "", state.cols) + "\x1b[K");
  for (let r = 0; r < dash; r++) {
    const l = left[r] ?? "";
    const rLine = right[r] ?? "";
    rows.push(l + " ".repeat(Math.max(0, state.leftW - visLen(l))) + ui.paint.gray(" ┊ ") + rLine + "\x1b[K");
  }
  const dialog = buildDialog();
  process.stdout.write(dialog ? overlay(rows, dialog, visible) : "\x1b[H\x1b[J" + rows.slice(0, visible).join("\n") + "\x1b[H");
}

/** Dialog centrado sobre o dashboard (como os dialogs do protótipo). */
function overlay(baseRows, modal, visible) {
  const rows = baseRows.slice(0, visible);
  const top = Math.max(0, Math.floor((visible - modal.length) / 2));
  const mw = visLen(modal[0] ?? "");
  const padL = Math.max(0, Math.floor((state.cols - mw) / 2));
  for (let i = 0; i < modal.length && top + i < visible; i++) {
    rows[top + i] = " ".repeat(padL) + modal[i];
  }
  return "\x1b[H\x1b[J" + rows.join("\n") + "\x1b[H";
}

// ------------------------------------------------------------------ hero
const TMR_BANNER = [
  "████████ ██████   ██████ ██████",
  "   ██    ██   ██ ██      ██   ██",
  "   ██    ██████  ██      ██████  ·  CONSOLE ACP",
  "   ██    ██   ██  ██████ ██   ██",
];

function frame(lines, w, border) {
  const rows = [border("┌" + "─".repeat(w - 2) + "┐")];
  for (const l of lines) {
    const c = clipAnsi(l, w - 4);
    rows.push(border("│") + "  " + c + " ".repeat(Math.max(0, w - 4 - visLen(c))) + "  " + border("│"));
  }
  rows.push(border("└" + "─".repeat(w - 2) + "┘"));
  return rows;
}

function buildHero(w) {
  const h = state.hero ?? {};
  const lime = ui.paint.brightGreen;
  const inner = [];
  const kicker = lime("⚡ CENTRO DE OPERAÇÕES");
  const tech = ui.paint.gray("[ PROTOCOLO ACP ]  V.01");
  inner.push(kicker + " ".repeat(Math.max(1, w - 6 - visLen(kicker) - visLen(tech))) + tech);
  if (state.rows >= 24) {
    for (const [i, b] of TMR_BANNER.entries()) inner.push(lime(b) + (i === 0 ? lime(".") : ""));
  } else {
    inner.push(ui.paint.bold("TMR") + lime("."));
  }
  const sub = `Orquestre e acompanhe seus agentes em tempo real` +
    (h.harness ? ` · harness: ${h.harness}` : "") +
    (h.issue ? ` · issue #${h.issue.number ?? "manual"}` : "");
  inner.push(ui.paint.gray(sub));
  return frame(inner, w, lime);
}

// ------------------------------------------------------------------ esquerda
const BADGES = {
  running: ["●", "Em execução", (s) => ui.paint.brightGreen(s)],
  completed: ["●", "Concluído", (s) => ui.paint.green(s)],
  queued: ["○", "Na fila", (s) => ui.paint.gray(s)],
  failed: ["●", "Falhou", (s) => ui.paint.red(s)],
};
const badge = (status) => {
  const [dot, label, color] = BADGES[status] ?? BADGES.queued;
  return color(`${dot} ${label}`);
};

function runsPanel(w) {
  const cExec = Math.max(16, Math.floor(w * 0.34));
  const cAgent = Math.max(12, Math.floor(w * 0.28));
  const cStatus = 14;
  const rows = [];
  rows.push(ui.paint.gray(cell("EXECUÇÃO", cExec) + cell("AGENTE", cAgent) + cell("STATUS", cStatus) + "DURAÇÃO"));
  if (!state.runs.length) rows.push(ui.paint.gray("Nenhuma execução."));
  for (const r of state.runs) {
    rows.push(
      cell(`#${r.id} ${r.title}`, cExec) +
      cell(r.agent ?? "—", cAgent) +
      cell(badge(r.status ?? "queued"), cStatus) +
      ui.paint.gray(r.dur ?? "—")
    );
  }
  return panelBlock(w, "Processos", rows, String(state.runs.length));
}

function logsPanel(w, h) {
  const rows = [];
  const bodyH = Math.max(1, h - 3);
  const start = Math.max(0, state.left.length - bodyH);
  for (let r = 0; r < bodyH; r++) rows.push(state.left[start + r] ?? "");
  const p = state.prompt;
  const footer = p?.kind === "steering"
    ? `${ui.paint.brightGreen("▸ ")}${ui.paint.bold(p.typed ?? "")}${ui.paint.gray("▌")} ${ui.paint.gray("— enter envia ao agente em curso")}`
    : ui.paint.gray(`ao vivo · agente: ${state.tag || "—"}`);
  rows.push(footer);
  return panelBlock(w, "Logs dos agentes", rows);
}

function buildLeft(dash) {
  const w = state.leftW;
  const runs = runsPanel(w);
  const logsH = Math.max(4, dash - runs.length);
  const out = [...runs, ...logsPanel(w, logsH)];
  return out.slice(0, dash).map((l) => clipAnsi(l, w));
}

// ------------------------------------------------------------------ direita
function panelBlock(w, title, lines, countBadge = null) {
  const border = ui.paint.gray;
  const head = ` ${title}${countBadge ? `  ${countBadge}` : ""} `;
  const rows = [border("┌─") + ui.paint.bold(head) + border("─".repeat(Math.max(0, w - 4 - visLen(head)))) + border("┐")];
  for (const l of lines) {
    const c = clipAnsi(l ?? "", w - 4);
    rows.push(border("│") + " " + c + " ".repeat(Math.max(0, w - 4 - visLen(c))) + " " + border("│"));
  }
  rows.push(border("└" + "─".repeat(w - 2) + "┘"));
  return rows;
}

function buildRight(dash) {
  const w = state.rightW;
  const out = [];
  state.side.forEach((p, i) => {
    const block = panelBlock(w, p.title, p.lines ?? [], p.badge);
    if (out.length + block.length > dash) return;
    if (i > 0) out.push(""); // separador só ENTRE painéis
    out.push(...block);
  });
  while (out.length < dash) out.push("");
  return out.slice(0, dash).map((l) => clipAnsi(l, w));
}

// ------------------------------------------------------------------ dialog
function buildDialog() {
  const p = state.prompt;
  if (!p || p.kind === "steering") return null;
  const w = Math.min(state.cols - 8, 70);
  const inner = [];
  inner.push(ui.paint.brightGreen("◈ SESSÃO ACP"));
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
  return frame(inner, w, ui.paint.brightGreen);
}

// ------------------------------------------------------------------ saída
/** Sai do alt screen e despeja o log completo no scrollback real. */
export function exit() {
  if (!state.active || state.restored) return;
  state.restored = true;
  state.active = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  process.stdout.write("\x1b[?25h\x1b[?1049l"); // cursor on + volta ao buffer principal
  const dump = [...state.left, state.pending].filter((l) => l !== "");
  process.stdout.write(dump.map((l) => clipAnsi(l, 400) + "\n").join(""));
}
