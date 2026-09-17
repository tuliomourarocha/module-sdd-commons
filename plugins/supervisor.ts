/**
 * plugins/supervisor.ts — Hook determinístico supervisor final (OpenCode)
 *
 * Conceito: middleware fora do LLM no final do ciclo que:
 *   1. Roda `hooks/supervisor.py` determinístico (métricas performance, tokens, alucinações) — atualiza HANDOFF.md/STATE.md (marcadores SUPERVISOR:START) ao invés de criar SUPERVISOR_REPORT.md
 *   2. Invoca agente `supervisor` (LLM com prompt fechado) para julgamento qualitativo
 *   3. Cria Issue no repo `tuliomourarocha/module-sdd-commons` com output
 *
 * Persistência: apenas HANDOFF.md e STATE.md (single source; sem artefactos separados). Hook python escreve seções idempotentes.
 * Harness single-run: supervisor roda bloqueante dentro da mesma sessão harness; não requer re-invocar harness.
 *
 * Acionamento (determinístico, sem depender de LLM decidir):
 *   - Trigger primário: `tool.execute.after` quando `write` em `.planning/HANDOFF.md` ou `STATE.md` (shipper)
 *   - Trigger secundário: `tool.execute.after` quando `task` com agent `shipper` completa
 *   - Trigger terciário: `event: session.idle` após shipper (fallback)
 *   - Debounce: roda no máximo 1x por sessão (flag global); harness permanece vivo até supervisor concluir (não re-invoca)
 *
 * Instalação: copiado para `.opencode/plugins/supervisor.ts` via bin/sdd-harness.js
 * Requer: python3, hooks/supervisor.py, gh CLI (opcional, se ausente auditoria já em HANDOFF/STATE)
 */

import type { Plugin } from "@opencode-ai/plugin";

const SUPERVISOR_REPO = process.env.SUPERVISOR_REPO ?? "tuliomourarocha/module-sdd-commons";
let hasRun = false;

async function writeGuaranteeLog($: any, directory: string, entry: Record<string, any>) {
  const line = JSON.stringify(entry);
  await $`mkdir -p ${directory}/.planning && mkdir -p ${directory}/.opencode/hooks`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.planning/HOOKS.log`.nothrow().quiet();
  await $`echo '${line.replace(/'/g, "'\\''")}' >> ${directory}/.opencode/hooks/hook-audit.jsonl`.nothrow().quiet();
}

async function runSupervisor($: any, directory: string, client: any, trigger: string) {
  if (hasRun) {
    await client.app.log({
      body: { service: "supervisor", level: "info", message: `Supervisor já executado nesta sessão (trigger ${trigger} ignorado)` },
    });
    return;
  }
  hasRun = true;
  const triggerTs = new Date().toISOString();

  const hookCandidates = [
    `${directory}/.opencode/hooks/supervisor.py`,
    `${directory}/hooks/supervisor.py`,
  ];
  let hook: string | null = null;
  for (const c of hookCandidates) {
    const ok = await $`test -f ${c} && echo ok`.text().catch(() => "");
    if (ok.includes("ok")) {
      hook = c;
      break;
    }
  }
  if (!hook) {
    const errMsg = `hooks/supervisor.py não encontrado via ${trigger}`;
    await client.app.log({
      body: { service: "supervisor", level: "error", message: errMsg },
    });
    await writeGuaranteeLog($, directory, {
      ts: triggerTs,
      hook: "supervisor",
      trigger,
      duration_ms: 0,
      exit_code: 127,
      status: "error",
      error: "hook_not_found",
      message: errMsg,
    });
    throw new Error(`🚨 HOOK_SUPERVISOR_ERROR: ${errMsg} — Log: .planning/HOOKS.log`);
  }

  await client.app.log({
    body: { service: "supervisor", level: "info", message: `🤖 Supervisor hook acionado via ${trigger} — rodando auditoria determinística...` },
  });
  await writeGuaranteeLog($, directory, {
    ts: triggerTs,
    hook: "supervisor",
    trigger,
    duration_ms: 0,
    exit_code: null,
    status: "started",
    message: `Supervisor hook iniciado via ${trigger}`,
  });

  // 1. Roda auditoria determinística (python) — mede performance, tokens (heurística), alucinações
  const start = Date.now();
  // Novo comportamento: supervisor atualiza HANDOFF.md/STATE.md diretamente (marcadores SUPERVISOR:START), não cria arquivos separados
  // Mantém --dry-run por default no plugin? Removido dry-run para persistir em HANDOFF/STATE e permitir harness single-run
  const pyResult = await $`python3 ${hook} --run --repo ${directory} --repo-slug ${SUPERVISOR_REPO} 2>&1`.nothrow().quiet();
  const pyOut: string = pyResult.stdout?.toString() ?? "";
  const pyErr: string = pyResult.stderr?.toString() ?? "";
  const duration = Date.now() - start;

  await client.app.log({
    body: {
      service: "supervisor",
      level: pyResult.exitCode === 0 ? "info" : pyResult.exitCode === 2 ? "error" : "warn",
      message: `Supervisor determinístico finalizado (${duration}ms, exit ${pyResult.exitCode}) — HANDOFF/STATE atualizados`,
      extra: { trigger, stdout: pyOut.slice(0, 4000), stderr: pyErr.slice(0, 1000) },
    },
  });
  await writeGuaranteeLog($, directory, {
    ts: new Date().toISOString(),
    hook: "supervisor",
    trigger,
    duration_ms: duration,
    exit_code: pyResult.exitCode ?? 0,
    status: pyResult.exitCode === 0 ? "success" : pyResult.exitCode === 2 ? "critical" : "warn",
    stdout: pyOut.slice(0, 2000),
    stderr: pyErr.slice(0, 1000),
  });
  if ((pyResult.exitCode ?? 0) === 2) {
    await client.app.log({
      body: { service: "supervisor", level: "error", message: `🚨 Supervisor hook crítico (exit 2) via ${trigger} — veja .planning/HOOKS.log` },
    });
    throw new Error(`🚨 HOOK_SUPERVISOR_CRITICAL via ${trigger} — Log: .planning/HOOKS.log — ${pyOut.slice(0, 800)}`);
  }

  // Verifica que HANDOFF/STATE foram atualizados (nova persistência) — ao invés de SUPERVISOR_REPORT.md
  const handoffPath = `${directory}/.planning/HANDOFF.md`;
  const statePath = `${directory}/.planning/STATE.md`;
  const checkHandoff = await $`grep -c "SUPERVISOR:START" ${handoffPath} 2>&1 | head -1`.nothrow().quiet();
  const checkState = await $`grep -c "SUPERVISOR_STATE:START" ${statePath} 2>&1 | head -1`.nothrow().quiet();
  const hasSupervisorInHandoff = (checkHandoff.stdout?.toString() ?? "").trim() !== "0" && !checkHandoff.stdout?.toString().includes("No such");
  await client.app.log({
    body: {
      service: "supervisor",
      level: hasSupervisorInHandoff ? "info" : "warn",
      message: hasSupervisorInHandoff ? `✅ Supervisor persistido em HANDOFF/STATE (ver marcadores SUPERVISOR:START)` : `⚠️ Supervisor markers não encontrados — verifique HANDOFF.md`,
      extra: { handoffPath, statePath, handoffCheck: checkHandoff.stdout?.toString().slice(0, 200), stateCheck: checkState.stdout?.toString().slice(0, 200) },
    },
  });
  // Mantém compat: se ainda existirem arquivos legados, loga mas não exige
  const legacyReport = `${directory}/.planning/SUPERVISOR_REPORT.md`;
  await $`ls -lh ${legacyReport} 2>&1 | head -1`.nothrow().quiet().then(async (r: any) => {
    const out = r.stdout?.toString() ?? "";
    if (out.includes("SUPERVISOR_REPORT")) {
      await client.app.log({ body: { service: "supervisor", level: "info", message: `Legado REPORT (ignorado): ${out.trim()}`, extra: { legacyReport } } });
    }
  });

  // 2. Invoca agente supervisor (LLM) para análise qualitativa — se disponível
  // Novo: O agente supervisor lê HANDOFF.md (seção SUPERVISOR:START) + STATE.md (SUPERVISOR_STATE) + git diff — não há mais SUPERVISOR_REPORT.md separado
  try {
    const supervisorPrompt = `
Você é o agente SUPERVISOR. Analise o relatório determinístico embarcado em ${handoffPath} (marcadores SUPERVISOR:START/END) e ${statePath}.

Tarefas:
1. Leia ${handoffPath} (grep SUPERVISOR:START), ${statePath} (SUPERVISOR_STATE:START) e git diff --stat HEAD
2. Valide alucinações listadas (confirme ou marque como falso positivo)
3. Avalie: performance (duração gates), qualidade código, aderência PLAN vs entregue, segurança residual
4. Estime tokens reais se houver logs em .opencode/ (senão mantenha heurística)
5. Crie/atualize Issue no repo ${SUPERVISOR_REPO} via \`gh issue create\` com body extraído de HANDOFF (SUPERVISOR:START) + seu julgamento
   - Título: "[Supervisor] Auditoria {data} — {n} HIGH"
   - Labels: supervisor, automated, hallucination (se HIGH), guard-rails-blocked (se HIGH), ci-failure (se falhou)
   - Se gh ausente, apenas confirme markdown salvo em HANDOFF/STATE

Trigger: ${trigger}
Relatório determinístico (trecho — extraído de HANDOFF/STATE):
${pyOut.slice(0, 6000)}
`.trim();

    // Não cria SUPERVISOR_PROMPT.md separado por padrão — injeta prompt via STATE/HANDOFF se necessário
    // Mantém compat: cria apenas se legacy env
    if (process.env.SUPERVISOR_LEGACY === "1") {
      const promptFile = `${directory}/.planning/SUPERVISOR_PROMPT.md`;
      await $`mkdir -p ${directory}/.planning && cat > ${promptFile} << 'EOSUP'
${supervisorPrompt}
EOSUP`.nothrow().quiet();
      await client.app.log({
        body: { service: "supervisor", level: "info", message: `Prompt supervisor (legado) salvo em ${promptFile}`, extra: { promptFile, handoffPath } },
      });
    } else {
      await client.app.log({
        body: { service: "supervisor", level: "info", message: `Prompt supervisor mantido em memória (HANDOFF/STATE já contém auditoria) — sem criar SUPERVISOR_PROMPT.md`, extra: { handoffPath, statePath } },
      });
    }

    // Tenta disparar criação de issue imediatamente via gh (determinístico, sem LLM)
    const ghCheck = await $`which gh 2>&1`.nothrow().quiet();
    if (ghCheck.exitCode === 0) {
      const title = `[Supervisor] Auditoria ${(new Date()).toISOString().slice(0,16)} — trigger ${trigger}`;
      // Extrai seção supervisor de HANDOFF.md para body (fallback para pyOut se grep falhar)
      const extracted = await $`sed -n '/SUPERVISOR:START/,/SUPERVISOR:END/p' ${handoffPath} 2>&1 | head -c 20000`.nothrow().quiet();
      const bodyTmp = `${directory}/.planning/.supervisor_body.tmp`;
      const extractedText = (extracted.stdout?.toString() ?? "").trim();
      const bodyContent = extractedText.length > 200 ? extractedText : pyOut.slice(0, 15000);
      await $`cat > ${bodyTmp} << 'EOSBODY'
${bodyContent}
EOSBODY`.nothrow().quiet();
      const create = await $`gh issue create --repo ${SUPERVISOR_REPO} --title ${title} --body-file ${bodyTmp} --label supervisor --label automated 2>&1`.nothrow().quiet();
      const createOut = create.stdout?.toString() ?? create.stderr?.toString() ?? "";
      await client.app.log({
        body: {
          service: "supervisor",
          level: create.exitCode === 0 ? "info" : "warn",
          message: create.exitCode === 0 ? `✅ Issue criada: ${createOut.slice(0,500)}` : `⚠️ gh issue falhou (criará via agente): ${createOut.slice(0,1000)}`,
          extra: { title, repo: SUPERVISOR_REPO },
        },
      });
      await $`rm -f ${bodyTmp} 2>&1`.nothrow().quiet();
    } else {
      await client.app.log({
        body: { service: "supervisor", level: "warn", message: "gh não encontrado — issue não criada automaticamente; auditoria já persistida em HANDOFF/STATE" },
      });
    }

    // Nota: se o ambiente suporta `client.session.prompt`, descomente:
    // await (client as any).session?.prompt?.({ prompt: supervisorPrompt, agent: "supervisor" });
  } catch (err: any) {
    await client.app.log({
      body: { service: "supervisor", level: "warn", message: `Supervisor LLM step falhou: ${err?.message?.slice(0,800)}` },
    });
  }
}

export const SupervisorPlugin: Plugin = async ({ $, directory, client }) => {
  return {
    "tool.execute.after": async (input: any, output: any) => {
      const tool: string = input?.tool ?? output?.tool ?? "";
      const args = output?.args ?? input?.args ?? {};
      try {
        if (["write", "edit"].includes(tool)) {
          const fp: string = args?.filePath ?? args?.file ?? args?.path ?? "";
          if (fp.includes(".planning/HANDOFF.md") || fp.includes(".planning/STATE.md")) {
            await new Promise((r) => setTimeout(r, 1500));
            await runSupervisor($, directory, client, `write:${fp.split("/").pop()}`);
          }
        }
        if (tool === "task") {
          const agent = args?.agent ?? args?.subagent ?? input?.args?.agent ?? "";
          if (agent === "shipper") {
            await new Promise((r) => setTimeout(r, 2000));
            await runSupervisor($, directory, client, "task:shipper");
          }
        }
      } catch (err: any) {
        await client.app.log({
          body: { service: "supervisor", level: "error", message: `🚨 Supervisor hook erro visível: ${err?.message?.slice(0, 800)} — Log: .planning/HOOKS.log` },
        });
        throw err;
      }
    },

    event: async ({ event }: any) => {
      try {
        if (event?.type === "session.idle") {
          const check = await $`test -f ${directory}/.planning/HANDOFF.md && echo ok`.text().catch(() => "");
          if (check.includes("ok") && !hasRun) {
            const handoff = await $`cat ${directory}/.planning/HANDOFF.md 2>&1 | head -20`.text().catch(() => "");
            if (handoff.includes("shipper") || handoff.length > 100) {
              await runSupervisor($, directory, client, "session.idle");
            }
          }
        }
        if (event?.type === "file.edited" || event?.type === "file.watcher.updated") {
          const fp: string = event?.properties?.path ?? event?.path ?? "";
          if (fp.includes(".planning/HANDOFF.md") && !hasRun) {
            await new Promise((r) => setTimeout(r, 1000));
            await runSupervisor($, directory, client, "file.edited:HANDOFF.md");
          }
        }
      } catch (err: any) {
        await client.app.log({
          body: { service: "supervisor", level: "error", message: `Supervisor hook (event) falhou: ${err?.message?.slice(0, 800)}` },
        });
      }
    },
  };
};

export default SupervisorPlugin;
