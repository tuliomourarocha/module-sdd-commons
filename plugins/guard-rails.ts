/**
 * plugins/guard-rails.ts — Hook determinístico pós-edição (OpenCode)
 *
 * Conceito: middleware fora do LLM (trava determinística) que intercepta
 * toda finalização de alteração em arquivo de código e roda validações
 * fora do modelo: linter, segurança, pylance/pyright, ruff, etc.
 *
 * Equivalente Claude Code: PostToolUse { matcher: "Edit|Write|MultiEdit" }
 * Em OpenCode: plugin com `tool.execute.after` + `event: file.edited`
 *
 * Determinismo: roda `hooks/guard_rails.py` (python) antes de liberar próximo gate.
 * Se HIGH → bloqueia (throw Tool.Error) e retorna feedback ao builder (max 2 iterações).
 *
 * Instalação: copiado para `.opencode/plugins/guard-rails.ts` via bin/sdd-harness.js / install.sh
 * Requer: python3, hooks/guard_rails.py (instalado em `.opencode/hooks/` ou `hooks/` na raiz)
 */

import type { Plugin } from "@opencode-ai/plugin";

const CODE_EXT_RE = /\.(py|ts|tsx|js|jsx|mjs|cjs|css|scss|json)$/i;
const IGNORE_RE = /(?:node_modules|\.git|\.next|dist\/|build\/|\.venv|__pycache__)/;
// Artefatos proibidos em disco — nunca devem ser criados (bloqueio HIGH imediato)
// Novo: CI_REPORT.md / SUPERVISOR_REPORT.md / ci_metrics.json / ORCHESTRATOR_STATE.json também são proibidos — devem ser seções em HANDOFF/STATE
const FORBIDDEN_ARTIFACT_RE = /(?:\.planning\/(?:SUMMARY|REVIEW|VALIDATION|PRD|PLAN|CI_REPORT|SUPERVISOR_REPORT|ORCHESTRATOR_STATE|COORCHESTRATOR_STATE)\.md$|\.planning\/arch\/|(?:^|\/)(?:SUMMARY|REVIEW|VALIDATION|CI_REPORT|SUPERVISOR_REPORT)\.md$|\.planning\/(?:ci_metrics|supervisor_metrics|CI_RETRIES|ORCHESTRATOR_STATE|COORCHESTRATOR_STATE)\.json$)/i;
const FORBIDDEN_BASENAME_RE = /^(?:SUMMARY|REVIEW|VALIDATION|CI_REPORT|SUPERVISOR_REPORT)\.md$/i;

function isCodeFile(path: string | undefined): boolean {
  if (!path) return false;
  if (IGNORE_RE.test(path)) return false;
  return CODE_EXT_RE.test(path);
}

function isForbiddenArtifact(path: string | undefined): boolean {
  if (!path) return false;
  // verifica .planning/SUMMARY.md etc., CI_REPORT, SUPERVISOR_REPORT e jsons — agora tudo proibido como arquivo separado
  if (FORBIDDEN_ARTIFACT_RE.test(path)) return true;
  const base = path.split("/").pop() ?? "";
  if (FORBIDDEN_BASENAME_RE.test(base)) return true;
  // qualquer .planning/*.json de métricas/state separado também proibido
  if (path.includes(".planning/") && (path.endsWith("ci_metrics.json") || path.endsWith("supervisor_metrics.json") || path.endsWith("CI_RETRIES.json") || path.endsWith("ORCHESTRATOR_STATE.json") || path.endsWith("COORCHESTRATOR_STATE.json"))) {
    return true;
  }
  // bloqueia qualquer .planning/*.md que não seja STATE/HANDOFF/HOOKS (single source; CI_REPORT etc agora são seções)
  if (path.includes(".planning/") && path.endsWith(".md")) {
    if (path.includes(".planning/codebase")) return false;
    const allowed = ["STATE.md", "HANDOFF.md"]; // sem CI_REPORT/SUPERVISOR_REPORT — são marcadores em HANDOFF/STATE
    const isAllowed = allowed.some((a) => path.endsWith(a));
    if (!isAllowed && /(?:SUMMARY|REVIEW|VALIDATION|PRD|PLAN|CI_REPORT|SUPERVISOR_REPORT|ORCHESTRATOR)/i.test(path)) return true;
  }
  return false;
}

function extractFilePath(tool: string, args: any): string | undefined {
  // OpenCode tools: edit, write, bash, apply_patch, etc.
  if (args?.filePath) return args.filePath as string;
  if (args?.file) return args.file as string;
  if (args?.filepath) return args.filepath as string;
  if (args?.path) return args.path as string;
  // bash com escrita direta
  if (tool === "bash" && typeof args?.command === "string") {
    const cmd: string = args.command;
    // detecta `> file`, `cat > file`, `echo ... > file`
    const m = cmd.match(/(?:^|\s)(?:>|>>)\s*([^\s;|&'"]+\.(?:py|ts|tsx|js|jsx|css|json))/);
    if (m) return m[1];
  }
  // apply_patch patchText contém "*** Update File: path" / "*** Add File: path"
  if (tool === "apply_patch" && typeof args?.patchText === "string") {
    const m = args.patchText.match(/\*\*\* (?:Add|Update|Move to) File:\s*([^\n]+)/);
    if (m) return m[1].trim();
  }
  return undefined;
}

// ── Log de garantia: prova que hook foi chamado + alerta agentes em caso de erro ──
async function writeGuaranteeLog(
  $: any,
  directory: string,
  entry: Record<string, any>
) {
  const line = JSON.stringify(entry);
  // Log JSONL em dois lugares para redundância
  await $`mkdir -p ${directory}/.planning && mkdir -p ${directory}/.opencode/hooks`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.planning/HOOKS.log`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.opencode/hooks/hook-audit.jsonl`.nothrow().quiet();
  // Também mantém compat com guard-rails.log legado
  if (entry.hook === "guard-rails") {
    await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.opencode/hooks/guard-rails.log`.nothrow().quiet();
  }
}

async function runGuardRails(
  $: any,
  directory: string,
  filePath: string,
  client: any
) {
  const normalized = filePath.startsWith("/") ? filePath : `${directory}/${filePath}`;
  const triggerTs = new Date().toISOString();
  // resolve hook script location: .opencode/hooks/guard_rails.py > hooks/guard_rails.py
  const candidates = [
    `${directory}/.opencode/hooks/guard_rails.py`,
    `${directory}/hooks/guard_rails.py`,
    `${directory}/plugins/../hooks/guard_rails.py`,
  ];
  // fallback: tenta encontrar via find
  let hook: string | null = null;
  for (const c of candidates) {
    try {
      const res = await $`test -f ${c} && echo ok`.text().catch(() => "");
      if (res.includes("ok")) {
        hook = c;
        break;
      }
    } catch {}
  }
  if (!hook) {
    // tenta relativo ao plugin file (quando rodando em .opencode/plugins)
    hook = `${directory}/hooks/guard_rails.py`;
    const exists = await $`test -f ${hook} && echo ok`.text().catch(() => "");
    if (!exists.includes("ok")) {
      const errMsg = `Hook script não encontrado para ${filePath} — guard rails NÃO executado`;
      await client.app.log({
        body: {
          service: "guard-rails",
          level: "error",
          message: errMsg,
          extra: { filePath, directory },
        },
      });
      await writeGuaranteeLog($, directory, {
        ts: triggerTs,
        hook: "guard-rails",
        file: filePath,
        trigger: "tool.execute.after",
        duration_ms: 0,
        exit_code: 127,
        blocked: false,
        high: 0,
        med: 0,
        status: "error",
        error: "hook_not_found",
        message: errMsg,
      });
      // Notifica agente via throw visível
      throw new Error(`🚨 HOOK_GUARD_RAILS_ERROR: ${errMsg} — verifique hooks/guard_rails.py existe e python3 está instalado. Log: .planning/HOOKS.log`);
    }
  }

  const start = Date.now();
  // roda determinístico
  const result = await $`python3 ${hook} --file ${normalized} --format json`.nothrow().quiet();
  const duration = Date.now() - start;
  const stdout: string = result.stdout?.toString() ?? "";
  const stderr: string = result.stderr?.toString() ?? "";
  const exitCode: number = result.exitCode ?? 0;

  let json: any = null;
  let parseError: string | null = null;
  try {
    json = JSON.parse(stdout);
  } catch (e: any) {
    parseError = e?.message ?? String(e);
    // se exit 0 mas parse falhou, pode ser output texto — tratar como erro infra
  }

  const blocked = json?.blocked === true || exitCode === 2;
  const findings: any[] = json?.findings ?? [];
  const high = findings.filter((f) => f.severity === "HIGH").length;
  const med = findings.filter((f) => f.severity === "MED").length;
  const isInfraError = exitCode === 127 || exitCode === 124 || (parseError && exitCode !== 0 && !json);

  // Log estruturado sempre
  await client.app.log({
    body: {
      service: "guard-rails",
      level: blocked ? "error" : isInfraError ? "error" : med > 0 ? "warn" : "info",
      message: blocked
        ? `⛔ Guard Rails BLOQUEOU ${filePath} — HIGH:${high} MED:${med} (${duration}ms)`
        : isInfraError
          ? `🚨 Guard Rails ERRO INFRA ${filePath} — exit:${exitCode} (${duration}ms)`
          : `🛡️ Guard Rails ${filePath} — HIGH:${high} MED:${med} (${duration}ms)`,
      extra: { filePath, blocked, high, med, findings: findings.slice(0, 5), stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 1000), isInfraError, parseError },
    },
  });

  // ── GARANTIA: escreve log de prova que hook foi chamado ──
  await writeGuaranteeLog($, directory, {
    ts: triggerTs,
    hook: "guard-rails",
    file: filePath,
    trigger: "tool.execute.after",
    duration_ms: duration,
    exit_code: exitCode,
    blocked,
    high,
    med,
    status: blocked ? "blocked" : isInfraError ? "infra_error" : med > 0 ? "warn" : "pass",
    error: isInfraError ? (parseError ?? stderr.slice(0, 500)) : null,
  });

  // Notifica agente em caso de erro infra — visível no decorrer do processo
  if (isInfraError && !blocked) {
    await client.app.log({
      body: {
        service: "guard-rails",
        level: "error",
        message: `🚨 Guard Rails falha infra para ${filePath} — agent será notificado. Veja .planning/HOOKS.log`,
        extra: { filePath, exitCode, stderr: stderr.slice(0, 1000) },
      },
    });
    throw new Error(
      `🚨 HOOK_GUARD_RAILS_INFRA_ERROR: ${filePath} — hook falhou (exit ${exitCode}). ` +
      `stderr: ${stderr.slice(0, 800)}\n` +
      `Aviso: guard rails NÃO validou este arquivo. Corrija infra (python3, ruff, pyright) ou verifique .planning/HOOKS.log`
    );
  }

  // Também exibe no TUI como toast
  if (blocked) {
    const msg = `Guard Rails bloqueou ${filePath} — ${high} HIGH\n${findings
      .filter((f) => f.severity === "HIGH")
      .slice(0, 3)
      .map((f) => `• ${f.rule}: ${f.message.slice(0, 120)}`)
      .join("\n")}`;
    // Lança erro determinístico para o agente ver e corrigir (não crash do plugin)
    // O LLM recebe o erro como tool result e deve corrigir (max 2 iterações builder)
    throw new Error(
      `⛔ GUARD_RAILS_BLOCKED: ${filePath} — corrija HIGH antes de prosseguir\n${msg}\n\nDetalhe: ${stdout.slice(0, 4000)}\n\nLog garantia: .planning/HOOKS.log`
    );
  }
}

export const GuardRailsPlugin: Plugin = async ({ $, directory, client }) => {
  return {
    // Hook principal: após toda tool que pode alterar arquivo
    "tool.execute.after": async (input: any, output: any) => {
      const tool: string = input?.tool ?? output?.tool ?? input?.name ?? "";
      // só intercepta tools que escrevem
      if (!["edit", "write", "bash", "apply_patch"].includes(tool)) return;

      // extrai filePath dos args (tool.execute.before usa output.args, after pode ter input.args)
      const args = output?.args ?? input?.args ?? {};
      const filePath = extractFilePath(tool, args);
      if (!filePath) return;

      // ── Bloqueio prioritário: artefatos proibidos (SUMMARY/REVIEW/VALIDATION/CI_REPORT/SUPERVISOR_REPORT/etc) sempre HIGH, mesmo se não for code file — devem ser seções em HANDOFF/STATE ──
      if (isForbiddenArtifact(filePath)) {
        const msg = `⛔ GUARD_RAILS_BLOCKED: ${filePath} — artefato proibido (SUMMARY/REVIEW/VALIDATION/CI_REPORT/SUPERVISOR_REPORT/ci_metrics etc nunca devem ser criados em disco; retorne em memória ou embarque em HANDOFF.md/STATE.md)`;
        await client.app.log({
          body: { service: "guard-rails", level: "error", message: msg, extra: { filePath, forbidden: true } },
        });
        await writeGuaranteeLog($, directory, {
          ts: new Date().toISOString(),
          hook: "guard-rails",
          file: filePath,
          trigger: "tool.execute.after:forbidden-artifact",
          duration_ms: 0,
          exit_code: 2,
          blocked: true,
          high: 1,
          med: 0,
          status: "blocked",
          error: "forbidden_artifact",
          message: msg,
        });
        throw new Error(`${msg} — Log: .planning/HOOKS.log`);
      }

      if (!isCodeFile(filePath)) return;

      // evita loop se o próprio guard criar log (inclui HOOKS.log)
      if (filePath.includes("guard-rails.log") || filePath.includes("HOOKS.log") || filePath.includes("hook-audit") || filePath.includes("SUPERVISOR")) return;

      try {
        await runGuardRails($, directory, filePath, client);
      } catch (err: any) {
        // Re-throw para agente ver — tanto BLOCK quanto INFRA precisam ser visíveis
        if (err?.message?.includes("GUARD_RAILS_BLOCKED") || err?.message?.includes("HOOK_GUARD_RAILS")) throw err;
        await client.app.log({
          body: {
            service: "guard-rails",
            level: "error",
            message: `🚨 Guard Rails falhou infra para ${filePath}: ${err?.message?.slice(0, 500)} — notificado ao agente (ver .planning/HOOKS.log)`,
            extra: { filePath, error: String(err) },
          },
        });
        // Garante que agente builder/reviewer seja notificado mesmo em erro infra
        throw new Error(`🚨 HOOK_GUARD_RAILS_ERROR: ${filePath} — ${err?.message?.slice(0, 800)} — veja .planning/HOOKS.log`);
      }
    },

    // Hook secundário: evento de arquivo editado (file watcher) — redundância determinística
    event: async ({ event }: any) => {
      if (event?.type !== "file.edited" && event?.type !== "file.watcher.updated") return;
      const filePath: string | undefined = event?.properties?.path ?? event?.path ?? event?.file;
      if (!filePath) return;
      // bloqueio prioritário para artefatos proibidos mesmo via watcher
      if (isForbiddenArtifact(filePath)) {
        await client.app.log({
          body: { service: "guard-rails", level: "error", message: `⛔ Guard Rails bloqueou artefato proibido via watcher: ${filePath}` },
        });
        await writeGuaranteeLog($, directory, {
          ts: new Date().toISOString(),
          hook: "guard-rails",
          file: filePath,
          trigger: "event:file.edited:forbidden",
          duration_ms: 0,
          exit_code: 2,
          blocked: true,
          high: 1,
          med: 0,
          status: "blocked",
          error: "forbidden_artifact",
        });
        return;
      }
      if (!isCodeFile(filePath)) return;
      if (filePath.includes("guard-rails.log") || filePath.includes("HOOKS.log") || filePath.includes("hook-audit")) return;
      try {
        await runGuardRails($, directory, filePath, client);
      } catch (err: any) {
        if (err?.message?.includes("GUARD_RAILS_BLOCKED") || err?.message?.includes("HOOK_GUARD_RAILS")) {
          await client.app.log({
            body: { service: "guard-rails", level: "error", message: err.message.slice(0, 2000) },
          });
          // Eventos file.edited não têm retorno para agente, mas log garante visibilidade
          // Também escreve garantia adicional
          await writeGuaranteeLog($, directory, {
            ts: new Date().toISOString(),
            hook: "guard-rails",
            file: filePath,
            trigger: "event:file.edited",
            duration_ms: 0,
            exit_code: 2,
            blocked: true,
            high: 1,
            med: 0,
            status: "blocked",
            error: err.message.slice(0, 500),
          });
        }
      }
    },
  };
};

// Compat V1: export default para opencode versões que esperam objeto plugin
export default GuardRailsPlugin;
