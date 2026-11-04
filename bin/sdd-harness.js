#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platforms = new Set(["opencode", "claude", "codex"]);
const claudeRoleModels = {
  harness: "haiku",
  planner: "sonnet",
  builder: "sonnet",
  reviewer: "sonnet",
  shipper: "haiku",
};
const codexRoleModels = {
  harness: "gpt-5.6-luna",
  planner: "gpt-5.6-sol",
  builder: "gpt-5.6-sol",
  reviewer: "gpt-5.6-terra",
  shipper: "gpt-5.6-terra",
};

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
             --help

Sobre o rtk: proxy de comandos (https://github.com/rtk-ai/rtk) que comprime a
saída de shell antes do LLM ler. Durante a instalação o binário é baixado
(brew / winget / install.sh oficial) e vinculado ao harness escolhido com
"rtk init". Saída estranha? "rtk bypass <cmd>" roda sem filtro.

--rtk-agents: por padrão o vínculo segue as plataformas da instalação;
  "all" detecta e vincula todos os harnesses instalados (opencode, claude,
  codex); ou passe uma lista csv: --rtk-agents opencode,codex

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

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument === "--dry-run") { dryRun = true; continue; }
    if (argument === "--no-rtk") { rtk.enabled = false; continue; }
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
  return { selected: [...new Set(selected)], target, dryRun, rtk };
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

function claudeFrontmatter(role) {
  const common = [
    `name: ${role}`,
    `description: ${descriptions[role]}`,
    `model: ${claudeRoleModels[role]}`,
    `maxTurns: ${role === "builder" ? 25 : role === "harness" || role === "planner" ? 20 : 15}`,
  ];
  if (role === "harness") return [...common, "tools: Read, Glob, Grep, Agent", "disallowedTools: Write, Edit, Bash, WebFetch"].join("\n");
  if (role === "planner") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  if (role === "builder") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  if (role === "reviewer") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
}

const descriptions = {
  harness: "Orquestra feature, project ou bugfix pelos quatro papéis + hooks do SDD Harness.",
  planner: "Planeja produto e arquitetura; gera PRD, PLAN e diagramas (memória).",
  builder: "Implementa full-stack a partir de um PLAN aprovado (retorna resumo em memória, nunca SUMMARY.md).",
  reviewer: "Revisa arquitetura técnica e de software; gera parecer em memória (nunca REVIEW.md/VALIDATION.md, sem lint — hooks fazem).",
  shipper: "Finaliza via hook determinístico (git/PR/CI/Trello/STATE/HANDOFF); fallback minimal só STATE/HANDOFF.",
  supervisor: "Audita ciclo completo, mede performance/alucinações/tokens e cria Issue. Acionado por hook final.",
};

const HOOKS_SUPERVISOR_REPO = "tuliomourarocha/module-sdd-commons";

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

async function installOpenCode(target, dryRun) {
  const root = path.join(target, ".opencode");
  await copyDirectory(path.join(sourceRoot, "agents"), path.join(root, "agents"), dryRun);
  if (!dryRun) {
    for (const role of Object.keys(claudeRoleModels)) {
      const oldFile = path.join(root, "agents", `${role}.agent.md`);
      const newFile = path.join(root, "agents", `${role}.md`);
      if (await exists(oldFile)) await writeFile(newFile, await readFile(oldFile));
      if (await exists(oldFile)) {
        const { rm } = await import("node:fs/promises");
        await rm(oldFile);
      }
    }
    // supervisor é subagent adicional — também normaliza .agent.md → .md se existir
    const supOld = path.join(root, "agents", "supervisor.agent.md");
    const supNew = path.join(root, "agents", "supervisor.md");
    if (await exists(supOld)) {
      await writeFile(supNew, await readFile(supOld));
      const { rm } = await import("node:fs/promises");
      await rm(supOld);
    }
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

async function installClaude(target, dryRun) {
  const root = path.join(target, ".claude");
  if (!dryRun) {
    await mkdir(path.join(root, "agents"), { recursive: true });
    for (const role of Object.keys(claudeRoleModels)) {
      const body = (await agentBody(role)).replaceAll("task()", "Agent tool");
      await writeFile(path.join(root, "agents", `${role}.md`), `---\n${claudeFrontmatter(role)}\n---\n\n${body}\n`);
    }
    // supervisor para Claude também
    if (await exists(path.join(sourceRoot, "agents", "supervisor.agent.md"))) {
      const supBody = (await readFile(path.join(sourceRoot, "agents", "supervisor.agent.md"), "utf8")).split(/^---\s*$/m).slice(2).join("---").trim().replaceAll("task()", "Agent tool");
      const supFm = `name: supervisor\ndescription: ${descriptions.supervisor}\nmodel: haiku\nmaxTurns: 15`;
      await writeFile(path.join(root, "agents", "supervisor.md"), `---\n${supFm}\n---\n\n${supBody}\n`);
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

async function installCodex(target, dryRun) {
  const root = path.join(target, ".codex");
  if (!dryRun) {
    await mkdir(path.join(root, "roles"), { recursive: true });
    for (const role of Object.keys(claudeRoleModels)) {
      await writeFile(path.join(root, "roles", `${role}.md`), `${await agentBody(role)}\n`);
    }
    if (await exists(path.join(sourceRoot, "agents", "supervisor.agent.md"))) {
      await writeFile(path.join(root, "roles", "supervisor.md"), `${await agentBody("supervisor")}\n`);
    }
    await writeFile(
      path.join(root, "sdd-harness.json"),
      `${JSON.stringify({ provider: "openai", roleModels: codexRoleModels }, null, 2)}\n`,
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
  const { selected, target, dryRun, rtk } = parseArgs(process.argv.slice(2));
  console.log(`${dryRun ? "Simulação" : "Instalando"} SDD Harness em ${target}`);

  if (rtk.only) {
    console.log("--rtk-only: pulando instalação de artefatos (agents/commands/skills/hooks)");
  } else {
    for (const platform of selected) {
      const output = await ({ opencode: installOpenCode, claude: installClaude, codex: installCodex }[platform])(target, dryRun);
      console.log(`✓ ${platform}: ${output}`);
    }
  }

  if (rtk.enabled) {
    await setupRtk(selected, { rtk, target, dryRun });
  } else {
    console.log("RTK: pulado (--no-rtk) — comandos de shell chegam crus ao LLM");
  }
}

main().catch((error) => { console.error(`Erro: ${error.message}`); process.exitCode = 1; });
