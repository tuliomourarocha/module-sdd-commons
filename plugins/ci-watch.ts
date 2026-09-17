/**
 * plugins/ci-watch.ts — Hook determinístico para verificação de CI pós-shipper + loop de correção
 *
 * Conceito: middleware fora do LLM que, após shipper abrir/atualizar PR, verifica CI
 * de forma determinística (polling) e, em caso de falha, sinaliza harness para iniciar
 * loop de correção (builder → reviewer → shipper → ci-watch). Complementa hooks/shipper.py.
 *
 * Acionamento (determinístico, sem depender de LLM decidir):
 *   - Trigger primário: `tool.execute.after` quando `task` com agent `shipper` completa
 *   - Trigger secundário: `tool.execute.after` quando `write` em `.planning/HANDOFF.md` ou `STATE.md`
 *   - Trigger terciário: `event: session.idle` após shipper (fallback) — verifica se HANDOFF existe e shipper já rodou
 *   - Trigger quaternário: `file.edited` em HANDOFF.md (redundância)
 *   - Debounce: roda no máximo 1× por sessão, mas respeita retries (max 2) — verifica .planning/CI_RETRIES.json
 *
 * Orquestração:
 *   - polling via `hooks/ci_watch.py --run --wait --timeout 600 --interval 30`
 *   - exit 0 = CI verde → done → supervisor
 *   - exit 2 = CI falhou → throw `🚨 CI_FAILED_NEEDS_FIX` → harness escala para `task builder` com contexto CI_REPORT (max 2)
 *   - exit 3 = CI pending timeout → warn, não loopa, mas loga para re-poll manual
 *   - exit 1 = infra/unknown → warn, notifica para verificar `gh auth`
 *
 * Retry tracking:
 *   - Lê `.planning/CI_RETRIES.json` {retries, max_retries}
 *   - Se retries >= max_retries e CI ainda fail, lança `🚨 CI_RETRIES_EXHAUSTED` para escalar humano
 *   - Incrementa retries somente quando harness de fato re-chama builder (via plugin detectar novo ciclo). Aqui apenas lê.
 *
 * Instalação: copiado para `.opencode/plugins/ci-watch.ts` via bin/sdd-harness.js
 * Requer: python3, hooks/ci_watch.py, gh CLI (opcional), git
 */

import type { Plugin } from "@opencode-ai/plugin";

const CI_REPO = process.env.SHIPPER_REPO ?? process.env.CI_REPO ?? process.env.SUPERVISOR_REPO ?? "tuliomourarocha/module-sdd-commons";
const DEFAULT_TIMEOUT = parseInt(process.env.CI_WATCH_TIMEOUT ?? "600", 10);
const DEFAULT_INTERVAL = parseInt(process.env.CI_WATCH_INTERVAL ?? "30", 10);
const MAX_RETRIES = parseInt(process.env.CI_WATCH_MAX_RETRIES ?? "2", 10);

let hasRun = false;
let ciWatchRetries = 0;

async function writeGuaranteeLog($: any, directory: string, entry: Record<string, any>) {
  const line = JSON.stringify(entry);
  await $`mkdir -p ${directory}/.planning && mkdir -p ${directory}/.opencode/hooks`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.planning/HOOKS.log`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.opencode/hooks/hook-audit.jsonl`.nothrow().quiet();
}

async function readRetryCount($: any, directory: string): Promise<number> {
  try {
    const txt = await $`cat ${directory}/.planning/CI_RETRIES.json 2>&1`.text().catch(() => "");
    if (txt) {
      const j = JSON.parse(txt);
      return Number(j.retries ?? j.count ?? 0) || 0;
    }
  } catch {}
  try {
    const state = await $`cat ${directory}/.planning/STATE.md 2>&1`.text().catch(() => "");
    const m = state.match(/CI retries.*?(\d+)/i);
    if (m) return parseInt(m[1], 10) || 0;
  } catch {}
  return ciWatchRetries;
}

async function writeRetryCount($: any, directory: string, retries: number) {
  const entry = JSON.stringify({ retries, updated: new Date().toISOString(), max_retries: MAX_RETRIES });
  await $`mkdir -p ${directory}/.planning && echo '${entry.replace(/'/g, "'\\''")}' > ${directory}/.planning/CI_RETRIES.json`.nothrow().quiet();
  ciWatchRetries = retries;
}

async function runCIWatch($: any, directory: string, client: any, trigger: string) {
  // Debounce: se já rodou nesta sessão e não é retry explícito, ignora
  // Mas permite re-run se CI_RETRIES.json indica novo ciclo (harness incrementou)
  const currentRetries = await readRetryCount($, directory);
  if (hasRun) {
    // verifica se houve incremento de retry desde última execução (indica novo ciclo harness)
    if (currentRetries <= ciWatchRetries) {
      await client.app.log({
        body: { service: "ci-watch", level: "info", message: `CI watch já executado (trigger ${trigger} ignorado, retries ${currentRetries}/${MAX_RETRIES})` },
      });
      return;
    } else {
      // novo ciclo detectado
      await client.app.log({
        body: { service: "ci-watch", level: "info", message: `CI watch re-executando — novo ciclo detectado (retries ${currentRetries}, trigger ${trigger})` },
      });
    }
  }

  hasRun = true;
  ciWatchRetries = currentRetries;
  const triggerTs = new Date().toISOString();

  // Verifica se PR existe antes de polling (evita poll desnecessário)
  const prCheck = await $`gh pr view --json number 2>&1 | head -5`.nothrow().quiet();
  const prOut = prCheck.stdout?.toString() ?? prCheck.stderr?.toString() ?? "";
  const hasPR = prOut.includes("number") || prOut.includes('"number"');

  // Se não há PR, não é erro crítico — apenas loga
  if (!hasPR && prCheck.exitCode !== 0) {
    const warn = `Sem PR detectado via ${trigger} — ci-watch pulado (gh pr view falhou). Verifique gh auth.`;
    await client.app.log({ body: { service: "ci-watch", level: "warn", message: warn, extra: { trigger, prOut: prOut.slice(0, 500) } } });
    await writeGuaranteeLog($, directory, {
      ts: triggerTs,
      hook: "ci-watch",
      trigger,
      duration_ms: 0,
      exit_code: 1,
      status: "skipped_no_pr",
      message: warn,
    });
    hasRun = false; // permite tentar novamente quando PR existir
    return;
  }

  const hookCandidates = [`${directory}/.opencode/hooks/ci_watch.py`, `${directory}/hooks/ci_watch.py`];
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
    const errMsg = `hooks/ci_watch.py não encontrado via ${trigger} — ci-watch não executado`;
    await client.app.log({ body: { service: "ci-watch", level: "error", message: errMsg } });
    await writeGuaranteeLog($, directory, {
      ts: triggerTs,
      hook: "ci-watch",
      trigger,
      duration_ms: 0,
      exit_code: 127,
      status: "error",
      error: "hook_not_found",
      message: errMsg,
    });
    throw new Error(`🚨 HOOK_CI_WATCH_ERROR: ${errMsg} — verifique hooks/ci_watch.py existe. Log: .planning/HOOKS.log`);
  }

  await client.app.log({
    body: { service: "ci-watch", level: "info", message: `🔍 CI watch acionado via ${trigger} — polling CI (timeout ${DEFAULT_TIMEOUT}s, interval ${DEFAULT_INTERVAL}s, retries ${currentRetries}/${MAX_RETRIES})...` },
  });
  await writeGuaranteeLog($, directory, {
    ts: triggerTs,
    hook: "ci-watch",
    trigger,
    duration_ms: 0,
    exit_code: null,
    status: "started",
    message: `CI watch iniciado via ${trigger} timeout=${DEFAULT_TIMEOUT}s`,
  });

  const start = Date.now();
  // Executa python hook com wait polling
  const result = await $`python3 ${hook} --run --wait --repo ${directory} --repo-slug ${CI_REPO} --timeout ${DEFAULT_TIMEOUT} --interval ${DEFAULT_INTERVAL} --max-retries ${MAX_RETRIES} 2>&1`.nothrow().quiet();
  const out: string = result.stdout?.toString() ?? "";
  const err: string = result.stderr?.toString() ?? "";
  const exitCode: number = result.exitCode ?? 0;
  const duration = Date.now() - start;

  const level = exitCode === 0 ? "info" : exitCode === 2 ? "error" : exitCode === 3 ? "warn" : "warn";
  await client.app.log({
    body: {
      service: "ci-watch",
      level,
      message: `CI watch finalizado (${duration}ms, exit ${exitCode}) via ${trigger}`,
      extra: { trigger, stdout: out.slice(0, 4000), stderr: err.slice(0, 1000), exitCode, duration },
    },
  });

  // Log garantia de conclusão
  const statusMap: Record<number, string> = { 0: "success", 2: "failed_needs_fix", 3: "pending_timeout", 1: "unknown" };
  await writeGuaranteeLog($, directory, {
    ts: new Date().toISOString(),
    hook: "ci-watch",
    trigger,
    duration_ms: duration,
    exit_code: exitCode,
    status: statusMap[exitCode] ?? `exit_${exitCode}`,
    stdout: out.slice(0, 2000),
    stderr: err.slice(0, 1000),
    retries: currentRetries,
  });

  // Verifica se CI_REPORT foi gerado
  const checkReport = await $`ls -lh ${directory}/.planning/CI_REPORT.md 2>&1 | head -5`.nothrow().quiet();
  const checkOut = checkReport.stdout?.toString() ?? checkReport.stderr?.toString() ?? "";
  await client.app.log({
    body: { service: "ci-watch", level: exitCode === 0 ? "info" : "warn", message: `CI_REPORT: ${checkOut.trim().slice(0, 500)}`, extra: { trigger } },
  });

  if (exitCode === 0) {
    // CI verde — sucesso, vai para supervisor
    await client.app.log({
      body: { service: "ci-watch", level: "info", message: `✅ CI verde — PR pronto. Supervisor será acionado em seguida.` },
    });
    // Reseta retries ao suceder (opcional)
    if (currentRetries > 0) {
      await writeRetryCount($, directory, 0);
    }
    return;
  }

  if (exitCode === 2) {
    // CI falhou — precisa loop correção
    const retriesNow = await readRetryCount($, directory);
    if (retriesNow >= MAX_RETRIES) {
      const failMsg = `CI falhou e retries esgotados (${retriesNow}/${MAX_RETRIES}) via ${trigger} — escalar para humano. Veja .planning/CI_REPORT.md e .planning/HOOKS.log`;
      await client.app.log({ body: { service: "ci-watch", level: "error", message: failMsg } });
      await writeGuaranteeLog($, directory, {
        ts: new Date().toISOString(),
        hook: "ci-watch",
        trigger,
        duration_ms: duration,
        exit_code: 2,
        status: "retries_exhausted",
        retries: retriesNow,
        message: failMsg,
      });
      throw new Error(`🚨 CI_RETRIES_EXHAUSTED: ${failMsg} — Log: .planning/CI_REPORT.md — ${out.slice(0, 1500)}`);
    }
    // Ainda há retries: sinaliza harness para loop builder
    const nextRetry = retriesNow + 1;
    await writeRetryCount($, directory, nextRetry);
    // Permite próximo ciclo re-executar (reset hasRun para próxima verificação pós-fix)
    hasRun = false;
    const fixMsg = `CI falhou (exit 2) via ${trigger} — retry ${nextRetry}/${MAX_RETRIES} — harness deve reiniciar builder (max 2) com contexto CI_REPORT.md. Detalhe: ${out.slice(0, 2000)}`;
    await client.app.log({ body: { service: "ci-watch", level: "error", message: fixMsg } });
    // Lança erro visível que harness deve capturar para loop
    throw new Error(
      `🚨 CI_FAILED_NEEDS_FIX (retry ${nextRetry}/${MAX_RETRIES}): CI falhou — builder deve corrigir com base em .planning/CI_REPORT.md\n` +
        `${out.slice(0, 3000)}\n\n` +
        `Instrução para harness: task("builder", context:{PLAN, SUMMARY, CI_REPORT em .planning/CI_REPORT.md}) max 2. Log: .planning/HOOKS.log`
    );
  }

  if (exitCode === 3) {
    // Timeout pending — não falha CI, apenas avisa
    await client.app.log({
      body: {
        service: "ci-watch",
        level: "warn",
        message: `⏳ CI ainda pendente após ${DEFAULT_TIMEOUT}s via ${trigger} (exit 3) — não inicia loop de correção. Re-poll manualmente: python3 hooks/ci_watch.py --run --wait --timeout 600. Log: .planning/CI_REPORT.md`,
      },
    });
    // não throw — apenas aviso; próximo session.idle tentará novamente se hasRun reset
    hasRun = false; // permite re-poll posterior
    return;
  }

  // exit 1 ou outro: infra/unknown
  await client.app.log({
    body: {
      service: "ci-watch",
      level: "warn",
      message: `CI watch retornou exit ${exitCode} via ${trigger} (unknown/infra) — verifique gh auth e Actions tab. Log: .planning/HOOKS.log`,
    },
  });
  // não bloqueia fluxo, mas avisa
}

export const CIWatchPlugin: Plugin = async ({ $, directory, client }) => {
  return {
    "tool.execute.after": async (input: any, output: any) => {
      const tool: string = input?.tool ?? output?.tool ?? input?.name ?? "";
      const args = output?.args ?? input?.args ?? {};
      try {
        // Trigger 1: task shipper completa — inicia ci-watch
        if (tool === "task") {
          const agent = args?.agent ?? args?.subagent ?? input?.args?.agent ?? "";
          if (agent === "shipper") {
            await new Promise((r) => setTimeout(r, 2000));
            await runCIWatch($, directory, client, "task:shipper");
          }
          // Também detecta ci-watch já falhou e harness re-chamou builder → quando builder completa, novo shipper → ci-watch novamente
          // Não precisa ação para builder/reviewer aqui
        }
        // Trigger 2: write em HANDOFF.md / STATE.md / CI_REPORT.md
        if (["write", "edit"].includes(tool)) {
          const fp: string = args?.filePath ?? args?.file ?? args?.path ?? "";
          if (fp.includes(".planning/HANDOFF.md") || fp.includes(".planning/STATE.md")) {
            await new Promise((r) => setTimeout(r, 2500));
            await runCIWatch($, directory, client, `write:${fp.split("/").pop()}`);
          }
        }
      } catch (err: any) {
        await client.app.log({
          body: { service: "ci-watch", level: "error", message: `🚨 CI watch erro visível ao harness: ${err?.message?.slice(0, 1200)} — Log: .planning/CI_REPORT.md / .planning/HOOKS.log` },
        });
        throw err; // harness vê e decide loop
      }
    },

    event: async ({ event }: any) => {
      if (event?.type === "session.idle") {
        // Só executa se HANDOFF existe e ainda não rodou (ou retry pendente)
        const check = await $`test -f ${directory}/.planning/HANDOFF.md && echo ok`.text().catch(() => "");
        if (!check.includes("ok")) return;
        // Se já rodou e não há retry pendente, não re-executa em idle
        const retries = await readRetryCount($, directory);
        if (hasRun && retries <= ciWatchRetries) return;
        // adicional: verifica se houve push recente (diff) ou PR checks pending
        const diffCheck = await $`git -C ${directory} diff --stat HEAD 2>&1 | head -5`.text().catch(() => "");
        // Se já existe CI_REPORT com pass, não repolla desnecessariamente
        const reportStatus = await $`grep -m1 '"status":' ${directory}/.planning/ci_metrics.json 2>&1 | head -1`.text().catch(() => "");
        if (reportStatus.includes('"pass"') && hasRun) return;
        try {
          await runCIWatch($, directory, client, "session.idle");
        } catch (err: any) {
          await client.app.log({
            body: { service: "ci-watch", level: "error", message: `CI watch (idle) falhou: ${err?.message?.slice(0, 800)}` },
          });
        }
      }
      if (event?.type === "file.edited" || event?.type === "file.watcher.updated") {
        const fp: string = event?.properties?.path ?? event?.path ?? "";
        if (fp.includes(".planning/HANDOFF.md") && !hasRun) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            await runCIWatch($, directory, client, "file.edited:HANDOFF.md");
          } catch (err: any) {
            await client.app.log({
              body: { service: "ci-watch", level: "error", message: `CI watch (file.edited) falhou: ${err?.message?.slice(0, 800)}` },
            });
          }
        }
      }
    },
  };
};

export default CIWatchPlugin;
