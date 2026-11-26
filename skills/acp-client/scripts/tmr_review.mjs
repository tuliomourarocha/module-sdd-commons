/**
 * tmr_review.mjs — revisão interativa via Lavish no FIM do planner e do supervisor.
 *
 * Fluxo: gera HTML self-contained (plano, skills sugeridas via skills.sh,
 * dúvidas/pendências) → abre no Lavish Editor (`npx -y lavish-axi <file>`) →
 * long-poll supervisionado (um poll por vez) até o usuário encerrar
 * (Send & End) → devolve os prompts enviados.
 *
 * Skills: botões Aprovar/Rejeitar enfileiram "SKILL APROVADA: <source>" /
 * "SKILL REJEITADA: <source>" (window.lavish.queuePrompt) — aprovadas passam
 * pela auditoria pública (find_skill.py --audit) antes do `npx skills add`.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePollResponse } from "./acp_client.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- HTML
export function buildReviewHtml({ title, subtitle, planText, localSkills = [], remoteSkills = [], extraSections = [] }) {
  const planBlock = planText
    ? `<h2>Plano / relatório</h2><pre class="plan">${esc(planText).slice(0, 60_000)}</pre>`
    : "";
  const localRows = localSkills
    .map((s) => `<li>✅ <b>${esc(s.name)}</b> <span class="dim">${esc(s.path ?? "")} — já instalada</span></li>`)
    .join("");
  const remoteRows = remoteSkills
    .map((s) => `<li>
      <b>${esc(s.name)}</b> <span class="dim">${esc(s.source)} · ${s.installs} installs</span>
      <a class="dim" href="${esc(s.url)}">${esc(s.url)}</a>
      <span class="btns">
        <button data-lavish-action onclick="window.lavish?.queuePrompt?.('SKILL APROVADA: ${esc(s.source)}')">✔ Aprovar</button>
        <button data-lavish-action onclick="window.lavish?.queuePrompt?.('SKILL REJEITADA: ${esc(s.source)}')">✘ Rejeitar</button>
      </span>
    </li>`)
    .join("");
  const extras = extraSections
    .map((s) => `<h2>${esc(s.title)}</h2><pre class="plan">${esc(s.body ?? "").slice(0, 20_000)}</pre>`)
    .join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light;background:#f7f7f4;color:#171b21}
body{margin:0 auto;max-width:900px;padding:2rem;font:15px/1.6 system-ui}
h1{font-size:1.3rem;margin:.2rem 0} h2{font-size:.95rem;text-transform:uppercase;letter-spacing:.05em;color:#5b6470;margin:1.6rem 0 .4rem}
.sub{color:#67707d;font-size:.85rem;margin-bottom:1rem}
.plan{white-space:pre-wrap;font:12.5px/1.55 ui-monospace,Menlo,monospace;background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:1rem;overflow-x:auto}
li{margin:.45rem 0} .dim{color:#67707d;font-size:.85rem}
button{border:1px solid #cfd6df;background:#fff;border-radius:6px;padding:.15rem .6rem;cursor:pointer;font-size:.85rem}
button:hover{background:#eef2ff}
.q{display:flex;gap:.4rem;margin-top:.4rem}
.q input{flex:1;border:1px solid #cfd6df;border-radius:6px;padding:.3rem .5rem;font-size:.9rem}
</style></head>
<body data-lavish-annotate="off">
<h1>${esc(title)}</h1>
<div class="sub">${esc(subtitle ?? "")}</div>
${planBlock}
${extras}
<h2>Skills — locais e sugeridas (skills.sh)</h2>
${localSkills.length ? `<ul>${localRows}</ul>` : "<p class='dim'>nenhuma skill local casou com a tarefa</p>"}
${remoteSkills.length ? `<ul>${remoteRows}</ul><p class="dim">Aprovar → auditoria pública → npx skills add. Rejeitar → ignorada.</p>` : "<p class='dim'>nenhuma sugestão remota para esta tarefa</p>"}
<h2>Dúvidas, ambiguidades e respostas</h2>
<p class="dim">Anote elementos do plano (modo anotação) ou use o campo abaixo — tudo vai pela Conversation panel do Lavish.</p>
<div class="q">
  <input id="tmr-q" placeholder="resposta/dúvida — ex.: usar Postgres em vez de SQLite">
  <button data-lavish-action onclick="window.lavish?.queuePrompt?.(document.getElementById('tmr-q')?.value || '')">Enviar</button>
</div>
</body></html>`;
}

// ---------------------------------------------------------------- skills.sh
/** Sugestões de skills para a tarefa: locais (já instaladas) + remotas (skills.sh). */
export function skillSuggestions(findSkillPy, task) {
  const words = [...new Set(String(task).toLowerCase().replace(/[^a-zà-ú0-9 ]/gi, " ").split(/\s+/)
    .filter((w) => w.length > 3))].slice(0, 6).join(" ");
  const r = spawnSync("python3", [findSkillPy, words, "--remote", "--limit", "8", "--json"], {
    encoding: "utf8", timeout: 30_000,
  });
  if (r.status !== 0) return { local: [], remote: [] };
  try {
    const j = JSON.parse(r.stdout);
    return { local: j.local ?? [], remote: (j.remote ?? []).slice(0, 8) };
  } catch { return { local: [], remote: [] }; }
}

/** Aprovações: auditoria pública antes do install (regra: nunca instalar sem audit). */
export function handleSkillFeedback(texts, findSkillPy, log = console.log) {
  const approved = [];
  for (const t of texts) {
    for (const m of t.matchAll(/SKILL (APROVADA|REJEITADA):\s*([\w./-]+)/gi)) {
      const [, verdict, id] = m;
      if (verdict.toUpperCase() === "REJEITADA") { log(`  ${"✘"} skill rejeitada pelo usuário: ${id}`); continue; }
      log(`  ${"▸"} auditoria de ${id}…`);
      const audit = spawnSync("python3", [findSkillPy, "--audit", id], { encoding: "utf8", timeout: 30_000 });
      log((audit.stdout ?? audit.stderr ?? "").trim().split("\n").slice(0, 2).map((l) => `    ${l}`).join("\n") || "    (sem achados)");
      if (audit.status !== 0) { log(`  ${"✘"} auditoria falhou — ${id} NÃO instalada`); continue; }
      log(`  ${"▸"} instalando ${id} (npx skills add)…`);
      const inst = spawnSync("npx", ["-y", "skills", "add", id], { stdio: "inherit", timeout: 300_000 });
      if (inst.status === 0) approved.push(id);
      else log(`  ${"✘"} install falhou para ${id}`);
    }
  }
  return approved;
}

// ---------------------------------------------------------------- poll loop
/** Abre a revisão no Lavish e coleta o feedback até o usuário encerrar. */
export async function runLavishReview(role, html, { log = console.log } = {}) {
  const file = path.join(os.tmpdir(), `tmr-review-${role}-${Date.now()}.html`);
  await fs.writeFile(file, html, "utf8");
  const prompts = [];
  const open = spawn("npx", ["-y", "lavish-axi", file], { stdio: ["ignore", "ignore", "pipe"] });
  open.stderr.setEncoding("utf8");
  let openErr = "";
  open.stderr.on("data", (c) => (openErr += c));
  await new Promise((res) => open.on("exit", (code) => { if (code !== 0 && openErr.trim()) log(`    ${openErr.trim().split("\n").slice(-2).join(" · ")}`); res(); }));
  log(`  ${"▸"} revisão aberta no Lavish — aprove o plano, as skills e responda as dúvidas; 'Send & End' encerra`);
  for (let i = 0; i < 30; i++) {
    const batch = await pollOnce(file);
    if (batch.ended) { log(`  ${"✔"} revisão encerrada pelo usuário`); break; }
    if (batch.disconnected) { log(`  ${"⚠"} aba do Lavish fechada — sessão resumível; reabrindo o poll…`); continue; }
    for (const p of batch.prompts) prompts.push(p.text);
    if (batch.prompts.length) log(`  ${"▸"} ${batch.prompts.length} feedback(s) recebido(s)`);
  }
  try { await fs.unlink(file); } catch {}
  return prompts;
}

function pollOnce(file) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["-y", "lavish-axi", "poll", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", () => {
      const parsed = parsePollResponse(out);
      resolve({
        ended: parsed.status === "ended",
        disconnected: parsed.status === "browser_disconnected",
        prompts: parsed.prompts ?? [],
      });
    });
  });
}
