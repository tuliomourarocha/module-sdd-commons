import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execGit = promisify(execFile);
export const artifactIgnores = [
  "/.opencode/", "/.claude/", "/.codex/", "/.agents/", "/.planning/",
  "/.codegraph/", "/.rtk/", "/.mcp.json", "/opencode.json", "/skills-lock.json", "/RTK.md",
];
const artifactPaths = artifactIgnores.map((rule) => rule.slice(1).replace(/\/$/, ""));

export async function trackedArtifactRoots(cwd, roots) {
  const specs = roots.map((root) => `:(icase,literal)${root}`);
  const { stdout } = await execGit("git", ["ls-files", "-z", "--", ...specs], { cwd, timeout: 20_000 });
  const files = stdout.toLowerCase().split("\0");
  return roots.filter((root) => files.some((file) => file === root.toLowerCase() || file.startsWith(root.toLowerCase() + "/")));
}

export async function resetLocalArtifacts(cwd, { confirm, log }) {
  const existing = [];
  for (const file of artifactPaths) {
    try {
      await lstat(path.join(cwd, file));
      existing.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!existing.length) return false;

  const tracked = await trackedArtifactRoots(cwd, existing);
  if (tracked.length) log("info", `Artefatos com arquivos rastreados preservados · ${tracked.join(", ")}`);
  const removable = existing.filter((file) => !tracked.includes(file));
  if (!removable.length) return false;

  const approved = await confirm(
    "Apagar artefatos locais e reinstalar após atualizar develop?",
    "n",
    "A exclusão inclui configurações locais, skills e estado de execuções existentes nos caminhos abaixo.\n\n" +
      removable.join("\n"),
  );
  if (!approved) return false;

  const nowTracked = await trackedArtifactRoots(cwd, removable);
  if (nowTracked.length) throw new Error(`Arquivos passaram a ser rastreados desde a confirmação: ${nowTracked.join(", ")}.`);
  for (const file of removable) await rm(path.join(cwd, file), { recursive: true, force: true });
  log("info", `Artefatos locais removidos · ${removable.join(", ")}`);
  return true;
}
