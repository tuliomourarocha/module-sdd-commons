/**
 * tmr_ui.mjs — identidade visual TMR para a interface ACP no terminal.
 * Zero dependências: ANSI 256/truecolor-safe, box-drawing, spinner, menus e
 * painéis. Respeita NO_COLOR e degrada para plain text fora de TTY.
 */

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const SUPPORTS_256 = TTY; // praticamente todo terminal moderno; degrada p/ plain

const c = (code, s) => (SUPPORTS_256 ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const paint = {
  bold: (s) => c("1", s),
  dim: (s) => c("2", s),
  red: (s) => c("31", s),
  green: (s) => c("32", s),
  yellow: (s) => c("33", s),
  blue: (s) => c("34", s),
  magenta: (s) => c("35", s),
  cyan: (s) => c("36", s),
  white: (s) => c("37", s),
  gray: (s) => c("90", s),
  brightCyan: (s) => c("96", s),
  brightBlue: (s) => c("94", s),
  brightGreen: (s) => c("92", s),
  brightYellow: (s) => c("93", s),
  boldCyan: (s) => c("1;36", s),
  boldMagenta: (s) => c("1;35", s),
  boldGreen: (s) => c("1;32", s),
  boldYellow: (s) => c("1;33", s),
};

export const icons = {
  ok: paint.green("✔"),
  fail: paint.red("✘"),
  run: paint.cyan("▸"),
  star: paint.brightYellow("★"),
  warn: paint.yellow("⚠"),
  arrow: paint.gray("❯"),
  dot: paint.gray("·"),
  agent: paint.magenta("◆"),
  info: paint.blue("ℹ"),
};

// --------------------------------------------------------------- banner TMR
// Fonte "ANSI Shadow" (figlet) — letterforms claras, com cor por letra.
const TMR_ART = [
  ["████████╗", "███╗   ███╗", "██████╗ "],
  ["╚══██╔══╝", "████╗ ████║", "██╔══██╗"],
  ["   ██║   ", "██╔█████╔██║", "██████╔╝"],
  ["   ██║   ", "██║╚██╔╝██║", "██╔══██╗"],
  ["   ██║   ", "██║ ╚═╝ ██║", "██║  ██║"],
  ["   ╚═╝   ", "╚═╝     ╚═╝", "╚═╝  ╚═╝"],
];
const LETTER_COLORS = [paint.brightCyan, paint.boldMagenta, paint.boldGreen];

export function banner(subtitle = "ACP — Squad Orchestrator") {
  for (const row of TMR_ART) {
    console.log("  " + row.map((seg, col) => LETTER_COLORS[col](seg)).join(" "));
  }
  console.log("");
  console.log(`  ${paint.gray("─".repeat(46))}`);
  console.log(`  ${paint.bold("TMR")} ${paint.gray("·")} ${paint.dim(subtitle)}`);
  console.log(`  ${paint.gray("planner → builder → reviewer")} ${paint.gray("sobre Agent Client Protocol")}`);
  console.log("");
}

// ------------------------------------------------------------------- helpers
export const hr = (ch = "─", n = 58) => paint.gray(ch.repeat(n));
export const boxLine = (label, rest = "") =>
  `  ${paint.gray("│")} ${paint.bold(label)}  ${paint.dim(rest)}`;

export function panel(title, lines) {
  console.log(`\n  ${paint.gray("┌─")} ${paint.bold(title)} ${paint.gray("─".repeat(Math.max(2, 46 - title.length)))}`);
  for (const l of lines) console.log(`  ${paint.gray("│")} ${l}`);
  console.log(`  ${paint.gray("└" + "─".repeat(52))}`);
}

export function stepHeader(step, total, title) {
  const dots = ["○", "◐", "◑", "◕", "●"];
  const nums = Array.from({ length: total }, (_, i) =>
    i + 1 < step ? paint.green(dots[4]) : i + 1 === step ? paint.brightCyan(`❯${step}❮`) : paint.gray(dots[0]));
  console.log(`\n  ${nums.join(" ")}  ${paint.bold(title)}`);
}

export function phaseHeader(role, modelValue, priceStr = "") {
  console.log("");
  console.log(`  ${hr()}`);
  console.log(`  ${icons.agent} ${paint.boldMagenta(`FASE ${role.toUpperCase()}`)}  ${paint.gray("·")}  ${paint.dim(modelValue)}${priceStr ? `  ${paint.gray("·")}  ${paint.dim(priceStr)}` : ""}`);
  console.log(`  ${hr()}`);
}

// -------------------------------------------------------------------- spinner
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let spinnersQuiet = false;
export function setSpinnersQuiet(v) { spinnersQuiet = v; }

export function spinner(text) {
  if (!TTY || spinnersQuiet) {
    // modo silencioso (split screen): sem animação \r — linhas no log esquerdo
    return {
      stop: (finalText, color) => console.log(`  ${(color ?? paint.green)("✔")} ${finalText ?? text}`),
      update: () => {},
    };
  }
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${paint.cyan(SPIN_FRAMES[i++ % SPIN_FRAMES.length])} ${paint.dim(text)}   `);
  }, 90);
  return {
    stop(finalText, color = paint.green) {
      clearInterval(t);
      process.stdout.write(`\r\x1b[K  ${color("✔")} ${finalText ?? text}\n`);
    },
    update(newText) { text = newText; },
  };
}

// ---------------------------------------------------------------------- menus
export function menu(title, rows, { defaultIdx = 1 } = {}) {
  panel(title, rows);
  return defaultIdx;
}

export function promptLabel(q, def = "") {
  process.stdout.write(`  ${icons.arrow} ${paint.bold(q)}${def ? paint.gray(` [${def}]`) : ""}: `);
}

export function confirmLabel(q) {
  process.stdout.write(`  ${icons.arrow} ${paint.bold(q)} ${paint.gray("(s/N)")}: `);
}

// ------------------------------------------------------------------- métricas
const fmtNum = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export function metricsPanel(metrics, models) {  const t = metrics.totals();
  const rows = [];
  const W = [10, 30, 9, 9, 10];
  const cell = (s, w, align = "left") => {
    s = String(s ?? "");
    const pad = Math.max(0, w - s.length);
    return align === "right" ? " ".repeat(pad) + s : s + " ".repeat(pad);
  };
  rows.push(paint.gray(`  ${cell("agente", W[0])} ${cell("modelo", W[1])} ${cell("in", W[2], "right")} ${cell("out", W[3], "right")} ${cell("custo", W[4], "right")}`));
  for (const [role, p] of metrics.phases.entries()) {
    const cost = p.cost > 0 ? paint.brightYellow(`$${p.cost.toFixed(4)}`) : paint.gray("$0.0000");
    rows.push(
      `  ${paint.boldCyan(cell(role, W[0]))} ${paint.dim(cell(models[role]?.label ?? "?", W[1]))} ${cell(p.tokensIn, W[2], "right")} ${cell(p.tokensOut, W[3], "right")} ${cost}`
    );
  }
  const totalCost = t.cost > 0 ? paint.brightYellow(`$${t.cost.toFixed(4)}`) : paint.gray("$0.0000");
  rows.push(paint.gray(`  ${"─".repeat(W[0] + W[1] + W[2] + W[3] + W[4] + 5)}`));
  rows.push(`  ${paint.bold(cell("TOTAL", W[0]))} ${cell("", W[1])} ${paint.bold(cell(t.tokensIn, W[2], "right"))} ${paint.bold(cell(t.tokensOut, W[3], "right"))} ${paint.bold(totalCost)}`);
  const map = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join("  ") || paint.gray("—");
  panel("métricas da squad — tokens reais do harness", [rows.join("\n").replace(/\n/g, "\n  ")]);
  panel("trilha de execução", [
    `${paint.bold("skills")}   ${map(t.skills)}`,
    `${paint.bold("hooks")}    ${map(t.hooks)}`,
    `${paint.bold("comandos")} ${[...t.cmds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([k, v]) => (/rtk|codegraph|ast-grep|sg/i.test(k) ? paint.brightGreen(`${k}×${v}`) : `${k}×${v}`)).join("  ") || paint.gray("—")}`,
  ]);
}

/** Dados do painel "Processos" — uma linha por fase da squad. */
const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
const cell = (s, w) => { s = String(s ?? ""); return s.slice(0, w) + " ".repeat(Math.max(0, w - visLen(s))); };

export function runRows(metrics, models, outputs, issue, phaseState) {
  const rows = [];
  for (const [role] of metrics.phases.entries()) {
    const done = !!outputs[role];
    const active = phaseState?.currentRole === role;
    rows.push({
      id: String(issue?.number ?? "manual"),
      title: role,
      agent: models[role]?.label ?? "—",
      status: done ? "completed" : active && phaseState?.phaseActive ? "running" : "queued",
      dur: metrics.duration(role),
    });
  }
  return rows;
}

/** Painéis da coluna direita do split screen (estilo protótipo):
 *  Issue em foco · Uso e custos · Rastreamento de agentes · Comandos e skills. */
export function sidePanels(metrics, models, { issue = null, outputs = {}, phaseState = null } = {}) {
  const t = metrics.totals();
  const panels = [];
  const roles = [...metrics.phases.keys()];
  const done = roles.filter((r) => outputs[r]).length;
  const pct = roles.length ? Math.round((done / roles.length) * 100) : 0;
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  // Issue em foco
  const barW = 20;
  const filled = Math.round((pct / 100) * barW);
  panels.push({
    title: "Issue em foco",
    lines: [
      issue ? `${paint.boldCyan(`#${issue.number ?? "manual"}`)} ${paint.dim(String(issue.title ?? "").slice(0, 26))}` : paint.gray("—"),
      `${paint.gray("progresso")}  ${paint.brightGreen("█".repeat(filled))}${paint.gray("░".repeat(barW - filled))} ${paint.bold(pct + "%")}`,
    ],
  });

  // Uso e custos (2 métricas, uma por linha)
  panels.push({
    title: "Uso e custos",
    lines: [
      `${paint.gray("tokens")}   ${paint.bold(fmt(t.tokensIn))} in · ${paint.bold(fmt(t.tokensOut))} out`,
      `${paint.gray("custo")}    ${paint.brightGreen("$" + t.cost.toFixed(4))} ${paint.gray("USD real")}`,
    ],
  });

  // Rastreamento de agentes
  const agentLines = [];
  for (const [role] of metrics.phases.entries()) {
    const st = outputs[role] ? paint.green("● ok")
      : phaseState?.currentRole === role && phaseState?.phaseActive ? paint.brightGreen("● rodando")
      : paint.gray("○ fila");
    agentLines.push(`${paint.boldCyan(cell(role, 9))} ${paint.dim(cell((models[role]?.label ?? "—").slice(0, 12), 13))} ${st}`);
  }
  panels.push({ title: "Rastreamento de agentes", badge: String(roles.length), lines: agentLines });

  // Comandos e skills (condensado)
  const toolLines = [];
  const cmds = [...t.cmds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (cmds.length) {
    toolLines.push(cmds.map(([k, v]) => `${/rtk|codegraph|ast-grep|sg/i.test(k) ? paint.brightGreen("●") : paint.gray("○")} ${k.replace(" (proxy)", "")} ${paint.dim("×" + v)}`).join("  "));
  }
  for (const [k, v] of [...t.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    toolLines.push(`${paint.magenta("◆")} skill ${k} ${paint.dim("×" + v)}`);
  }
  if (!toolLines.length) toolLines.push(paint.gray("nenhuma chamada registrada"));
  panels.push({ title: "Comandos e skills", lines: toolLines });

  return panels;
}

/** Quadro lateral — impresso à direita (coluna) após cada fase, com os números
 *  correntes: issue em trabalho + status, tokens usados, valor consumido e
 *  comandos executados. */
export function metricsSidePanel(metrics, models, { issue = null, status = "", width = 46 } = {}) {
  const t = metrics.totals();
  const terms = process.stdout.columns ?? 80;
  const pad = Math.max(2, Math.min(28, terms - width - 12));
  const padStr = " ".repeat(pad);
  const line = (s) => console.log(padStr + s);
  const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
  const cell = (s, w) => { s = String(s ?? ""); return s + " ".repeat(Math.max(0, w - visLen(s))); };
  const border = paint.brightBlue;
  const bar = border("┌" + "─".repeat(width - 2) + "┐");
  const mid = (s) => border("│") + " " + s + " ".repeat(Math.max(0, width - 3 - visLen(s))) + border("│");
  const bottom = border("└" + "─".repeat(width - 2) + "┘");
  line("");
  line(bar);
  if (issue) {
    line(mid(`${paint.bold("ISSUE")}  ${paint.boldCyan(`#${issue.number ?? "manual"}`)} ${paint.dim(String(issue.title ?? "").slice(0, 24))}`));
    line(mid(`${paint.bold("status")}  ${paint.brightCyan(status || "—")}`));
    line(mid(border("─".repeat(width - 4))));
  }
  line(mid(paint.bold("QUADRO DA SQUAD") + paint.dim("  (após a última fase)")));
  line(mid(border("─".repeat(width - 4))));
  line(mid(`${paint.boldCyan("tokens")}   ${String(t.tokensIn).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} in · ${String(t.tokensOut).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} out`));
  line(mid(`${paint.boldCyan("custo")}    ${t.cost > 0 ? paint.brightYellow("$" + t.cost.toFixed(4)) : paint.gray("$0.0000")} (USD, real do harness)`));
  line(mid(border("─".repeat(width - 4))));
  const cmds = [...t.cmds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  line(mid(paint.bold("comandos executados")));
  for (const [k, v] of cmds) {
    const mark = /rtk|codegraph|ast-grep|sg/i.test(k) ? paint.brightGreen("●") : paint.gray("○");
    line(mid(`  ${mark} ${cell(k, 22)} ${paint.dim("×" + v)}`));
  }
  if (!cmds.length) line(mid(`  ${paint.gray("— nenhum ainda")}`));
  const skills = [...t.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (skills.length) {
    line(mid(border("─".repeat(width - 4))));
    line(mid(paint.bold("skills chamadas")));
    for (const [k, v] of skills) line(mid(`  ${paint.magenta("◆")} ${cell(k, 22)} ${paint.dim("×" + v)}`));
  }
  line(bottom);
}

export { fmtNum };
