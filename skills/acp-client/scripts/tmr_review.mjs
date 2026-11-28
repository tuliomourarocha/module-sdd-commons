import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

function searchTerms(issue, plan) {
  const proposed = [...plan.matchAll(/^\s*(?:[-*]\s*)?SKILL_SEARCH:\s*([\w.+# -]{2,60})\r?$/gim)]
    .map((match) => match[1].trim().toLowerCase());
  const labels = (issue.labels ?? "").split(",").map((label) => label.trim().toLowerCase())
    .filter((label) => /^[\w.+#-]{2,24}$/.test(label) && !/^(?:p\d-.*|bug|feature|chore|docs|epic|enhancement)$/.test(label));
  const title = issue.title.toLowerCase().match(/[a-z][a-z0-9.+#-]{2,}/g) ?? [];
  const ignored = /^(?:para|com|por|das|dos|uma|the|and|for|with|from|adicionar|implementar|corrigir|atualizar|integrar|melhorar|add|fix|update|implement|support)$/;
  return [...new Set([...proposed, ...labels, ...title.filter((word) => !ignored.test(word))])].slice(0, 5);
}

export async function skillSuggestions(findSkillPy, issue, plan, cwd) {
  const queries = searchTerms(issue, plan);
  const lookup = async (terms, remote) => {
    const args = [findSkillPy, "--json", ...(remote ? ["--remote", "--limit", "8"] : []), "--", terms];
    try {
      const { stdout } = await exec("python3", args, { cwd, timeout: 15_000 }).catch((error) => {
        if (error.code === 1 && error.stdout) return error;
        throw error;
      });
      return JSON.parse(stdout);
    } catch (error) {
      return { warning: error.killed ? "Tempo de consulta excedido." : "Falha ao executar find_skill.py." };
    }
  };

  const [offline, ...results] = await Promise.all([
    lookup([issue.title, issue.labels, ...queries].filter(Boolean).join(" "), false),
    ...queries.map((query) => lookup(query, true)),
  ]);
  if (results.some((result) => !result.warning) && results.reduce((sum, result) => sum + (result.remote?.length ?? 0), 0) < 4) {
    const fallback = [...new Set(queries.flatMap((query) => query.split(/\s+/)))]
      .filter((word) => word.length > 2 && !queries.includes(word)).slice(0, 3);
    results.push(...await Promise.all(fallback.map((word) => lookup(word, true))));
  }
  const local = (offline.local ?? []).slice(0, 8);
  const remote = new Map();
  // Intercala resultados para representar mais de um domínio da issue.
  for (let rank = 0; rank < 8 && remote.size < 8; rank++) {
    for (const result of results) {
      const skill = result.remote?.[rank];
      if (skill && remote.size < 8 && !remote.has(skill.id)) remote.set(skill.id, skill);
    }
  }
  const warning = results.find((result) => result.warning)?.warning;
  return { local, remote: [...remote.values()], warning };
}

function skillChoices(skills) {
  return skills.map((skill, index) => `
    <fieldset><legend>${escapeHtml(skill.name)}</legend>
      <p><a href="${escapeHtml(skill.url)}" target="_blank" rel="noopener">${escapeHtml(skill.source)}</a>
      · ${escapeHtml(skill.installs)} instalações</p>
      <label><input type="radio" name="skill-${index}" value="aprovar"> Aprovar</label>
      <label><input type="radio" name="skill-${index}" value="rejeitar"> Rejeitar</label>
      <label><input type="radio" name="skill-${index}" value="" checked> Sem decisão</label>
    </fieldset>`).join("");
}

export function buildReviewHtml(title, plan, suggestions) {
  const local = suggestions.local.map(({ name, description }) =>
    `<li><strong>${escapeHtml(name)}</strong> · ${escapeHtml(description)}</li>`).join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
html{background:#f3f5f8;color:#192333}body{max-width:58rem;margin:auto;padding:1.5rem;font:1rem/1.55 system-ui}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:1.25rem;border:1px solid #ccd5e0;border-radius:.5rem}
fieldset{min-width:0;margin:1rem 0;padding:.75rem 1rem;border:1px solid #adb9c9;border-radius:.5rem}
label{display:inline-block;margin-right:1rem}a{color:#15498f;overflow-wrap:anywhere}
textarea{display:block;width:100%;box-sizing:border-box;font:inherit;margin:.5rem 0 1rem}
button{font:inherit;border:0;border-radius:.35rem;background:#15498f;color:white;padding:.6rem 1rem;cursor:pointer}
</style></head><body><main>
<h1>${escapeHtml(title)}</h1>
<p>Anote trechos do plano ou registre suas decisões no formulário. Envie a revisão pelo painel de conversa com <strong>Send &amp; End</strong>.</p>
<pre>${escapeHtml(plan)}</pre>
<h2>Skills locais</h2>
${local ? `<ul>${local}</ul>` : "<p>Nenhuma skill local correspondente.</p>"}
<h2>Sugestões do skills.sh</h2>
${suggestions.warning ? `<p>Consulta ao skills.sh com falhas. ${escapeHtml(suggestions.warning)}</p>` : ""}
<form id="review">
${suggestions.remote.length ? skillChoices(suggestions.remote) : "<p>Nenhuma sugestão remota disponível.</p>"}
<fieldset><legend>Decisão sobre o plano</legend>
<label><input type="radio" name="plan" value="Plano aprovado."> Aprovar plano</label>
<label><input type="radio" name="plan" value="O plano precisa dos ajustes descritos na revisão."> Solicitar ajustes</label>
</fieldset>
<label for="notes">Observações e respostas</label>
<textarea name="notes" id="notes" rows="4" maxlength="12000"></textarea>
<button type="submit">Enfileirar decisões</button>
<p id="status" role="status"></p>
</form></main>
<script>
document.getElementById("review").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const decisions = Array.from(values).filter(([key, value]) => key.startsWith("skill-") && value);
  const feedback = [values.get("plan"), values.get("notes").trim()].filter(Boolean).join("\\n");
  const status = document.getElementById("status");
  if (!window.lavish?.queuePrompt) { status.textContent = "Abra esta página no Lavish Editor."; return; }
  if (!decisions.length && !feedback) return;
  window.lavish.queuePrompt(JSON.stringify({ decisions, feedback }), {
    tag: "tmr-plan-review", text: "Decisões da revisão do plano", element: form,
  });
  status.textContent = "Revise a fila no painel de conversa antes de enviar.";
});
</script></body></html>`;
}

export function applyReviewPrompts(state, prompts, suggestions) {
  for (const item of prompts) {
    if (item.tag !== "tmr-plan-review") {
      const text = item.prompt ?? item.text;
      if (typeof text === "string" && text.trim()) state.notes.push(text.trim());
      continue;
    }
    try {
      const { decisions, feedback } = JSON.parse(item.prompt);
      for (const [key, value] of decisions) {
        const index = Number(/^skill-(\d+)$/.exec(key)?.[1]);
        if (suggestions.remote[index] && ["aprovar", "rejeitar"].includes(value)) state.decisions.set(index, value);
      }
      if (typeof feedback === "string" && feedback.trim()) state.notes.push(feedback.trim());
    } catch { /* Um item inválido não autoriza instalação. */ }
  }
}

export async function runLavishReview(html, onPrompts, { log, onOpen, reconnect }) {
  const dir = await fs.mkdtemp(path.join(process.env.SDD_TMR_TMP ?? os.tmpdir(), "planner-"));
  try {
    const file = await fs.realpath(dir).then((root) => path.join(root, "plano.html"));
    await fs.writeFile(file, html, { mode: 0o600 });
    const launch = async () => {
      let result;
      try {
        result = await exec("lavish-axi", [file], { timeout: 30_000 });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        result = await exec("npx", ["-y", "lavish-axi", file], { timeout: 60_000 });
      }
      let url;
      try { url = JSON.parse(result.stdout).session?.url; }
      catch { url = /^\s+url:\s*"?([^"\s]+)"?\s*$/m.exec(result.stdout)?.[1]; }
      if (!url) throw new Error("Lavish não retornou o endereço da revisão.");
      const target = new URL(url);
      if (!["http:", "https:"].includes(target.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
        throw new Error("Lavish não retornou um endereço local de revisão.");
      }
      log("info", `Revisão do plano aberta no Lavish · ${target.href}`);
      onOpen(target.href);
      return target;
    };
    let target = await launch();
    let reply = null;
    for (;;) {
      const poll = new URL("/api/poll", target);
      poll.search = new URLSearchParams({ file, owner: "sdd-acp planner" });
      // O CLI converte esta resposta em TOON. O endpoint local preserva o texto
      // multilinha, as decisões e o sinal de encerramento do último lote.
      const response = await fetch(poll, {
        redirect: "error",
        ...(reply && { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_reply: reply }) }),
      });
      reply = null;
      if (!response.ok) throw new Error(`Lavish respondeu HTTP ${response.status}.`);
      const batch = await response.json();
      onPrompts(batch.prompts ?? []);
      if (batch.session_ended || batch.status === "ended") return true;
      if (batch.artifact_failures?.length) throw new Error("Lavish não conseguiu renderizar a revisão.");
      if (batch.status === "browser_disconnected") {
        if (!(await reconnect())) return false;
        target = await launch();
      } else if (batch.status !== "feedback") {
        throw new Error(`Estado inesperado da revisão Lavish: ${batch.status}.`);
      } else {
        reply = "Feedback recebido. Use Send & End para concluir a revisão.";
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function installApprovedSkills(skills, findSkillPy, cwd, harness, log) {
  const installed = [];
  for (const { id, source, slug } of skills) {
    try {
      log("info", `Auditando ${id}…`);
      const { stdout } = await exec("python3", [findSkillPy, "--audit", id, "--json"], { cwd, timeout: 30_000 });
      const audit = JSON.parse(stdout).audit;
      const reports = audit?.audits;
      if (audit?.id !== id || !reports?.length || reports.some(({ status }) => status !== "pass")) {
        log("warn", `Auditoria de ${id} sem aprovação de todos os relatórios disponíveis.`);
        continue;
      }
      log("info", `Auditoria aprovada para ${id} · ${reports.map(({ provider }) => provider).join(", ")}`);
      log("info", `Instalando ${id} para ${harness}…`);
      await exec("npx", ["-y", "skills", "add", source, "--skill", slug, "--agent", harness, "--yes"], {
        cwd, timeout: 300_000,
      });
      await fs.access(path.join(cwd, ".agents", "skills", slug, "SKILL.md"));
      installed.push(id);
    } catch (error) {
      log("warn", `Falha na auditoria ou instalação de ${id} · ${error.killed ? "tempo excedido" : error.code ?? "erro"}`);
    }
  }
  return installed;
}
