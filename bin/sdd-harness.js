#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platforms = new Set(["opencode", "claude", "codex"]);
const claudeRoleModels = {
  harness: "haiku",
  planner: "sonnet",
  builder: "sonnet",
  checker: "haiku",
  reviewer: "sonnet",
  shipper: "haiku",
};
const codexRoleModels = {
  harness: "gpt-5.6-luna",
  planner: "gpt-5.6-sol",
  builder: "gpt-5.6-sol",
  checker: "gpt-5.6-luna",
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
  if (role === "checker") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  if (role === "reviewer") return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
  return [...common, "tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, Skill"].join("\n");
}

const descriptions = {
  harness: "Orquestra feature, project ou bugfix pelos cinco papéis do SDD Harness.",
  planner: "Planeja produto e arquitetura; gera PRD, PLAN e diagramas.",
  builder: "Implementa full-stack a partir de um PLAN aprovado.",
  checker: "Cria e executa testes; gera VALIDATION.md.",
  reviewer: "Faz revisão estática, lint e typecheck; gera REVIEW.md.",
  shipper: "Finaliza o ciclo com git, PR, CI e estado do projeto.",
};

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
  }
  await copyDirectory(path.join(sourceRoot, "commands"), path.join(root, "commands"), dryRun);
  await copyDirectory(path.join(sourceRoot, "skills"), path.join(root, "skills"), dryRun);
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
    await mkdir(path.join(root, "commands"), { recursive: true });
    await writeFile(path.join(root, "commands", "sdd-harness.md"), await readFile(path.join(sourceRoot, "platforms", "claude", "sdd-harness-command.md")));
    await writeFile(path.join(root, "CLAUDE.md"), await readFile(path.join(sourceRoot, "platforms", "claude", "CLAUDE.md")));
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
    await writeFile(
      path.join(root, "sdd-harness.json"),
      `${JSON.stringify({ provider: "openai", roleModels: codexRoleModels }, null, 2)}\n`,
    );
    await mkdir(path.join(root, "skills", "sdd-harness"), { recursive: true });
    await writeFile(path.join(root, "skills", "sdd-harness", "SKILL.md"), await readFile(path.join(sourceRoot, "platforms", "codex", "SKILL.md")));
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
