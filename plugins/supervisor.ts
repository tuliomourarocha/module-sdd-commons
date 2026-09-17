/**
 * plugins/supervisor.ts — Hook determinístico supervisor final (OpenCode)
 *
 * Conceito: middleware fora do LLM no final do ciclo que:
 *   1. Roda `hooks/supervisor.py` determinístico (métricas performance, tokens, alucinações)
 *   2. Invoca agente `supervisor` (LLM com prompt fechado) para julgamento qualitativo
 *   3. Cria Issue no repo `tuliomourarocha/module-sdd-commons` com output
 *
 * Acionamento (determinístico, sem depender de LLM decidir):
 *   - Trigger primário: `tool.execute.after` quando `write` em `.planning/HANDOFF.md` ou `STATE.md` (shipper)
 *   - Trigger secundário: `tool.execute.after` quando `task` com agent `shipper` completa
 *   - Trigger terciário: `event: session.idle` após shipper (fallback)
 *   - Debounce: roda no máximo 1x por sessão (flag em /tmp)
 *
 * Instalação: copiado para `.opencode/plugins/supervisor.ts` via bin/sdd-harness.js
 * Requer: python3, hooks/supervisor.py, gh CLI (opcional, se ausente salva markdown local)
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
  const pyResult = await $`python3 ${hook} --run --repo ${directory} --repo-slug ${SUPERVISOR_REPO} --dry-run 2>&1`.nothrow().quiet();
  const pyOut: string = pyResult.stdout?.toString() ?? "";
  const pyErr: string = pyResult.stderr?.toString() ?? "";
  const duration = Date.now() - start;

  await client.app.log({
    body: {
      service: "supervisor",
      level: pyResult.exitCode === 0 ? "info" : pyResult.exitCode === 2 ? "error" : "warn",
      message: `Supervisor determinístico finalizado (${duration}ms, exit ${pyResult.exitCode})`,
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

  // Salva output para agente supervisor consumir
  const reportPath = `${directory}/.planning/SUPERVISOR_REPORT.md`;
  const metricsPath = `${directory}/.planning/supervisor_metrics.json`;
  // py já salvou, mas garante log
  await $`ls -lh ${reportPath} 2>&1 | head -1`.nothrow().quiet().then(async (r: any) => {
    const out = r.stdout?.toString() ?? "";
    await client.app.log({ body: { service: "supervisor", level: "info", message: `Report: ${out.trim()}`, extra: { reportPath } } });
  });

  // 2. Invoca agente supervisor (LLM) para análise qualitativa — se disponível
  // O agente supervisor lê SUPERVISOR_REPORT.md + git diff + STATE/HANDOFF e produz issue final
  // Tenta via client.session.prompt se API existir, senão via task tool (fallback)
  try {
    // Tenta chamar agente supervisor via opencode client (se suportado)
    // Fallback: cria arquivo de instrução para execução manual
    const supervisorPrompt = `
Você é o agente SUPERVISOR. Analise o relatório determinístico em ${reportPath} e ${metricsPath}.

Tarefas:
1. Leia ${reportPath}, ${metricsPath}, .planning/HANDOFF.md, .planning/STATE.md e git diff --stat HEAD
2. Valide alucinações listadas (confirme ou marque como falso positivo)
3. Avalie: performance (duração gates), qualidade código, aderência PLAN vs entregue, segurança residual
4. Estime tokens reais se houver logs em .opencode/ (senão mantenha heurística)
5. Crie/atualize Issue no repo ${SUPERVISOR_REPO} via \`gh issue create\` com body do relatório + seu julgamento
   - Título: "[Supervisor] Auditoria {data} — {n} HIGH"
   - Labels: supervisor, automated, hallucination (se HIGH), guard-rails-blocked (se HIGH), ci-failure (se falhou)
   - Se gh ausente, apenas confirme markdown salvo

Trigger: ${trigger}
Relatório determinístico (trecho):
${pyOut.slice(0, 6000)}
`.trim();

    // Escreve prompt para supervisor executar manualmente ou via bash
    const promptFile = `${directory}/.planning/SUPERVISOR_PROMPT.md`;
    await $`mkdir -p ${directory}/.planning && cat > ${promptFile} << 'EOSUP'
${supervisorPrompt}
EOSUP`.nothrow().quiet();

    await client.app.log({
      body: {
        service: "supervisor",
        level: "info",
        message: `Prompt supervisor salvo em ${promptFile} — agente deve ler e criar issue`,
        extra: { promptFile, reportPath },
      },
    });

    // Tenta disparar criação de issue imediatamente via gh (determinístico, sem LLM)
    // O LLM complementa depois, mas já criamos issue determinística para garantir output
    const ghCheck = await $`which gh 2>&1`.nothrow().quiet();
    if (ghCheck.exitCode === 0) {
      const title = `[Supervisor] Auditoria ${(new Date()).toISOString().slice(0,16)} — trigger ${trigger}`;
      // gh issue create com body do report (limitado)
      const bodyFile = `${directory}/.planning/SUPERVISOR_BODY.md`;
      await $`cp ${reportPath} ${bodyFile} 2>&1`.nothrow().quiet();
      const create = await $`gh issue create --repo ${SUPERVISOR_REPO} --title ${title} --body-file ${bodyFile} --label supervisor --label automated 2>&1`.nothrow().quiet();
      const createOut = create.stdout?.toString() ?? create.stderr?.toString() ?? "";
      await client.app.log({
        body: {
          service: "supervisor",
          level: create.exitCode === 0 ? "info" : "warn",
          message: create.exitCode === 0 ? `✅ Issue criada: ${createOut.slice(0,500)}` : `⚠️ gh issue falhou (criará via agente): ${createOut.slice(0,1000)}`,
          extra: { title, repo: SUPERVISOR_REPO },
        },
      });
    } else {
      await client.app.log({
        body: { service: "supervisor", level: "warn", message: "gh não encontrado — issue não criada automaticamente; agente supervisor deve criar quando gh disponível" },
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
