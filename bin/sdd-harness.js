#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { CLAUDE_DEFAULT_MODELS, CODEX_DEFAULT_MODELS, ROLE_ORDER } from "./lib/model-catalog.js";
import { applyOpenCodeSelections, selectModels } from "./lib/model-picker.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platforms = new Set(["opencode", "claude", "codex"]);
const claudeRoleModels = { ...CLAUDE_DEFAULT_MODELS };
const codexRoleModels = { ...CODEX_DEFAULT_MODELS };

// ── RTK (economia de tokens) ─────────────────────────────────────────────────
// rtk — https://github.com/rtk-ai/rtk — proxy de comandos que comprime a saída
// de shell antes do LLM ler (60–90% menos tokens de bash). Durante a instalação
// da squad o binário é baixado (brew/winget/install.sh oficial) e vinculado ao
// harness escolhido via `rtk init <flags-do-agent>`. O rtk falha em aberto:
// sem o binário os hooks passam o comando original, então a squad funciona
// mesmo que o vínculo falhe.
const RTK_INIT_FLAGS = {
  opencode: ["--global", "--opencode"], // único escopo do rtk (plugin TS em ~/.config/opencode/plugins/rtk.ts)
  claude: ["--global"], // hook nativo PreToolUse + patch do settings.json
  codex: ["--global", "--codex"], // hook PreToolUse (updatedInput) + RTK.md em ~/.codex
};
const RTK_EDITIONS = new Set(["full", "oss"]);
const RTK_INSTALL_URL =
  "https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh";

function usage(exitCode = 0) {
  console.log(`Uso: npx --yes github:tuliomourarocha/module-sdd-commons#main --<plataforma> [opções]

Plataformas: --opencode, --claude, --codex, --all
Opções:     --target <diretório-do-projeto>   (padrão: diretório atual)
             --dry-run
             --no-rtk                          (não baixa nem vincula o rtk)
             --rtk-edition <full|oss>          (padrão: full; oss = Apache-2.0, sem motor BUSL)
             --rtk-scope <global|project>      (padrão: global; opencode é sempre global)
             --rtk-only                        (só baixa/vincula o rtk, sem artefatos)
             --no-codegraph                    (não instala codegraph/ast-grep nem registra o MCP)
             --no-model-picker                 (não pergunta modelos; usa o padrão da squad)
             --help

Sobre o rtk: proxy de comandos (https://github.com/rtk-ai/rtk) que comprime a
saída de shell antes do LLM ler. Durante a instalação o binário é baixado
(brew / winget / install.sh oficial) e vinculado ao harness escolhido com
"rtk init". Saída estranha? "rtk bypass <cmd>" roda sem filtro. Durante a
execução, o plugin rtk-visibility.ts marca cada comando reescrito com
"⟐ rtk ✓" na saída — prova visível de que o proxy está rodando.

Sobre o codegraph: CLI semântico (https://github.com/colbymchenry/codegraph) que
indexa o repositório e o expõe como MCP ("codegraph serve --mcp"); ast-grep
complementa com busca estrutural de sintaxe (AST). Durante a instalação ambos
os binários são baixados (npm/brew), o MCP codegraph é registrado no harness
escolhido e o projeto é indexado ("codegraph init", telemetria desligada).

--rtk-agents: por padrão o vínculo segue as plataformas da instalação;
  "all" detecta e vincula todos os harnesses instalados (opencode, claude,
  codex); ou passe uma lista csv: --rtk-agents opencode,codex

Sobre os modelos: em terminal interativo o instalador lista os modelos
disponíveis do harness escolhido, por agente, ordenados por qualidade ×
custo-benefício para aquele papel. O recomendado aparece destacado em verde.
Enter aceita todos; "r" revisa agente por agente; "t" mostra a lista completa.
Sem TTY (ou com --no-model-picker) a instalação usa o padrão da squad.

Exemplos:
  npx --yes github:tuliomourarocha/module-sdd-commons#main --opencode
  npx --yes github:tuliomourarocha/module-sdd-commons#main --claude --target ../meu-app
  npx --yes github:tuliomourarocha/module-sdd-commons#main --codex --no-rtk
  npx --yes github:tuliomourarocha/module-sdd-commons#main --opencode --rtk-agents all
  npx --yes github:tuliomourarocha/module-sdd-commons#main --rtk-only --rtk-agents all`);
  process.exit(exitCode);
}

function parseArgs(args) {
  const selected = [];
  let target = process.cwd();
  let dryRun = false;
  const rtk = {
    enabled: true,
    only: false,
    edition: process.env.RTK_EDITION === "oss" ? "oss" : "full",
    scope: "global",
    agents: null,
  };
  const codegraph = { enabled: true };
  let modelPicker = true;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument === "--dry-run") { dryRun = true; continue; }
    if (argument === "--no-rtk") { rtk.enabled = false; continue; }
    if (argument === "--no-codegraph") { codegraph.enabled = false; continue; }
    if (argument === "--no-model-picker") { modelPicker = false; continue; }
    if (argument === "--rtk-only") { rtk.enabled = true; rtk.only = true; continue; }
    if (argument === "--rtk-edition") {
      const value = args[index + 1];
      if (!value || !RTK_EDITIONS.has(value)) {
        throw new Error("--rtk-edition aceita: full ou oss.");
      }
      rtk.edition = value;
      index += 1;
      continue;
    }
    if (argument === "--rtk-scope") {
      const value = args[index + 1];
      if (value !== "global" && value !== "project") {
        throw new Error("--rtk-scope aceita: global ou project.");
      }
      rtk.scope = value;
      index += 1;
      continue;
    }
    if (argument === "--rtk-agents") {
      const value = args[index + 1];
      if (!value) throw new Error("--rtk-agents aceita: all ou uma lista csv (opencode,claude,codex).");
      rtk.agents = value;
      index += 1;
      continue;
    }
    if (argument === "--all") { selected.push(...platforms); continue; }
    if (argument.startsWith("--") && platforms.has(argument.slice(2))) {
      selected.push(argument.slice(2));
      continue;
    }
    if (argument === "--target") {
      const value = args[index + 1];
      if (!value) throw new Error("--target exige um diretório.");
      target = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Argumento desconhecido: ${argument}`);
  }

  // sem plataforma: só aceitável no modo --rtk-only (só configura o vínculo do rtk)
  if (selected.length === 0 && !(rtk.only && rtk.agents)) {
    throw new Error("Escolha uma plataforma: --opencode, --claude, --codex ou --all; ou use --rtk-only com --rtk-agents.");
  }
  return { selected: [...new Set(selected)], target, dryRun, rtk, codegraph, modelPicker };
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function copyDirectory(from, to, dryRun) {
  if (dryRun) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
}

async function agentBody(role) {
  const input = await readFile(path.join(sourceRoot, "agents", `${role}.agent.md`), "utf8");
  const parts = input.split(/^---\s*$/m);
  if (parts.length < 3) throw new Error(`Frontmatter inválido em ${role}.agent.md`);
  return parts.slice(2).join("---").trim();
}

function claudeFrontmatter(role, roleModels = claudeRoleModels) {
  const common = [
    `name: ${role}`,
    `description: ${descriptions[role]}`,
    `model: ${roleModels[role]}`,
    `maxTurns: ${role === "builder" ? 25 : role === "harness" || role === "planner" ? 20 : 15}`,
  ];
  if (role === "harness") return [...common, "tools: Read, Glob, Grep, Agent", "disallowedTools: Write, Edit, Bash, WebFetch"].join("\n");
  if (role === "planner") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  if (role === "builder") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  if (role === "reviewer") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  if (role === "supervisor") return common.join("\n");
  return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
}

const descriptions = {
  harness: "Orquestra feature, project ou bugfix pelos quatro papéis + hooks do SDD Harness.",
  planner: "Planeja produto e arquitetura; gera PRD, PLAN e diagramas (memória).",
  builder: "Implementa full-stack a partir de um PLAN aprovado (retorna resumo em memória, nunca SUMMARY.md).",
  reviewer: "Revisa arquitetura técnica e de software; gera parecer em memória (nunca REVIEW.md/VALIDATION.md, sem lint — hooks fazem).",
  shipper: "Finaliza via hook determinístico (git/PR/CI/issue GitHub/STATE/HANDOFF); fallback minimal só STATE/HANDOFF.",
  supervisor: "Audita ciclo completo, mede performance/alucinações/tokens e cria Issue. Acionado por hook final.",
};

const HOOKS_SUPERVISOR_REPO = "tuliomourarocha/module-sdd-commons";

// Seleção interativa → mapa simples role → modelo (Claude/Codex não usam variant).
function resolveRoleModels(selections, defaults) {
  const resolved = { ...defaults };
  for (const role of ROLE_ORDER) {
    const value = selections?.[role];
    if (typeof value === "string") resolved[role] = value;
    else if (value?.model) resolved[role] = value.model;
  }
  return resolved;
}

// ── RTK: download e vínculo com o harness escolhido ──────────────────────────

function shRun(command, env) {
  return spawnSync("/bin/sh", ["-c", command], { stdio: "inherit", env }).status ?? 1;
}

function shOut(command) {
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
}

async function findRtkBinary() {
  const onPath = shOut("command -v rtk");
  if (onPath) return onPath;
  const home = process.env.HOME ?? "";
  for (const candidate of [`${home}/.local/bin/rtk`, "/opt/homebrew/bin/rtk", "/usr/local/bin/rtk"]) {
    if (home && (await exists(candidate))) return candidate;
  }
  return null;
}

async function findBrew() {
  const onPath = shOut("command -v brew");
  if (onPath) return onPath;
  if (process.platform === "darwin") {
    for (const candidate of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

// OpenCode só carrega o plugin TypeScript do rtk a partir de 1.18.29.
// Retorno: true/false (sabemos) ou null (não dá para saber — deixa o rtk decidir).
function opencodePluginSupported() {
  const version = shOut("opencode --version");
  const match = version?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  return major > 1 || (major === 1 && minor > 18) || (major === 1 && minor === 18 && patch >= 29);
}

const RTK_AGENT_BINARIES = { opencode: "opencode", claude: "claude", codex: "codex" };

// Alvos do vínculo rtk × harness — agnóstico: independem da plataforma da squad.
// - sem --rtk-agents  → segue as plataformas pedidas (comportamento padrão)
// - --rtk-agents all  → auto-detecta os CLIs presentes no PATH (opencode, claude, codex)
// - --rtk-agents a,b  → vínculo explícito; avisa se o CLI do agente não estiver instalado
async function resolveRtkAgents(platformsRequested, value) {
  if (!value) return platformsRequested;
  if (value === "all") {
    const detected = [];
    for (const agent of Object.keys(RTK_AGENT_BINARIES)) {
      if (shOut(`command -v ${RTK_AGENT_BINARIES[agent]} >/dev/null 2>&1`) !== null) detected.push(agent);
      else console.log(`  ${agent}: CLI não encontrado no PATH — vínculo pulado (instale e rode --rtk-only --rtk-agents ${agent})`);
    }
    if (detected.length === 0) console.log("  nenhum harness reconhecido no PATH — nada para vincular");
    return detected;
  }
  const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const agent of requested) {
    if (!RTK_AGENT_BINARIES[agent]) {
      throw new Error(`harness desconhecido em --rtk-agents: ${agent} (use: opencode, claude, codex ou all)`);
    }
    if (shOut(`command -v ${RTK_AGENT_BINARIES[agent]} >/dev/null 2>&1`) === null) {
      console.log(`  ${agent}: CLI não encontrado no PATH — configurando mesmo assim (aplica quando instalar)`);
    }
  }
  return [...new Set(requested)];
}

async function installRtkBinary(rtk, dryRun) {
  if (dryRun) {
    console.log(`  [dry-run] RTK ausente — baixaria a edição "${rtk.edition}" (brew/winget/install.sh oficial)`);
    return null;
  }
  let installed = false;
  if (process.platform === "win32") {
    if (rtk.edition === "oss") console.log("  edição oss não é publicada no winget — instalando full");
    installed = shRun("winget install --id rtk-ai.rtk --accept-source-agreements --accept-package-agreements") === 0;
    return installed ? await findRtkBinary() : null;
  }
  const brew = await findBrew();
  if (brew) {
    const formula = rtk.edition === "oss" ? "rtk-ai/tap/rtk-oss" : "rtk";
    installed = shRun(`"${brew}" install ${formula}`) === 0;
  } else {
    const envVar = rtk.edition === "oss" ? "export RTK_EDITION=oss; " : "";
    installed = shRun(`${envVar}curl -fsSL ${RTK_INSTALL_URL} | sh`) === 0;
  }
  return installed ? await findRtkBinary() : null;
}

function rtkInitFlags(platform, scope) {
  const flags = [...(RTK_INIT_FLAGS[platform] ?? [])];
  if (platform === "opencode") {
    // o rtk publica o plugin do OpenCode apenas no escopo global
    if (scope === "project") console.log("  OpenCode só suporta vínculo global — usando --global");
    return flags;
  }
  if (scope === "project") {
    const globalIndex = flags.indexOf("--global");
    if (globalIndex >= 0) flags.splice(globalIndex, 1);
  }
  return flags;
}

async function bindRtkToHarness(platform, rtkBinaryPath, { scope, target, dryRun }) {
  const flags = rtkInitFlags(platform, scope);
  if (flags.length === 0) {
    console.error(`✖ RTK: sem integração conhecida para ${platform}`);
    return false;
  }
  if (platform === "opencode") {
    const supported = opencodePluginSupported();
    if (supported === false) {
      console.error("✖ RTK: OpenCode < 1.18.29 não carrega o plugin do rtk — atualize o Opencode e rode --rtk-only de novo");
      return false;
    }
  }
  if (dryRun) {
    console.log(`  [dry-run] "${rtkBinaryPath} init ${flags.join(" ")}"`);
    return true;
  }
  // Claude Code: --auto-patch aprova o patch do settings.json sem prompt (um único
  // comando, sem passo manual). Se esta versão do rtk não conhecer a flag, repetimos
  // sem ela.
  const argsList = platform === "claude" ? ["init", ...flags, "--auto-patch"] : ["init", ...flags];
  let result = spawnSync(rtkBinaryPath, argsList, {
    stdio: "inherit",
    cwd: scope === "project" ? target : process.cwd(),
  });
  if (result.status !== 0 && platform === "claude") {
    console.log("  claude: --auto-patch não suportado nesta versão do rtk — repetindo o vínculo padrão");
    result = spawnSync(rtkBinaryPath, ["init", ...flags], {
      stdio: "inherit",
      cwd: scope === "project" ? target : process.cwd(),
    });
  }
  if (result.status !== 0) {
    console.error(`✖ RTK: "rtk init ${flags.join(" ")}" falhou (exit ${result.status}) — o harness continua sem o proxy de comandos`);
    return false;
  }
  return true;
}

async function setupRtk(platformsRequested, { rtk, target, dryRun }) {
  console.log(`\n== RTK — economia de tokens (${rtk.edition}, escopo ${rtk.scope}) ==`);
  try {
    // agnóstico: por padrão segue as plataformas da instalação; --rtk-agents all autodetecta todos os harnesses
    const targets = await resolveRtkAgents(platformsRequested, rtk.agents);
    if (targets.length === 0) {
      console.log("✖ RTK: nenhum harness para vincular");
      return;
    }
    if (rtk.agents && rtk.agents !== "all") {
      console.log(`alvos do vínculo: ${targets.join(", ")}`);
    }
    let binaryPath = await findRtkBinary();
    if (!binaryPath) {
      console.log("RTK não encontrado — baixando...");
      binaryPath = await installRtkBinary(rtk, dryRun);
      if (dryRun && !binaryPath) return;
      if (!binaryPath) throw new Error("download do rtk não concluiu — verifique a saída acima");
      if (!shOut("command -v rtk")) {
        console.log("  rtk instalado fora do PATH (ex.: ~/.local/bin) — adicione 'export PATH=\"$HOME/.local/bin:$PATH\"' ao seu profile");
      }
    } else {
      console.log(`RTK encontrado: ${binaryPath}`);
    }
    const version = shOut(`"${binaryPath}" --version`);
    console.log(`versão do rtk: ${version ?? "desconhecida"}`);
    let bound = 0;
    for (const platform of targets) {
      if (await bindRtkToHarness(platform, binaryPath, { scope: rtk.scope, target, dryRun })) bound += 1;
    }
    console.log(
      bound > 0
        ? `✓ RTK vinculado a ${bound} harness(es) — reinicie o harness para ativar e acompanhe com "rtk gain"`
        : "✖ RTK não vinculado a nenhum harness",
    );
  } catch (error) {
    console.error(`✖ RTK: ${error.message}. A squad funciona sem ele — tente novamente com --rtk-only`);
  }
}

// ── CodeGraph + ast-grep — inteligência semântica ───────────────────────────
// codegraph — https://github.com/colbymchenry/codegraph — indexa o repositório
// e o expõe como MCP ("codegraph serve --mcp"); ast-grep — busca estrutural de
// sintaxe (AST). Mesma filosofia do rtk: baixa os binários, vincula ao harness
// escolhido e indexa o projeto. Falha em aberto: sem os binários a squad
// funciona só com leitura de arquivos. Telemetria desligada por padrão
// (CODEGRAPH_TELEMETRY=0); versões exatas resolvidas do registro npm.

const CODEGRAPH_NPM_PKG = "@colbymchenry/codegraph";
const AST_GREP_NPM_PKG = "@ast-grep/cli";

async function findNpm() {
  return shOut("command -v npm");
}

async function npmLatestVersion(pkg) {
  if (!(await findNpm())) return null;
  return shOut(`npm view ${pkg} version`);
}

async function installCodegraphCli(dryRun) {
  const onPath = shOut("command -v codegraph");
  if (onPath) {
    console.log(`codegraph encontrado: ${onPath} (${shOut("codegraph --version") ?? "versão desconhecida"})`);
    return onPath;
  }
  const version = await npmLatestVersion(CODEGRAPH_NPM_PKG);
  if (!version) throw new Error("npm não encontrado ou falha ao resolver a versão de @colbymchenry/codegraph");
  if (dryRun) {
    console.log(`  [dry-run] npm install -g ${CODEGRAPH_NPM_PKG}@${version}`);
    return null;
  }
  console.log(`codegraph não encontrado — instalando ${CODEGRAPH_NPM_PKG}@${version} (npm global, versão exata)...`);
  if (shRun(`npm install -g ${CODEGRAPH_NPM_PKG}@${version}`) !== 0) {
    throw new Error("npm install do codegraph falhou — verifique a saída acima");
  }
  const binary = shOut("command -v codegraph");
  if (!binary) throw new Error("codegraph não ficou disponível no PATH após a instalação");
  console.log(`✓ codegraph instalado: ${binary} (${shOut("codegraph --version") ?? "versão desconhecida"})`);
  return binary;
}

async function installAstGrepCli(dryRun) {
  const onPath = shOut("command -v ast-grep || command -v sg");
  if (onPath) {
    console.log(`ast-grep encontrado: ${onPath} (${shOut("ast-grep --version") ?? "versão desconhecida"})`);
    return onPath;
  }
  if (dryRun) {
    console.log("  [dry-run] baixaria o ast-grep (brew ast-grep, com fallback npm @ast-grep/cli)");
    return null;
  }
  const brew = await findBrew();
  if (brew && process.platform !== "win32") {
    console.log("ast-grep não encontrado — tentando brew (ast-grep)...");
    if (shRun(`"${brew}" install ast-grep`) === 0 && shOut("command -v ast-grep")) {
      const binary = shOut("command -v ast-grep");
      console.log(`✓ ast-grep instalado via brew: ${binary}`);
      return binary;
    }
    console.log("  brew falhou — tentando npm antes de desistir");
  }
  const version = await npmLatestVersion(AST_GREP_NPM_PKG);
  if (!version) throw new Error("npm não encontrado ou falha ao resolver a versão de @ast-grep/cli");
  if (dryRun) {
    console.log(`  [dry-run] npm install -g ${AST_GREP_NPM_PKG}@${version}`);
    return null;
  }
  console.log(`instalando ${AST_GREP_NPM_PKG}@${version} (npm global)...`);
  if (shRun(`npm install -g ${AST_GREP_NPM_PKG}@${version}`) !== 0) {
    throw new Error("npm install do ast-grep falhou — verifique a saída acima");
  }
  const binary = shOut("command -v ast-grep || command -v sg");
  if (!binary) throw new Error("ast-grep não ficou disponível no PATH após a instalação");
  console.log(`✓ ast-grep instalado: ${binary}`);
  return binary;
}

// Config MCP do codegraph — uma entrada por harness; sempre com telemetria off.
const CODEGRAPH_MCP_ENV = { CODEGRAPH_TELEMETRY: "0" };
const CODEGRAPH_LOCAL_SERVER = {
  type: "local",
  command: ["codegraph", "serve", "--mcp"],
  environment: CODEGRAPH_MCP_ENV,
};

async function bindCodegraphToHarness(platform, { target, dryRun }) {
  if (dryRun) {
    console.log(`  [dry-run] registraria o MCP "codegraph" (codegraph serve --mcp) no ${platform}`);
    return true;
  }

  // opencode: CLI nativa escreve no opencode.json do projeto; fallback merge JSON
  if (platform === "opencode") {
    if (shOut("command -v opencode")) {
      if (shRun(`cd ${JSON.stringify(target)} && opencode mcp add codegraph --env CODEGRAPH_TELEMETRY=0 -- codegraph serve --mcp`) === 0) {
        console.log('  ✓ MCP "codegraph" registrado no OpenCode do projeto ("opencode mcp list" para conferir)');
        return true;
      }
      console.log("  opencode mcp add falhou — tentando merge manual no opencode.json");
    }
    const configPath = path.join(target, "opencode.json");
    let config = {};
    if (await exists(configPath)) {
      try { config = JSON.parse(await readFile(configPath, "utf8")); } catch {
        console.log("  ✖ opencode.json não é JSON puro — registre o MCP manualmente");
        return false;
      }
    } else {
      config = { $schema: "https://opencode.ai/config.json" };
    }
    const servers = config.mcp?.servers ?? (config.mcp = { servers: {} }).servers;
    if (servers.codegraph?.type === "local") {
      console.log("  MCP \"codegraph\" já registrado no opencode.json");
    } else {
      servers.codegraph = CODEGRAPH_LOCAL_SERVER;
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
      console.log('  ✓ opencode.json atualizado com o MCP "codegraph"');
    }
    return true;
  }

  // claude: CLI nativa (--scope project escreve .mcp.json); fallback merge JSON
  if (platform === "claude") {
    const json = JSON.stringify({ type: "stdio", command: "codegraph", args: ["serve", "--mcp"], env: CODEGRAPH_MCP_ENV });
    if (shOut("command -v claude")) {
      if (shRun(`cd ${JSON.stringify(target)} && claude mcp add-json codegraph ${JSON.stringify(json)} --scope project`) === 0) {
        console.log('  ✓ MCP "codegraph" registrado no Claude Code do projeto (.mcp.json)');
        return true;
      }
      console.log("  claude mcp add-json falhou — tentando merge manual no .mcp.json");
    }
    const configPath = path.join(target, ".mcp.json");
    let config = {};
    if (await exists(configPath)) {
      try { config = JSON.parse(await readFile(configPath, "utf8")); } catch {
        console.log("  ✖ .mcp.json não é JSON puro — registre o MCP manualmente");
        return false;
      }
    }
    config.mcpServers = config.mcpServers ?? {};
    if (config.mcpServers.codegraph?.command) {
      console.log('  MCP "codegraph" já registrado no .mcp.json');
    } else {
      config.mcpServers.codegraph = { command: "codegraph", args: ["serve", "--mcp"], env: CODEGRAPH_MCP_ENV };
      await mkdir(target, { recursive: true });
      await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
      console.log('  ✓ .mcp.json atualizado com o MCP "codegraph"');
    }
    return true;
  }

  // codex: bloco TOML no .codex/config.toml do projeto (sem CLI de MCP project-scope estável)
  if (platform === "codex") {
    const configPath = path.join(target, ".codex", "config.toml");
    const block = [
      "",
      "[mcp_servers.codegraph]",
      'command = "codegraph"',
      'args = ["serve", "--mcp"]',
      `env = { CODEGRAPH_TELEMETRY = "0" }`,
      "",
    ].join("\n");
    if (await exists(configPath)) {
      const content = await readFile(configPath, "utf8");
      if (/\[mcp_servers\.codegraph\]/.test(content)) {
        console.log('  MCP "codegraph" já registrado no .codex/config.toml');
        return true;
      }
      await writeFile(configPath, `${content.replace(/\s*$/, "")}\n${block}`);
      console.log('  ✓ .codex/config.toml atualizado com o MCP "codegraph"');
    } else {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, block);
      console.log('  ✓ .codex/config.toml criado com o MCP "codegraph"');
    }
    return true;
  }

  console.error(`✖ CodeGraph: sem integração conhecida para ${platform}`);
  return false;
}

// Índice semântico do projeto + .gitignore (estado gerado, nunca versionado)
async function initCodegraphIndex(target, dryRun) {
  if (dryRun) {
    console.log(`  [dry-run] CODEGRAPH_TELEMETRY=0 codegraph init ${target}`);
    return;
  }
  const gitignorePath = path.join(target, ".gitignore");
  if (await exists(gitignorePath)) {
    const content = await readFile(gitignorePath, "utf8");
    if (!/^\.codegraph\/?$/m.test(content)) {
      await writeFile(gitignorePath, `${content.replace(/\s*$/, "")}\n\n# CodeGraph (índice semântico gerado)\n.codegraph/\n`);
      console.log("  ✓ .codegraph/ adicionado ao .gitignore (índice é estado gerado)");
    }
  } else {
    await writeFile(gitignorePath, "# CodeGraph (índice semântico gerado)\n.codegraph/\n");
    console.log("  ✓ .gitignore criado com .codegraph/");
  }
  if (shOut("command -v codegraph")) {
    console.log(`construindo o índice semântico do projeto (codegraph init, telemetria desligada)...`);
    if (shRun(`CODEGRAPH_TELEMETRY=0 codegraph init ${JSON.stringify(target)}`) !== 0) {
      console.log("  codegraph init falhou — rode 'CODEGRAPH_TELEMETRY=0 codegraph init' manualmente; a squad funciona sem o índice");
    } else {
      console.log("  ✓ índice criado (diretório .codegraph/)");
    }
  }
}

async function setupCodegraph(platformsRequested, { target, dryRun }) {
  console.log("\n== CodeGraph + ast-grep — inteligência semântica ==");
  try {
    if (platformsRequested.length === 0) {
      console.log("✖ CodeGraph: nenhuma plataforma para configurar");
      return;
    }
    await installCodegraphCli(dryRun);
    await installAstGrepCli(dryRun);
    let bound = 0;
    for (const platform of platformsRequested) {
      if (await bindCodegraphToHarness(platform, { target, dryRun })) bound += 1;
    }
    await initCodegraphIndex(target, dryRun);
    console.log(
      bound > 0
        ? `✓ CodeGraph configurado em ${bound} harness(es) — reinicie o harness para ativar o MCP "codegraph"`
        : "✖ CodeGraph não vinculado a nenhum harness",
    );
  } catch (error) {
    console.error(`✖ CodeGraph: ${error.message}. A squad funciona sem ele — rode o instalador novamente para reconciliar`);
  }
}

async function installOpenCode(target, dryRun, modelSelections) {
  const root = path.join(target, ".opencode");
  await copyDirectory(path.join(sourceRoot, "agents"), path.join(root, "agents"), dryRun);
  if (!dryRun) {
    for (const role of ROLE_ORDER) {
      const oldFile = path.join(root, "agents", `${role}.agent.md`);
      const newFile = path.join(root, "agents", `${role}.md`);
      if (await exists(oldFile)) await writeFile(newFile, await readFile(oldFile));
      if (await exists(oldFile)) {
        const { rm } = await import("node:fs/promises");
        await rm(oldFile);
      }
    }
    await applyOpenCodeSelections(root, modelSelections);
  }
  await copyDirectory(path.join(sourceRoot, "commands"), path.join(root, "commands"), dryRun);
  await copyDirectory(path.join(sourceRoot, "skills"), path.join(root, "skills"), dryRun);
  // ── Hooks determinísticos (guard rails + shipper + ci-watch + supervisor) ──────
  // plugins: copiados para .opencode/plugins/ (auto-load pelo opencode)
  if (await exists(path.join(sourceRoot, "plugins"))) {
    await copyDirectory(path.join(sourceRoot, "plugins"), path.join(root, "plugins"), dryRun);
  }
  // hooks python: copiados para .opencode/hooks/ e também hooks/ na raiz do target para fallback
  if (await exists(path.join(sourceRoot, "hooks"))) {
    await copyDirectory(path.join(sourceRoot, "hooks"), path.join(root, "hooks"), dryRun);
    // também espelha em <target>/hooks para compat com Claude/Codex e fallback do plugin
    await copyDirectory(path.join(sourceRoot, "hooks"), path.join(target, "hooks"), dryRun);
    if (!dryRun) {
      // garantir permissão de execução nos scripts python
        for (const script of ["guard_rails.py", "shipper.py", "ci_watch.py", "ci_orchestrator.py", "supervisor.py"]) {
          const p1 = path.join(root, "hooks", script);
          const p2 = path.join(target, "hooks", script);
          for (const p of [p1, p2]) {
            if (await exists(p)) await chmod(p, 0o755).catch(() => {});
          }
        }
    }
  }
  // garante .opencode/package.json com @opencode-ai/plugin para plugins TS tipados
  if (!dryRun) {
    const pkgPath = path.join(root, "package.json");
    let pkg = {};
    if (await exists(pkgPath)) {
      try { pkg = JSON.parse(await readFile(pkgPath, "utf8")); } catch { pkg = {}; }
    }
    pkg.dependencies = pkg.dependencies || {};
    if (!pkg.dependencies["@opencode-ai/plugin"]) {
      pkg.dependencies["@opencode-ai/plugin"] = "^1.17.11";
      await mkdir(root, { recursive: true });
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
  }
  // template opencode.json se não existir no target
  if (!dryRun && await exists(path.join(sourceRoot, "platforms", "opencode", "opencode.json"))) {
    const targetOpencodeJson = path.join(target, "opencode.json");
    const dotOpencodeJson = path.join(root, "opencode.json");
    if (!(await exists(targetOpencodeJson)) && !(await exists(dotOpencodeJson))) {
      await writeFile(targetOpencodeJson, await readFile(path.join(sourceRoot, "platforms", "opencode", "opencode.json")));
    }
  }
  return root;
}

async function installClaude(target, dryRun, modelSelections) {
  const root = path.join(target, ".claude");
  const roleModels = resolveRoleModels(modelSelections, claudeRoleModels);
  if (!dryRun) {
    await mkdir(path.join(root, "agents"), { recursive: true });
    for (const role of ROLE_ORDER) {
      const body = (await agentBody(role)).replaceAll("task()", "Agent tool");
      await writeFile(path.join(root, "agents", `${role}.md`), `---\n${claudeFrontmatter(role, roleModels)}\n---\n\n${body}\n`);
    }
    await mkdir(path.join(root, "commands"), { recursive: true });
    await writeFile(path.join(root, "commands", "sdd-harness.md"), await readFile(path.join(sourceRoot, "platforms", "claude", "sdd-harness-command.md")));
    await writeFile(path.join(root, "CLAUDE.md"), await readFile(path.join(sourceRoot, "platforms", "claude", "CLAUDE.md")));
    // hooks determinísticos Claude: settings.json + scripts em .claude/hooks/
    if (await exists(path.join(sourceRoot, "platforms", "claude", "hooks"))) {
      await copyDirectory(path.join(sourceRoot, "platforms", "claude", "hooks"), path.join(root, "hooks"), dryRun);
      for (const script of ["guard_rails.py", "shipper.py", "ci_watch.py", "ci_orchestrator.py", "supervisor.py"]) {
        const p = path.join(root, "hooks", script);
        if (await exists(p)) await chmod(p, 0o755).catch(() => {});
      }
    }
    if (await exists(path.join(sourceRoot, "platforms", "claude", "settings.json"))) {
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "settings.json"), await readFile(path.join(sourceRoot, "platforms", "claude", "settings.json")));
    }
    // fallback: se platforms/claude não tem hooks, copia de hooks/ raiz
    if (!(await exists(path.join(root, "hooks", "guard_rails.py"))) && await exists(path.join(sourceRoot, "hooks"))) {
      await copyDirectory(path.join(sourceRoot, "hooks"), path.join(root, "hooks"), dryRun);
    }
  }
  await copyDirectory(path.join(sourceRoot, "skills"), path.join(root, "skills"), dryRun);
  return root;
}

async function installCodex(target, dryRun, modelSelections) {
  const root = path.join(target, ".codex");
  const roleModels = resolveRoleModels(modelSelections, codexRoleModels);
  if (!dryRun) {
    await mkdir(path.join(root, "roles"), { recursive: true });
    for (const role of ROLE_ORDER) {
      await writeFile(path.join(root, "roles", `${role}.md`), `${await agentBody(role)}\n`);
    }
    await writeFile(
      path.join(root, "sdd-harness.json"),
      `${JSON.stringify({ provider: "openai", roleModels }, null, 2)}\n`,
    );
    await mkdir(path.join(root, "skills", "sdd-harness"), { recursive: true });
    await writeFile(path.join(root, "skills", "sdd-harness", "SKILL.md"), await readFile(path.join(sourceRoot, "platforms", "codex", "SKILL.md")));
    // hooks determinísticos Codex: copia para .codex/hooks/
    if (await exists(path.join(sourceRoot, "hooks"))) {
      await copyDirectory(path.join(sourceRoot, "hooks"), path.join(root, "hooks"), dryRun);
      for (const script of ["guard_rails.py", "shipper.py", "ci_watch.py", "ci_orchestrator.py", "supervisor.py"]) {
        const p = path.join(root, "hooks", script);
        if (await exists(p)) await chmod(p, 0o755).catch(() => {});
      }
    }
  }
  await copyDirectory(path.join(sourceRoot, "skills"), path.join(root, "skills"), dryRun);
  return root;
}

async function main() {
  const { selected, target, dryRun, rtk, codegraph, modelPicker } = parseArgs(process.argv.slice(2));
  console.log(`${dryRun ? "Simulação" : "Instalando"} SDD Harness em ${target}`);

  if (rtk.only) {
    console.log("--rtk-only: pulando instalação de artefatos (agents/commands/skills/hooks)");
  } else {
    const interactive = modelPicker && Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!modelPicker) console.log("Modelos: padrão da squad (--no-model-picker)");
    else if (!interactive && !dryRun) console.log("Modelos: padrão da squad (sem TTY para escolha interativa)");

    const modelSelections = modelPicker
      ? await selectModels({ platforms: selected, sourceRoot, dryRun, interactive })
      : {};

    for (const platform of selected) {
      const output = await ({ opencode: installOpenCode, claude: installClaude, codex: installCodex }[platform])(
        target,
        dryRun,
        modelSelections[platform],
      );
      console.log(`✓ ${platform}: ${output}`);
    }
  }

  if (rtk.enabled) {
    await setupRtk(selected, { rtk, target, dryRun });
  } else {
    console.log("RTK: pulado (--no-rtk) — comandos de shell chegam crus ao LLM");
  }

  if (codegraph.enabled) {
    await setupCodegraph(selected, { target, dryRun });
  } else {
    console.log("CodeGraph: pulado (--no-codegraph) — agentes seguem só com leitura de arquivos");
  }
}

main().catch((error) => { console.error(`Erro: ${error.message}`); process.exitCode = 1; });
