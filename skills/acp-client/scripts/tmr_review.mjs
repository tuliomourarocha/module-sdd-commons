/**
 * tmr_review.mjs — helpers da revisão do plano:
 *
 * - skillSuggestions(findSkillPy, task): sugestões de skills para a tarefa —
 *   LOCAIS (já instaladas) + REMOTAS (skills.sh, endpoint público /api/search).
 * - handleSkillFeedback(texts, findSkillPy): aprovações passam pela auditoria
 *   pública (find_skill.py --audit) antes do `npx skills add` — nunca instalar
 *   sem auditoria.
 */
import { spawnSync } from "node:child_process";

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
export function handleSkillFeedback(texts, findSkillPy, log = console.log, cwd = process.cwd()) {
  const approved = [];
  for (const t of texts) {
    for (const m of t.matchAll(/SKILL (APROVADA|REJEITADA):\s*([\w./-]+)/gi)) {
      const [, verdict, id] = m;
      if (verdict.toUpperCase() === "REJEITADA") { log(`  ✘ skill rejeitada pelo usuário: ${id}`); continue; }
      log(`  ▸ auditoria de ${id}…`);
      const audit = spawnSync("python3", [findSkillPy, "--audit", id], { encoding: "utf8", timeout: 30_000 });
      log((audit.stdout ?? audit.stderr ?? "").trim().split("\n").slice(0, 2).map((l) => `    ${l}`).join("\n") || "    (sem achados)");
      if (audit.status !== 0) { log(`  ✘ auditoria falhou — ${id} NÃO instalada`); continue; }
      log(`  ▸ instalando ${id} (npx skills add)…`);
      const inst = spawnSync("npx", ["-y", "skills", "add", id, "--yes"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
      if (inst.status === 0) approved.push(id);
      else log(`  ✘ install falhou para ${id}`);
    }
  }
  return approved;
}
