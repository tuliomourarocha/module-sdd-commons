/**
 * plugins/ci-watch.ts — Hook determinístico para verificação de CI pós-shipper + loop de correção
 *
 * Conceito: middleware fora do LLM que, após shipper abrir/atualizar PR, verifica CI
 * de forma determinística (polling) e, em caso de falha, sinaliza harness para iniciar
 * loop de correção (builder → reviewer → shipper → ci-watch). Complementa hooks/shipper.py.
 * Persistência: **atualiza `.planning/HANDOFF.md` (marcadores CI_REPORT:START) e `.planning/STATE.md` (CI_STATE)**
 * ao invés de criar `.planning/CI_REPORT.md`/`ci_metrics.json` separados — single invocation.
 *
 * Acionamento (determinístico, sem depender de LLM decidir):
 *   - Trigger primário: `tool.execute.after` quando `task` com agent `shipper` completa
 *   - Trigger secundário: `tool.execute.after` quando `write` em `.planning/HANDOFF.md` ou `STATE.md`
 *   - Trigger terciário: `event: session.idle` após shipper (fallback) — verifica se HANDOFF existe e shipper já rodou
 *   - Trigger quaternário: `file.edited` em HANDOFF.md (redundância)
 *   - Debounce: roda no máximo 1× por sessão harness (single-run), mas respeita retries (max 2) via STATE.md (CI_STATE)
 *   - Harness permanece bloqueante até CI finalizar (não re-invoca harness externamente)
 *
 * Orquestração (single harness run):
 *   - polling via `hooks/ci_watch.py --run --wait --timeout 600 --interval 30` (bloqueante, até pass/fail)
 *   - exit 0 = CI verde → done → supervisor (mesma sessão harness)
 *   - exit 2 = CI falhou → throw `🚨 CI_FAILED_NEEDS_FIX` → harness (mesma run) escala para `task builder` com contexto HANDOFF/STATE (max 2)
 *   - exit 3 = CI pending timeout → warn, harness aguarda re-poll sem encerrar (não loopa imediatamente)
 *   - exit 1 = infra/unknown → warn, notifica para verificar `gh auth`
 *
 * Retry tracking:
 *   - Lê retries de `STATE.md` (bloco CI_STATE) + fallback legado `.planning/CI_RETRIES.json` se env legado
 *   - Se retries >= max_retries e CI ainda fail, lança `🚨 CI_RETRIES_EXHAUSTED` para escalar humano (ainda dentro da mesma sessão harness)
 *   - Incrementa retries dentro da mesma sessão e atualiza STATE.md — não requer nova invocação harness
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
  // Prioridade: STATE.md (CI_STATE) — exigência de não criar artefactos separados
  try {
    const state = await $`cat ${directory}/.planning/STATE.md 2>&1`.text().catch(() => "");
    // procura padrão "Retries: X/Y" dentro do bloco CI_STATE ou linha "CI retries"
    let m = state.match(/Retries:\s*(\d+)\s*\//i);
    if (m) return parseInt(m[1], 10) || 0;
    m = state.match(/CI retries.*?(\d+)/i);
    if (m) return parseInt(m[1], 10) || 0;
    m = state.match(/CI_STATE[\s\S]*?retries["']?\s*[:=]\s*(\d+)/i);
    if (m) return parseInt(m[1], 10) || 0;
  } catch {}
  // fallback legado CI_RETRIES.json apenas se existir (transição)
  try {
    const txt = await $`cat ${directory}/.planning/CI_RETRIES.json 2>&1`.text().catch(() => "");
    if (txt && !txt.includes("No such")) {
      const j = JSON.parse(txt);
      return Number(j.retries ?? j.count ?? 0) || 0;
    }
  } catch {}
  return ciWatchRetries;
}

async function writeRetryCount($: any, directory: string, retries: number) {
  // Novo: atualiza STATE.md (bloco CI_STATE) ao invés de criar arquivo separado
  // Mantém compatibilidade: também escreve CI_RETRIES.json apenas se legacy env ativo
  try {
    const statePath = `${directory}/.planning/STATE.md`;
    const hasState = await $`test -f ${statePath} && echo ok`.text().catch(() => "");
    if (hasState.includes("ok")) {
      // Atualiza retries dentro do bloco CI_STATE via sed inline se marcador existir
      // fallback simples: se não houver marcador CI_STATE, anexa linha de retries
      const hasMarker = await $`grep -c "CI_STATE:START" ${statePath} 2>&1`.text().catch(() => "0");
      if (hasMarker.trim() !== "0" && !hasMarker.includes("No such")) {
        // usa python para edição idempotente (evitar sed portabilidade)
        await $`python3 -c "
import re, pathlib
p=pathlib.Path('${statePath}')
t=p.read_text(encoding='utf-8', errors='ignore')
# substitui 'Retries: X/Y' por novo valor se existir
new = re.sub(r'Retries:\s*\d+\s*/', f'Retries: ${retries}/', t)
if new == t:
    # se não havia padrão, tenta inserir após CI_STATE:START
    new = t.replace('<!-- CI_STATE:START -->', '<!-- CI_STATE:START -->\n- **Retries (atualizado):** ${retries}/${MAX_RETRIES}')
p.write_text(new, encoding='utf-8')
" 2>&1`.nothrow().quiet();
      }
    }
  } catch {}
  // legado opcional
  if (process.env.CI_WATCH_LEGACY === "1") {
    const entry = JSON.stringify({ retries, updated: new Date().toISOString(), max_retries: MAX_RETRIES });
    await $`mkdir -p ${directory}/.planning && echo '${entry.replace(/'/g, "'\\''")}' > ${directory}/.planning/CI_RETRIES.json`.nothrow().quiet();
  }
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

  // Verifica que HANDOFF/STATE foram atualizados (nova persistência)
  const checkHandoff = await $`grep -c "CI_REPORT:START" ${directory}/.planning/HANDOFF.md 2>&1 | head -5`.nothrow().quiet();
  const checkState = await $`grep -c "CI_STATE:START" ${directory}/.planning/STATE.md 2>&1 | head -5`.nothrow().quiet();
  const handoffMark = (checkHandoff.stdout?.toString() ?? "").trim();
  const stateMark = (checkState.stdout?.toString() ?? "").trim();
  const hasCIReport = handoffMark !== "0" && !handoffMark.includes("No such");
  await client.app.log({
    body: {
      service: "ci-watch",
      level: hasCIReport ? "info" : "warn",
      message: hasCIReport
        ? `✅ CI report persistido em HANDOFF.md (CI_REPORT:START) e STATE.md (CI_STATE) — status ${exitCode}`
        : `⚠️ CI markers não encontrados em HANDOFF/STATE — verifique hook output`,
      extra: { trigger, handoffMark: handoffMark.slice(0, 200), stateMark: stateMark.slice(0, 200) },
    },
  });
  // Legado opcional log
  const legacyCheck = await $`ls -lh ${directory}/.planning/CI_REPORT.md 2>&1 | head -2`.nothrow().quiet();
  const legacyOut = legacyCheck.stdout?.toString() ?? "";
  if (legacyOut.includes("CI_REPORT")) {
    await client.app.log({ body: { service: "ci-watch", level: "info", message: `Legado CI_REPORT.md (ignorado): ${legacyOut.trim().slice(0, 300)}` } });
  }

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
    // CI falhou — precisa loop correção (mesma sessão harness, sem re-invocar)
    const retriesNow = await readRetryCount($, directory);
    if (retriesNow >= MAX_RETRIES) {
      const failMsg = `CI falhou e retries esgotados (${retriesNow}/${MAX_RETRIES}) via ${trigger} — escalar para humano. Veja HANDOFF.md seção CI_REPORT e .planning/HOOKS.log (single harness run)`;
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
      throw new Error(`🚨 CI_RETRIES_EXHAUSTED: ${failMsg} — Log: HANDOFF.md#CI_REPORT / .planning/HOOKS.log — ${out.slice(0, 1500)}`);
    }
    // Ainda há retries: sinaliza harness para loop builder dentro da mesma run (bloqueante)
    const nextRetry = retriesNow + 1;
    await writeRetryCount($, directory, nextRetry);
    // Permite próximo ciclo re-executar (reset hasRun para próxima verificação pós-fix) — harness permanece vivo
    hasRun = false;
    const fixMsg = `CI falhou (exit 2) via ${trigger} — retry ${nextRetry}/${MAX_RETRIES} — harness (single run) deve reiniciar builder (max 2) com contexto HANDOFF.md/STATE.md (CI_REPORT:START). Detalhe: ${out.slice(0, 2000)}`;
    await client.app.log({ body: { service: "ci-watch", level: "error", message: fixMsg } });
    // Lança erro visível que harness (single invocation) deve capturar para loop sem re-invocar
    throw new Error(
      `🚨 CI_FAILED_NEEDS_FIX (retry ${nextRetry}/${MAX_RETRIES}): CI falhou — builder deve corrigir com base em HANDOFF.md seção CI_REPORT:START + STATE.md CI_STATE (sem criar artefactos separados)\n` +
        `${out.slice(0, 3000)}\n\n` +
        `Instrução para harness (single run, bloqueante): task("builder", context:{PLAN, resumo, CI_REPORT extraído de .planning/HANDOFF.md#CI_REPORT:START}) max 2 (nunca SUMMARY.md/REVIEW.md em disco). Harness permanece bloqueado até verde — não re-invocar externamente. Log: .planning/HOOKS.log`
    );
  }

  if (exitCode === 3) {
    // Timeout pending — não falha CI, apenas avisa (harness permanece vivo, não re-invoca)
    await client.app.log({
      body: {
        service: "ci-watch",
        level: "warn",
        message: `⏳ CI ainda pendente após ${DEFAULT_TIMEOUT}s via ${trigger} (exit 3) — harness permanece bloqueado, aguardando re-poll (não inicia loop correção). Re-poll automático via session.idle ou manual: python3 hooks/ci_watch.py --run --wait --timeout 600. Log: HANDOFF.md#CI_REPORT / STATE.md#CI_STATE`,
      },
    });
    // não throw — apenas aviso; próximo session.idle tentará novamente se hasRun reset, mesma sessão harness
    hasRun = false; // permite re-poll posterior dentro da mesma harness run
    return;
  }

  // exit 1 ou outro: infra/unknown
  await client.app.log({
    body: {
      service: "ci-watch",
      level: "warn",
      message: `CI watch retornou exit ${exitCode} via ${trigger} (unknown/infra) — verifique gh auth e Actions tab. Harness permanece vivo (single run). Log: .planning/HOOKS.log / HANDOFF.md`,
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
          body: { service: "ci-watch", level: "error", message: `🚨 CI watch erro visível ao harness (single run): ${err?.message?.slice(0, 1200)} — Log: HANDOFF.md#CI_REPORT / STATE.md / .planning/HOOKS.log` },
        });
        throw err; // harness (mesma run, bloqueante) vê e decide loop sem re-invocar
      }
    },

    event: async ({ event }: any) => {
      if (event?.type === "session.idle") {
        // Só executa se HANDOFF existe e ainda não rodou (ou retry pendente) — single harness run, não re-invoca
        const check = await $`test -f ${directory}/.planning/HANDOFF.md && echo ok`.text().catch(() => "");
        if (!check.includes("ok")) return;
        // Se já rodou e não há retry pendente, não re-executa em idle
        const retries = await readRetryCount($, directory);
        if (hasRun && retries <= ciWatchRetries) return;
        // Se já existe CI_STATE com pass em STATE.md, não repolla desnecessariamente (harness já verde)
        const stateCheck = await $`grep -A2 "CI_STATE:START" ${directory}/.planning/STATE.md 2>&1 | grep -i "pass" | head -1`.text().catch(() => "");
        const handoffPass = await $`grep -A2 "CI_REPORT:START" ${directory}/.planning/HANDOFF.md 2>&1 | grep -i "pass" | head -1`.text().catch(() => "");
        if ((stateCheck.includes("pass") || handoffPass.includes("pass")) && hasRun) return;
        // também verifica legado ci_metrics.json se existir (compat)
        const legacyStatus = await $`cat ${directory}/.planning/ci_metrics.json 2>&1 | grep -m1 '"status"' | head -1`.text().catch(() => "");
        if (legacyStatus.includes('"pass"') && hasRun) return;
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
