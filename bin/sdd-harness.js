#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile, access, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function usage(exitCode = 0) {
  console.log(`Uso: npx --yes github:tuliomourarocha/module-sdd-commons#main --<plataforma> [opções]

Plataformas: --opencode, --claude, --codex, --all
Opções:     --target <diretório-do-projeto>   (padrão: diretório atual)
             --dry-run
             --help

Exemplos:
  npx --yes github:tuliomourarocha/module-sdd-commons#main --opencode
  npx --yes github:tuliomourarocha/module-sdd-commons#main --claude --target ../meu-app
  npx --yes github:tuliomourarocha/module-sdd-commons#main --all --target .`);
  process.exit(exitCode);
}

function parseArgs(args) {
  const selected = [];
  let target = process.cwd();
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument === "--dry-run") { dryRun = true; continue; }
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

  if (selected.length === 0) throw new Error("Escolha uma plataforma: --opencode, --claude, --codex ou --all.");
  return { selected: [...new Set(selected)], target, dryRun };
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
  planner: "Planeja produto e arquitetura; gera PRD, PLAN e diagramas.",
  builder: "Implementa full-stack a partir de um PLAN aprovado.",
  reviewer: "Revisa arquitetura técnica e de software; gera REVIEW.md (sem lint — hooks fazem).",
  shipper: "Finaliza via hook determinístico (git/PR/CI/Trello/STATE/HANDOFF); fallback minimal só STATE/HANDOFF.",
  supervisor: "Audita ciclo completo, mede performance/alucinações/tokens e cria Issue. Acionado por hook final.",
};

const HOOKS_SUPERVISOR_REPO = "tuliomourarocha/module-sdd-commons";

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
  const { selected, target, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`${dryRun ? "Simulação" : "Instalando"} SDD Harness em ${target}`);
  for (const platform of selected) {
    const output = await ({ opencode: installOpenCode, claude: installClaude, codex: installCodex }[platform])(target, dryRun);
    console.log(`✓ ${platform}: ${output}`);
  }
}

main().catch((error) => { console.error(`Erro: ${error.message}`); process.exitCode = 1; });
