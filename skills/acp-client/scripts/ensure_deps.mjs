#!/usr/bin/env node
/**
 * ensure_deps.mjs — bootstrap idempotente das dependências do fluxo ACP.
 *
 * Verifica e, se ausente, instala (método oficial de cada uma):
 *   - lavish-axi   → npm install -g lavish-axi          (console HTML do usuário)
 *   - codegraph    → npm install -g @colbymchenry/codegraph
 *   - rtk          → brew install rtk-ai/tap/rtk | curl installer (verifica rtk gain
 *                    p/ descartar o "Rust Type Kit" homônimo)
 *   - opencode     → curl -fsSL https://opencode.ai/install | bash (o AGENT do ACP)
 *
 * Uso:
 *   node ensure_deps.mjs                 # garante tudo (idempotente)
 *   node ensure_deps.mjs --only lavish   # garante uma
 *   node ensure_deps.mjs --doctor        # só diagnostico, não instala
 *   node ensure_deps.mjs --json          # saída máquina
 *
 * Acionado automaticamente pelo acp_client.mjs no startup (opt-out:
 * --no-ensure ou env ACP_SKIP_ENSURE=1). Instalação é falha-em-aberto:
 * dependência que falha não derruba o run — vira warning + hint.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = (name, args) => {
  try {
    return spawnSync(name, args, { encoding: "utf8", timeout: 15_000 });
  } catch {
    return null;
  }
};

const installed = (name, args = ["--version"]) => {
  const r = BIN(name, args);
  if (r?.status === 0) return (r.stdout || r.stderr || "").trim().split("\n")[0];
  return null;
};

const npm = () => installed("npm", ["--version"]) ? "npm" : null;
const brew = () => installed("brew", ["--version"]) ? "brew" : null;

function executableExists(name) {
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try { accessSync(path.join(dir || ".", name), constants.X_OK); return true; } catch { return false; }
  });
}

function checkError(name) {
  const result = BIN(name, ["--version"]);
  const detail = String(result?.stderr || result?.error?.message || result?.stdout || `código ${result?.status ?? "desconhecido"}`).trim().split("\n")[0];
  return `${name} existe no PATH, mas não iniciou: ${detail}`;
}

const DEPS = [
  {
    id: "lavish-axi",
    check: () => installed("lavish-axi"),
    install: (log, o) => run(npm() ? ["npm", "install", "-g", "lavish-axi"] : null, log, o),
    fallbackHint: "npx -y lavish-axi (AXI: funciona on-demand sem install global)",
    required: false,
  },
  {
    id: "codegraph",
    check: () => installed("codegraph"),
    install: (log, o) => run(npm() ? ["npm", "install", "-g", "@colbymchenry/codegraph"] : null, log, o),
    fallbackHint: "opencode mcp add codegraph --env CODEGRAPH_TELEMETRY=0 -- codegraph serve --mcp",
    required: false,
  },
  {
    id: "rtk",
    // rtk correto valida com `rtk gain` (dashboard) — descarta o Rust Type Kit homônimo
    check: () => {
      const v = installed("rtk");
      if (!v) return null;
      const gain = BIN("rtk", ["gain"]);
      const detail = String(gain?.stderr || gain?.error?.message || "erro desconhecido").trim().split("\n")[0];
      return gain?.status === 0 ? v : `${v} (aviso: 'rtk gain' falhou: ${detail})`;
    },
    install: (log, o) => {
      if (brew()) return run(["brew", "install", "rtk-ai/tap/rtk"], log, o);
      log("sem brew — usando installer oficial (curl)");
      return run(["sh", "-c", "curl -fsSL raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh"], log, o);
    },
    fallbackHint: "curl -fsSL raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh",
    required: false,
  },
  {
    id: "opencode",
    check: () => installed("opencode"),
    install: (log, o) => {
      log("instalando opencode via installer oficial…");
      return run(["sh", "-c", "curl -fsSL https://opencode.ai/install | bash"], log, o);
    },
    fallbackHint: "curl -fsSL https://opencode.ai/install | bash",
    required: true, // o agente default do ACP
  },
];

function run(cmd, log, { inherit = false } = {}) {
  if (!cmd) return { ok: false, error: "nenhum método de install disponível" };
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), {
      encoding: "utf8",
      // install com progresso ao vivo — execução bloqueante sem saída parece tela travada
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    log?.((out || "").split("\n").slice(-3).join(" ").trim());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message || err).split("\n").slice(-3).join(" ").trim() };
  }
}

export function ensureDeps({ only = null, exclude = [], doctor = false, log = console.error, inherit = true } = {}) {
  const deps = DEPS.filter((dep) => !exclude.includes(dep.id) && (!only || dep.id.startsWith(only)));
  const results = [];
  for (const dep of deps) {
    let version = dep.check();
    let action = "ok";
    if (!version && executableExists(dep.id)) {
      action = "falhou";
      log(`[ensure-deps] ${checkError(dep.id)}. Verifique permissões e configuração; a instalação não será repetida.`);
    } else if (!version && !doctor) {
      log(`[ensure-deps] ${dep.id} ausente — instalando…`);
      const r = dep.install((s) => log(`[ensure-deps] ${dep.id}: ${s}`), { inherit });
      version = dep.check();
      action = r.ok && version ? "instalado" : "falhou";
      if (action === "falhou") log(`[ensure-deps] ${dep.id} NÃO instalado (${r.error ?? "?"}). Hint: ${dep.fallbackHint}`);
    } else if (!version && doctor) {
      action = "ausente";
      log(`[ensure-deps] ${dep.id} ausente. Hint: ${dep.fallbackHint}`);
    }
    results.push({ id: dep.id, version: version ?? null, action, required: dep.required });
    if (version) log(`[ensure-deps] ${dep.id} ${version}`);
  }
  return results;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const a = process.argv.slice(2);
  const only = a.includes("--only") ? a[a.indexOf("--only") + 1] : null;
  const doctor = a.includes("--doctor");
  const json = a.includes("--json");
  const results = ensureDeps({ only, doctor });
  if (json) console.log(JSON.stringify(results));
  const blocked = results.some((r) => r.required && !r.version);
  process.exit(blocked ? 4 : 0);
}
