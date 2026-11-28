import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);

export function observeMcp(server, report) {
  const dir = mkdtempSync(path.join(tmpdir(), "sdd-mcp-"));
  const statusFile = path.join(dir, "status");
  let previous = "connecting";
  report(previous);
  const update = () => {
    let status;
    try { status = readFileSync(statusFile, "utf8"); } catch { return; }
    if (!["connected", "failed"].includes(status) || status === previous) return;
    previous = status;
    report(status);
  };
  let watcher;
  try {
    watcher = watch(dir, update);
    watcher.on("error", () => watcher.close());
  } catch {
    // A leitura ao encerrar a sessão ainda registra o último estado.
  }
  return {
    server: { ...server, command: process.execPath, args: [script, statusFile, server.command, ...server.args] },
    update,
    close() {
      watcher?.close();
      update();
      if (previous === "connecting") report("unconfirmed");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function forwardMcp(statusFile, command, args) {
  const server = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  const report = (status) => {
    try { writeFileSync(statusFile, status); } catch { /* sessão já encerrada */ }
  };
  const observe = (stream, handle) => createInterface({ input: stream }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message && typeof message === "object") handle(message);
  });
  // Observe as mensagens sem modificar o transporte stdio do MCP.
  observe(process.stdin, ({ id, method }) => {
    if (id != null && (method === "initialize" || method === "tools/list")) pending.set(id, method);
  });
  observe(server.stdout, ({ id, result, error }) => {
    const method = pending.get(id);
    pending.delete(id);
    if (method && error) report("failed");
    else if (method === "tools/list" && Array.isArray(result?.tools)) report("connected");
  });
  server.stdin.on("error", () => {});
  process.stdout.on("error", () => server.kill());
  server.on("error", () => report("failed"));
  server.on("close", (code) => {
    if (!process.stdin.readableEnded) report("failed");
    process.stdin.destroy();
    process.exitCode = code ?? 1;
  });
  process.on("SIGTERM", () => server.kill());
  process.on("SIGINT", () => server.kill("SIGINT"));
  process.stdin.pipe(server.stdin);
  server.stdout.pipe(process.stdout);
}

if (process.argv[1] === script) {
  const [, , statusFile, command, ...args] = process.argv;
  forwardMcp(statusFile, command, args);
}
