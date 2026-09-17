/**
 * plugins/shipper.ts — Hook determinístico para shipper (git/PR/Trello/STATE/HANDOFF)
 *
 * Conceito: middleware fora do LLM que finaliza o ciclo deterministicamente.
 * Complementa hooks/guard_rails.py (per-file) e hooks/supervisor.py (pós-shipper).
 *
 * Acionamento (determinístico, sem depender de LLM decidir):
 *   - Trigger primário: `tool.execute.after` quando `task` com agent `reviewer` completa (após parecer de arquitetura em memória)
 *   - Trigger secundário removido: **não há** `write` em `.planning/REVIEW.md`/`SUMMARY.md`/`VALIDATION.md` — esses arquivos são proibidos e nunca devem ser criados (hook guard-rails bloqueia)
 *   - Trigger terciário: `event: session.idle` após reviewer (fallback)
 *   - Debounce: roda no máximo 1x por sessão (flag global)
 *
 * Instalação: copiado para `.opencode/plugins/shipper.ts` via bin/sdd-harness.js
 * Requer: python3, hooks/shipper.py, gh CLI (opcional), git
 */

import type { Plugin } from "@opencode-ai/plugin";

const SHIPPER_REPO = process.env.SHIPPER_REPO ?? process.env.SUPERVISOR_REPO ?? "tuliomourarocha/module-sdd-commons";
let hasRun = false;

async function writeGuaranteeLog($: any, directory: string, entry: Record<string, any>) {
  const line = JSON.stringify(entry);
  await $`mkdir -p ${directory}/.planning && mkdir -p ${directory}/.opencode/hooks`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.planning/HOOKS.log`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.opencode/hooks/hook-audit.jsonl`.nothrow().quiet();
}

async function runShipper($: any, directory: string, client: any, trigger: string) {
  if (hasRun) {
    await client.app.log({
      body: { service: "shipper", level: "info", message: `Shipper hook já executado (trigger ${trigger} ignorado)` },
    });
    return;
  }

  hasRun = true;
  const triggerTs = new Date().toISOString();
  const hookCandidates = [
    `${directory}/.opencode/hooks/shipper.py`,
    `${directory}/hooks/shipper.py`,
  ];
  let hook: string | null = null;
  for (const c of hookCandidates) {
    try {
      const ok = await $`test -f ${c} && echo ok`.text().catch(() => "");
      if (ok.includes("ok")) {
        hook = c;
        break;
      }
    } catch {}
  }
  if (!hook) {
    const errMsg = `hooks/shipper.py não encontrado via ${trigger} — fallback para task shipper minimal`;
    await client.app.log({
      body: { service: "shipper", level: "error", message: errMsg },
    });
    await writeGuaranteeLog($, directory, {
      ts: triggerTs,
      hook: "shipper",
      trigger,
      duration_ms: 0,
      exit_code: 127,
      status: "error",
      error: "hook_not_found",
      message: errMsg,
    });
    // Notifica harness/agentes — será visível no próximo gate
    hasRun = false; // permite fallback agent
    throw new Error(`🚨 HOOK_SHIPPER_ERROR: ${errMsg} — verifique hooks/shipper.py existe. Log: .planning/HOOKS.log`);
  }

  await client.app.log({
    body: { service: "shipper", level: "info", message: `🚢 Shipper hook acionado via ${trigger} — executando git/PR/HANDOFF/STATE determinísticos...` },
  });
  // Garantia: log de início (prova que hook foi chamado mesmo se falhar depois)
  await writeGuaranteeLog($, directory, {
    ts: triggerTs,
    hook: "shipper",
    trigger,
    duration_ms: 0,
    exit_code: null,
    status: "started",
    message: `Shipper hook iniciado via ${trigger}`,
  });

  const start = Date.now();
  const result = await $`python3 ${hook} --run --repo ${directory} --repo-slug ${SHIPPER_REPO} 2>&1`.nothrow().quiet();
  const out: string = result.stdout?.toString() ?? "";
  const err: string = result.stderr?.toString() ?? "";
  const exitCode: number = result.exitCode ?? 0;
  const duration = Date.now() - start;

  const level = exitCode === 0 ? "info" : exitCode === 2 ? "error" : "warn";
  await client.app.log({
    body: {
      service: "shipper",
      level,
      message: `Shipper hook finalizado (${duration}ms, exit ${exitCode}) via ${trigger}`,
      extra: { trigger, stdout: out.slice(0, 4000), stderr: err.slice(0, 1000) },
    },
  });

  // ── GARANTIA: log de conclusão (prova que hook executou) ──
  await writeGuaranteeLog($, directory, {
    ts: new Date().toISOString(),
    hook: "shipper",
    trigger,
    duration_ms: duration,
    exit_code: exitCode,
    status: exitCode === 0 ? "success" : exitCode === 2 ? "critical" : "warn",
    stdout: out.slice(0, 2000),
    stderr: err.slice(0, 1000),
  });

  // Verifica se STATE/HANDOFF foram criados
  const check = await $`ls -lh ${directory}/.planning/HANDOFF.md ${directory}/.planning/STATE.md 2>&1 | head -5`.nothrow().quiet();
  const checkOut = check.stdout?.toString() ?? check.stderr?.toString() ?? "";
  await client.app.log({
    body: { service: "shipper", level: exitCode === 0 ? "info" : "error", message: `STATE/HANDOFF: ${checkOut.trim().slice(0, 500)}`, extra: { trigger } },
  });

  // Se hook falhou com exit 2, notifica agentes via throw visível
  if (exitCode === 2) {
    const failMsg = `Shipper hook falhou crítico (exit 2) via ${trigger} — harness deve escalar para builder (max 2) ou humano. Detalhe: ${out.slice(0, 2000)}`;
    await client.app.log({
      body: { service: "shipper", level: "error", message: failMsg },
    });
    // Alerta visível no decorrer do processo — próximo agente/harness verá erro
    throw new Error(`🚨 HOOK_SHIPPER_CRITICAL: ${failMsg} — Log: .planning/HOOKS.log`);
  }
  if (exitCode !== 0 && exitCode !== 2) {
    // Erro não crítico mas deve avisar
    await client.app.log({
      body: { service: "shipper", level: "warn", message: `Shipper hook avisou via ${trigger}: exit ${exitCode} — verifique .planning/HOOKS.log` },
    });
  }

  // Se hook não conseguiu gerar HANDOFF rico (detecta template minimal), instrui fallback para task shipper minimal
  if (out.includes("HANDOFF minimal") || out.includes("fallback")) {
    await client.app.log({
      body: {
        service: "shipper",
        level: "info",
        message: `HANDOFF minimal detectado — harness pode chamar task shipper minimal para enriquecer com PRD/PLAN + resumo/parecer em memória (nunca SUMMARY/REVIEW como arquivos)`,
      },
    });
  }
}

export const ShipperPlugin: Plugin = async ({ $, directory, client }) => {
  return {
    "tool.execute.after": async (input: any, output: any) => {
      const tool: string = input?.tool ?? output?.tool ?? input?.name ?? "";
      const args = output?.args ?? input?.args ?? {};
      try {
        // Trigger 1: task reviewer completa — próximo é shipper, então hook assume
        if (tool === "task") {
          const agent = args?.agent ?? args?.subagent ?? input?.args?.agent ?? "";
          if (agent === "reviewer") {
            await new Promise((r) => setTimeout(r, 1500));
            await runShipper($, directory, client, "task:reviewer");
          }
          if (agent === "shipper") {
            await client.app.log({
              body: { service: "shipper", level: "info", message: "Task shipper detectada — hook já deveria ter rodado; se hasRun=false, fallback minimal será executado pelo agente" },
            });
          }
        }
        // Trigger 2 removido: não há write em REVIEW.md/SUMMARY.md/VALIDATION.md — proibidos (guard-rails bloqueia com HIGH)
        // Mantido compat apenas para detectar tentativa indevida e logar
        if (["write", "edit"].includes(tool)) {
          const fp: string = args?.filePath ?? args?.file ?? args?.path ?? "";
          if (fp.includes("SUMMARY.md") || fp.includes("REVIEW.md") || fp.includes("VALIDATION.md")) {
            await client.app.log({
              body: { service: "shipper", level: "error", message: `🚨 Tentativa de criar artefato proibido detectada: ${fp} — bloqueado por guard-rails (deve ser memória, não arquivo)` },
            });
            // não aciona shipper para artefato proibido; apenas loga
          }
        }
      } catch (err: any) {
        // Garante que erro do shipper seja visível ao agente/harness no decorrer do processo
        await client.app.log({
          body: { service: "shipper", level: "error", message: `🚨 Shipper hook erro visível ao agente: ${err?.message?.slice(0, 1000)} — Log: .planning/HOOKS.log` },
        });
        throw err; // harness/reviewer verá falha
      }
    },

    event: async ({ event }: any) => {
      if (event?.type === "session.idle") {
        const diffCheck = await $`git -C ${directory} diff --stat HEAD 2>&1 | head -5`.text().catch(() => "");
        if (!hasRun && diffCheck.trim().length > 10) {
          try {
            await runShipper($, directory, client, "session.idle");
          } catch (err: any) {
            await client.app.log({
              body: { service: "shipper", level: "error", message: `Shipper hook (idle) falhou: ${err?.message?.slice(0, 800)}` },
            });
          }
        }
      }
    },
  };
};

export default ShipperPlugin;
