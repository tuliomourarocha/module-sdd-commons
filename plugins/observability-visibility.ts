/**
 * plugins/observability-visibility.ts — visibilidade de skills, codegraph e hooks nos logs dos agentes
 *
 * Complementa o rtk-visibility.ts: além do `⟐ rtk ✓` em comandos shell reescritos,
 * este plugin marca no transcript (output do tool, visível ao usuário e ao LLM)
 * quando skills são carregadas, quando o codegraph é consultado e quando hooks
 * determinísticos são acionados.
 *
 * Marcadores (curtos, idempotentes):
 *   ⟐ skill ✓ — skill "<id>" carregada
 *   ⟐ codegraph ✓ — <tool> consultado (exploração semântica)
 *   ⟐ hook ✓ <nome> — <status> (<detalhe>)
 *
 * Kill switch: OBSERVABILITY_VISIBILITY=0 desliga só os marcadores (hooks continuam rodando).
 *
 * Compat: formato V1 (objeto com hooks), igual ao rtk-visibility.ts.
 */

type AnyObj = Record<string, any>;

const MARK_SKILL = "⟐ skill ✓";
const MARK_CODEGRAPH = "⟐ codegraph ✓";
const MARK_HOOK = "⟐ hook ✓";

const SKILL_TOOLS = new Set(["skill"]);
const CODEGRAPH_TOOL_RE = /(?:^|[_/])codegraph(?:[_/]|$)|codegraph/i;

function visibilityEnabled(): boolean {
  return process.env.OBSERVABILITY_VISIBILITY !== "0";
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function extractSkillId(args: AnyObj): string {
  return asString(args?.id) || asString(args?.name) || asString(args?.skill) || "unknown";
}

function extractCodegraphTool(tool: string, args: AnyObj): string | null {
  const t = String(tool ?? "");
  // MCP direto: codegraph_codegraph_explore, mcp__codegraph__codegraph_explore, etc.
  if (CODEGRAPH_TOOL_RE.test(t) && t !== "execute") {
    return t;
  }
  // execute com Code Mode: tools.codegraph.codegraph_explore(...) ou tools["codegraph"].*
  if (t === "execute") {
    const code = asString(args?.code);
    if (!code) return null;
    const m = code.match(/tools(?:\.codegraph\b|\[\s*["']codegraph["']\s*\])(?:\.|\[\s*["'])([a-zA-Z0-9_-]+)/);
    if (m) return `codegraph.${m[1]}`;
    if (/tools\.codegraph\b|tools\[\s*["']codegraph["']\s*\]/.test(code)) return "codegraph";
  }
  return null;
}

function appendMarker(output: AnyObj, marker: string, line: string): void {
  if (!visibilityEnabled()) return;
  if (!output || typeof output.output !== "string") return;
  if (output.output.includes(marker)) return;
  output.output += `\n\n${line}`;
}

function handleAfter(tool: unknown, output: AnyObj, input?: AnyObj): void {
  const toolName = String(tool ?? "").toLowerCase();
  const args = (output?.args ?? input?.args ?? {}) as AnyObj;

  // ── Skill ────────────────────────────────────────────────────────────────
  if (SKILL_TOOLS.has(toolName)) {
    const id = extractSkillId(args);
    appendMarker(output, `${MARK_SKILL} — skill "${id}"`, `${MARK_SKILL} — skill "${id}" carregada`);
    return;
  }

  // ── CodeGraph ────────────────────────────────────────────────────────────
  const cgTool = extractCodegraphTool(toolName, args);
  if (cgTool) {
    appendMarker(
      output,
      MARK_CODEGRAPH,
      `${MARK_CODEGRAPH} — ${cgTool} consultado (exploração semântica)`
    );
    return;
  }

}

export const ObservabilityVisibilityPlugin = {
  "tool.execute.after": async (input: any, output: any) => {
    try {
      handleAfter(input?.tool ?? output?.tool ?? input?.name, output, input);
    } catch {
      // visibilidade nunca deve quebrar o fluxo
    }
  },
};

export default ObservabilityVisibilityPlugin;
