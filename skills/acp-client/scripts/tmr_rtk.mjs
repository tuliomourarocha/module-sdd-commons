import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function findRtk() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(dir, "rtk");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error("O executável do RTK não está no PATH do TMR.");
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

// O executável intermediário mantém o hook nativo responsável pela reescrita.
// O arquivo temporário registra a decisão mesmo quando o harness captura o stderr.
export function observeRtk(report, warn) {
  if (process.env.RTK_VISIBILITY === "0") return null;
  if (process.platform === "win32") {
    warn("O registro por comando do RTK no TMR requer um ambiente Unix.");
    return null;
  }
  const rtk = findRtk();
  const dir = mkdtempSync(path.join(process.env.SDD_TMR_TMP ?? os.tmpdir(), "rtk-"));
  const logFile = path.join(dir, "hooks.jsonl");
  let cursor = 0;
  let watcher;
  const drain = () => {
    const content = readFileSync(logFile);
    for (let end; (end = content.indexOf(10, cursor)) !== -1; cursor = end + 1) {
      report(JSON.parse(content.toString("utf8", cursor, end)));
    }
  };
  try {
    writeFileSync(logFile, "", { mode: 0o600 });
    const audit = [process.execPath, fileURLToPath(import.meta.url), rtk, logFile].map(quote).join(" ");
    writeFileSync(path.join(dir, "rtk"), [
      "#!/bin/sh",
      'case "$1:$2" in',
      `  hook:codex|hook:opencode) exec ${audit} "$@" ;;`,
      "esac",
      `exec ${quote(rtk)} "$@"`,
      "",
    ].join("\n"), { mode: 0o700 });
    watcher = watch(logFile, () => {
      try { drain(); } catch (error) { warn(`Falha ao ler o log do RTK · ${error.message}`); }
    });
    watcher.on("error", (error) => warn(`Falha ao acompanhar o log do RTK · ${error.message}`));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  watcher.unref();
  return {
    env: { ...process.env, PATH: [dir, process.env.PATH].join(path.delimiter), SDD_TMR_RTK_AUDIT: "1" },
    close() {
      watcher.close();
      try { drain(); } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

function forwardHook([rtk, logFile, ...args]) {
  const codex = args[1] === "codex";
  const stdin = codex ? readFileSync(0) : undefined;
  const result = spawnSync(rtk, args, { input: stdin, encoding: "utf8", timeout: 4000, maxBuffer: 2 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;

  if (!codex && (args.length < 3 || (args.length === 3 && args[2] === "--help"))) return;
  let command = args.at(-1);
  try {
    if (codex) command = JSON.parse(stdin).tool_input?.command;
    if (typeof command !== "string" || !command.trim()) return;
    let status = "falhou";
    if (result.status === 0) {
      try {
        const answer = JSON.parse(result.stdout?.trim() || "{}");
        const rewritten = codex ? answer.hookSpecificOutput?.updatedInput?.command : answer.command;
        status = rewritten && rewritten !== command ? "reescrito" : "sem reescrita";
      } catch {}
    }
    appendFileSync(logFile, JSON.stringify({ status, command: command.trim().replace(/\s*\n\s*/g, " ").slice(0, 500) }) + "\n");
  } catch {
    // A observabilidade não deve alterar a resposta do hook ao harness.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  forwardHook(process.argv.slice(2));
}
