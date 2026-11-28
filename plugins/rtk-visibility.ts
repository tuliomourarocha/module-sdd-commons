/**
 * plugins/rtk-visibility.ts — prova visível de que o RTK está rodando
 *
 * O rtk reescreve comandos de shell antes do LLM ler (economia de 60–90% dos
 * tokens de bash), mas a reescrita é silenciosa — usuário e agente não têm
 * como saber, olhando o transcript, se o proxy está ativo ou não.
 *
 * Este plugin fecha esse buraco: todo comando bash/shell que o rtk reescreveu
 * recebe um rodapé na própria saída — `⟐ rtk ✓ ...` — visível no transcript
 * para o usuário e para o LLM. O rodapé é curto de propósito: aparece em toda
 * execução reescrita e não deve virar ruído.
 *
 * Como sabe que o rtk reescreveu?
 *  1. O comando já chega como `rtk ...` (o plugin global do rtk rodou antes
 *     do nosso no `execute.before`) — marca direto.
 *  2. O comando chega cru (nosso hook rodou antes): pergunta ao próprio rtk
 *     (`rtk hook opencode <cmd>`) se ele reescreveria — mesma decisão que o
 *     plugin dele toma, sem duplicar regras.
 *
 * Kill switches:
 *  - RTK_DISABLED=1      → rtk inteiro desligado (o plugin dele já respeita;
 *                          aqui só evita rodapé em comandos `rtk` manuais... na
 *                          verdade desliga também a marcação: sem rtk, sem prova)
 *  - RTK_VISIBILITY=0    → desliga só o rodapé, mantendo o rtk ativo
 *
 * Compat: usa a mesma forma V1 de guard-rails.ts (objeto com hooks), que o
 * OpenCode ≥ 1.18.29 carrega. Sem rtk no PATH, o plugin fica idle silencioso.
 */

import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"

type TrackedCall = { command: string; rewritten: boolean }

// callID → rastreio da chamada bash (before guardou, after consome)
const tracked = new Map<string, TrackedCall>()
const TRACKED_MAX = 500

const BASH_TOOLS = new Set(["bash", "shell"])

const FOOTER =
  "\n\n⟐ rtk ✓ — saída comprimida pelo proxy RTK antes do LLM ler (economia de tokens de shell)"
const FOOTER_FIRST =
  "\n\n⟐ rtk ✓ — saída comprimida pelo proxy RTK antes do LLM ler (economia de tokens de shell; economia acumulada: `rtk gain`)"

let firstMarkShown = false

function visibilityEnabled(): boolean {
  return process.env.RTK_DISABLED !== "1" && process.env.RTK_VISIBILITY !== "0"
}

/** Resolve o binário rtk do PATH (mesma política do plugin global: PATH only). */
export function resolveRtkPath(): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, `rtk${ext}`)
      if (existsSync(full) && !statSync(full).isDirectory()) return full
    }
  }
  return null
}

/**
 * Pergunta ao rtk se ele reescreveria o comando — a mesma decisão do plugin
 * global (`rtk hook opencode`), sem duplicar as regras de reescrita. Null =
 * rtk não reescreveria (ou não respondeu): sem rodapé, comando roda como está.
 */
function askRtkWouldRewrite(rtkBin: string, command: string, agent?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const argv = ["hook", "opencode"]
    if (agent) argv.push("--agent", agent)
    argv.push(command)
    execFile(
      rtkBin,
      argv,
      { encoding: "utf8", timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(false)
        try {
          const answer = JSON.parse(String(stdout ?? "").trim() || "{}") as { command?: string }
          const rewritten = typeof answer?.command === "string" ? answer.command.trim() : ""
          resolve(Boolean(rewritten) && rewritten !== command)
        } catch {
          resolve(false)
        }
      }
    )
  })
}

function trackCommand(callID: string | undefined, command: string, rewritten: boolean): void {
  if (!callID) return
  if (tracked.size >= TRACKED_MAX && !tracked.has(callID)) {
    // descarta o mais antigo — after raramente fica pendente para tanto
    const oldest = tracked.keys().next().value
    if (oldest) tracked.delete(oldest)
  }
  tracked.set(callID, { command, rewritten })
}

async function handleBefore(
  tool: unknown,
  callID: string | undefined,
  command: unknown,
  agent?: string
): Promise<void> {
  // O TMR já registra a resposta real do hook nativo para cada chamada.
  if (!visibilityEnabled() || process.env.SDD_TMR_RTK_AUDIT === "1") return
  const toolName = String(tool ?? "").toLowerCase()
  if (!BASH_TOOLS.has(toolName)) return
  if (typeof command !== "string" || !command.trim()) return

  const cmd = command.trim()
  // caso 1: o plugin global do rtk já reescreveu antes do nosso hook rodar
  if (cmd.startsWith("rtk ") || cmd === "rtk") {
    trackCommand(callID, cmd, true)
    return
  }
  // caso 2: comando cru — pergunta ao rtk se ele reescreveria
  const rtkBin = resolveRtkPath()
  if (!rtkBin) return
  const wouldRewrite = await askRtkWouldRewrite(rtkBin, cmd, agent)
  if (wouldRewrite) trackCommand(callID, cmd, true)
}

function handleAfter(tool: unknown, callID: string | undefined, output: any): void {
  const toolName = String(tool ?? "").toLowerCase()
  if (!BASH_TOOLS.has(toolName)) return
  if (!callID) return
  const call = tracked.get(callID)
  tracked.delete(callID)
  if (!call?.rewritten) return
  if (process.env.RTK_DISABLED === "1" || process.env.RTK_VISIBILITY === "0") return
  if (!output || typeof output.output !== "string") return
  // idempotente: nunca empilha rodapé em rodapé (ex.: tool call repetida no replay)
  if (output.output.includes("⟐ rtk ✓")) return
  output.output += firstMarkShown ? FOOTER : FOOTER_FIRST
  firstMarkShown = true
}

export const RtkVisibilityPlugin = {
  "tool.execute.before": async (input: any, output: any) => {
    await handleBefore(
      input?.tool,
      input?.callID,
      output?.args?.command,
      typeof input?.agent === "string" ? input.agent : undefined
    )
  },
  "tool.execute.after": (input: any, output: any) => {
    handleAfter(input?.tool, input?.callID, output)
  },
}

export default RtkVisibilityPlugin
