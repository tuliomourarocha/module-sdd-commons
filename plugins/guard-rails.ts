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

function isCodeFile(path: string | undefined): boolean {
  if (!path) return false;
  if (IGNORE_RE.test(path)) return false;
  return CODE_EXT_RE.test(path);
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

async function runGuardRails(
  $: any,
  directory: string,
  filePath: string,
  client: any
) {
  const normalized = filePath.startsWith("/") ? filePath : `${directory}/${filePath}`;
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
      await client.app.log({
        body: {
          service: "guard-rails",
          level: "warn",
          message: `Hook script não encontrado para ${filePath}, pulando guard rails`,
          extra: { filePath, directory },
        },
      });
      return;
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
  try {
    json = JSON.parse(stdout);
  } catch {
    // output pode ser texto quando falha
  }

  const blocked = json?.blocked === true || exitCode === 2;
  const findings: any[] = json?.findings ?? [];
  const high = findings.filter((f) => f.severity === "HIGH").length;
  const med = findings.filter((f) => f.severity === "MED").length;

  // Log estruturado sempre
  await client.app.log({
    body: {
      service: "guard-rails",
      level: blocked ? "error" : med > 0 ? "warn" : "info",
      message: blocked
        ? `⛔ Guard Rails BLOQUEOU ${filePath} — HIGH:${high} MED:${med} (${duration}ms)`
        : `🛡️ Guard Rails ${filePath} — HIGH:${high} MED:${med} (${duration}ms)`,
      extra: { filePath, blocked, high, med, findings: findings.slice(0, 5), stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 1000) },
    },
  });

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
      `⛔ GUARD_RAILS_BLOCKED: ${filePath} — corrija HIGH antes de prosseguir\n${msg}\n\nDetalhe: ${stdout.slice(0, 4000)}`
    );
  } else if (med > 0) {
    // WARNING não bloqueia, mas avisa — reviewer/shipper vê log
    await $`echo ${JSON.stringify({ file: filePath, high, med, duration })} >> ${directory}/.opencode/hooks/guard-rails.log`.nothrow().quiet();
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
      if (!isCodeFile(filePath)) return;

      // evita loop se o próprio guard criar log
      if (filePath.includes("guard-rails.log") || filePath.includes("SUPERVISOR")) return;

      try {
        await runGuardRails($, directory, filePath, client);
      } catch (err: any) {
        // Re-throw para bloquear: o agente builder/reviewer recebe o erro
        // Se for HIGH, deve corrigir. Se plugin falhar por infra, loga mas não bloqueia.
        if (err?.message?.includes("GUARD_RAILS_BLOCKED")) throw err;
        await client.app.log({
          body: {
            service: "guard-rails",
            level: "warn",
            message: `Guard Rails falhou infra para ${filePath}: ${err?.message?.slice(0, 500)}`,
            extra: { filePath, error: String(err) },
          },
        });
      }
    },

    // Hook secundário: evento de arquivo editado (file watcher) — redundância determinística
    event: async ({ event }: any) => {
      if (event?.type !== "file.edited" && event?.type !== "file.watcher.updated") return;
      const filePath: string | undefined = event?.properties?.path ?? event?.path ?? event?.file;
      if (!filePath || !isCodeFile(filePath)) return;
      if (filePath.includes("guard-rails.log")) return;
      try {
        await runGuardRails($, directory, filePath, client);
      } catch (err: any) {
        if (err?.message?.includes("GUARD_RAILS_BLOCKED")) {
          await client.app.log({
            body: { service: "guard-rails", level: "error", message: err.message.slice(0, 2000) },
          });
        }
      }
    },
  };
};

// Compat V1: export default para opencode versões que esperam objeto plugin
export default GuardRailsPlugin;
