import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const graphEnv = { ...process.env, CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" };
const graphMcpEnv = [
  { name: "CODEGRAPH_TELEMETRY", value: "0" },
  { name: "CODEGRAPH_NO_UPDATE_CHECK", value: "1" },
];

async function command(bin, args, { cwd, env, onTool, label = [bin, ...args].join(" "), showOutput = false, timeout = 60000 }) {
  const report = (status) => onTool(label, status);
  report("running");
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("tempo limite excedido"));
      }, timeout);
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(-100000); });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || stdout.trim().slice(-2000) || `código ${code}`));
      });
    });
    if (showOutput && output) console.log(output.slice(0, 4000));
    report("completed");
    return output;
  } catch (error) {
    report("failed");
    throw new Error(`${label}: ${error.message}`);
  }
}

function rtkSetup(harness, cwd) {
  const args = ["init", "--show", harness === "codex" ? "--codex" : "--opencode"];
  const config = spawnSync("rtk", args, { cwd, encoding: "utf8", timeout: 5000 });
  const hook = harness === "codex"
    ? /\[ok\] (?:Local|Global) hook:/
    : /\[ok\] OpenCode: plugin installed/;
  return config.status === 0 && hook.test(config.stdout);
}

export async function prepareTools({ harness, cwd, ask, onTool }) {
  const opts = { cwd, onTool };
  if (process.env.RTK_DISABLED === "1") throw new Error("RTK está desativado por RTK_DISABLED=1. Habilite-o antes de executar.");
  await command("rtk", ["hook", harness, "--help"], opts);
  if (!rtkSetup(harness, cwd)) {
    const flags = harness === "opencode" ? ["--global", "--opencode"] : ["--codex"];
    if (!await ask(`Vincular o RTK ao ${harness}?`, "s", harness === "opencode"
      ? "O RTK instalará seu plugin na configuração do usuário do OpenCode."
      : "O RTK instalará o hook do Codex neste projeto. O Codex pode solicitar a revisão do hook.")) return null;
    await command("rtk", ["init", ...flags, "--hook-only", "--no-patch", "--no-trust-filters"], { ...opts, showOutput: true });
    if (!rtkSetup(harness, cwd)) throw new Error(`O vínculo nativo do RTK com ${harness} não foi encontrado após a configuração.`);
  }

  const graph = { ...opts, env: graphEnv };
  const index = path.resolve(cwd, process.env.CODEGRAPH_DIR || ".codegraph");
  const indexed = await fs.stat(index).then((entry) => entry.isDirectory()).catch(() => false);
  if (!indexed) await command("codegraph", ["init", "--yes", "--local-only", cwd], { ...graph, timeout: 180000 });
  await command("codegraph", ["status", cwd], { ...graph, showOutput: true });

  const args = ["serve", "--mcp", "--path", cwd];
  return {
    mcpServer: { name: "codegraph", command: "codegraph", args, env: graphMcpEnv },
    semanticContext: (title) => command("codegraph", ["context", "--path", cwd, "--max-nodes", "12", "--", title], { ...graph, label: "codegraph context · issue" }),
  };
}

// A comparação do worktree cobre CLIs que escrevem por comandos de shell
// e adaptadores que não enviam caminhos no evento ACP.
function gitRoot(cwd) {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5000 });
  return root.status === 0 ? root.stdout.trim() : null;
}

async function worktreeFiles(cwd) {
  if (!cwd) return null;
  const result = spawnSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--"], {
    cwd, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const files = new Map();
  const entries = result.stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    if (/[RC]/.test(status)) i++;
    const stat = await fs.lstat(path.join(cwd, file), { bigint: true }).catch(() => null);
    files.set(path.resolve(cwd, file), status.includes("D") && !stat ? null : `${stat?.mtimeNs}:${stat?.size}`);
  }
  return files;
}

export async function observeFiles(cwd, report) {
  const recent = new Map();
  const log = (file, action) => {
    const relative = path.relative(cwd, path.resolve(cwd, file));
    const now = Date.now();
    if (!relative || now - (recent.get(relative) ?? 0) < 2200) return;
    recent.set(relative, now);
    report(`${action} · ${relative}`);
  };
  const root = gitRoot(cwd);
  let baseline = await worktreeFiles(root);
  let scanning;
  const scan = () => {
    scanning ??= (async () => {
      const current = await worktreeFiles(root);
      if (!current) return;
      if (baseline) {
        for (const [file, signature] of current) {
          if (baseline.get(file) !== signature) log(file, signature == null ? "Removido" : "Alterado");
        }
      }
      baseline = current;
    })().finally(() => { scanning = null; });
    return scanning;
  };
  const timer = root ? setInterval(scan, 2000) : null;
  return {
    log,
    async stop() {
      clearInterval(timer);
      await scanning;
      await scan();
    },
  };
}

function outputText(value) {
  if (typeof value === "string") return stripVTControlCharacters(value);
  if (value && typeof value === "object") return Object.values(value).map(outputText).filter(Boolean).join("\n");
  return "";
}

export function toolOutput(update, status) {
  const chunks = [update._meta?.terminal_output_delta, update._meta?.terminal_output];
  if (status === "completed" || status === "failed") chunks.push(update.content, update.rawOutput);
  return outputText(chunks);
}

export function editDetails(tool) {
  const locations = (tool.locations ?? []).map(({ path }) => path).filter((file) => typeof file === "string");
  const diffs = Array.isArray(tool.content) ? tool.content.filter((item) => item.type === "diff" && typeof item.path === "string") : [];
  const kinds = { edit: "Editado", delete: "Removido", move: "Movido" };
  const edit = Object.hasOwn(kinds, tool.kind);
  const files = new Map(edit ? locations.map((file) => [file, kinds[tool.kind]]) : []);
  for (const item of diffs) {
    files.set(item.path, item.oldText === null ? "Criado" : item.newText === null ? "Removido" : "Editado");
  }
  return files;
}
