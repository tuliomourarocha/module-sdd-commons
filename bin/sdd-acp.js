#!/usr/bin/env node
/**
 * sdd-acp — atalho oficial para a squad rodar via ACP.
 *
 *   sdd-acp                    abre o console TMR no navegador
 *   sdd-acp doctor             diagnostico das dependências (lavish/codegraph/rtk/opencode)
 *   sdd-acp client [args]      run de UMA subtask (acp_client.mjs — usado pelos macros)
 *   sdd-acp help
 *
 * Localiza os scripts em: pacote npm (skills/ junto ao bin), projeto alvo
 * (.opencode/skills/, .claude/skills/) ou repo-fonte (skills/ no cwd).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ui from "../skills/acp-client/scripts/tmr_ui.mjs";
import { AGENT_PRESETS } from "../skills/acp-client/scripts/acp_agents.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(here, "..", "skills", "acp-client", "scripts"),
  path.join(process.cwd(), ".opencode", "skills", "acp-client", "scripts"),
  path.join(process.cwd(), ".claude", "skills", "acp-client", "scripts"),
  path.join(process.cwd(), "skills", "acp-client", "scripts"),
];
const scriptsDir = candidates.find((c) => fs.existsSync(path.join(c, "acp_orchestrate.mjs")));
const fail = (msg, code = 2) => {
  console.error(`sdd-acp: ${msg}`);
  process.exit(code);
};

const usage = () => {
  ui.banner("ACP — Squad Orchestrator");
  console.log(`  ${ui.paint.bold("Uso")}`);
  console.log(`    ${ui.paint.green("sdd-acp")} ${ui.paint.dim(`[--cwd dir] [--agent ${Object.keys(AGENT_PRESETS).join("|")}] [--model id] [--port n] [--no-open]`)}   ${ui.paint.gray("console web local")}`);
  console.log(`    ${ui.paint.green("sdd-acp doctor")}      ${ui.paint.gray("diagnóstico das dependências ACP")}`);
  console.log(`    ${ui.paint.green("sdd-acp client <args>")} ${ui.paint.gray("run de UMA subtask via acp_client.mjs")}`);
  console.log(`    ${ui.paint.green("sdd-acp help")}         ${ui.paint.gray("esta ajuda")}`);
  console.log("");
};

if (!scriptsDir) fail("acp_orchestrate.mjs não encontrado — instale a squad (npx sdd-harness) ou rode de dentro do projeto instalado.");

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }

// apenas subcomandos conhecidos interceptam; flags (ex.: --ui lavish) vão direto ao wizard
if (cmd === "doctor") {
  const r = spawnSync(process.execPath, [path.join(scriptsDir, "acp_client.mjs"), "--doctor", ...rest], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (cmd === "client") {
  const r = spawnSync(process.execPath, [path.join(scriptsDir, "acp_client.mjs"), ...rest], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (cmd && !cmd.startsWith("-")) fail(`subcomando desconhecido: ${cmd} (use sdd-acp help)`);

// default: wizard orquestrador (cmd pode ser null ou flags como --ui)
const wizardArgs = cmd ? [cmd, ...rest] : rest;
process.argv = [process.execPath, path.join(scriptsDir, "acp_orchestrate.mjs"), ...wizardArgs];
try {
  await import(pathToFileURL(process.argv[1]).href);
} catch (error) {
  fail(error.message, 1);
}
