import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function deliveryStart(cwd) {
  return { from: git(cwd, ["rev-parse", "--verify", "HEAD"]), branch: "" };
}

function runHook(file, args, context, { cwd, env, onLine }) {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-u", file, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", onLine);
    child.once("error", (error) => onLine(error.message));
    child.stdin.on("error", () => {});
    child.stdin.end(context && JSON.stringify(context));
    child.once("close", (code) => resolve(code));
  });
}

const redact = (line) => line.replace(/((?:https?|ssh):\/\/)[^\s/]+@/gi, "$1[credenciais]@");

export async function runDelivery({ root, cwd, issue, delivery, outputs, report, checkpoint }) {
  const repoSlug = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+$/.exec(issue.url)?.[1];
  const origin = git(cwd, ["remote", "get-url", "--push", "origin"]);
  const originSlug = /(?:^|[@/])github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin)?.[1];
  if (!repoSlug || originSlug?.toLowerCase() !== repoSlug.toLowerCase()) {
    return { error: "O destino de push de origin precisa corresponder ao repositório da issue selecionada." };
  }
  if (!delivery.from) return { error: "O ciclo precisa partir de um commit local identificável." };

  const current = () => git(cwd, ["branch", "--show-current"]);
  const lines = [];
  let verified;
  let checksFailed = false;
  const onLine = (raw) => {
    const line = redact(raw);
    if (line.startsWith("SDD_DELIVERY_BRANCH ")) {
      delivery.branch = line.slice("SDD_DELIVERY_BRANCH ".length);
      checkpoint();
      return;
    }
    if (line.startsWith("SDD_DELIVERY_VERIFIED ")) {
      try { verified = JSON.parse(line.slice("SDD_DELIVERY_VERIFIED ".length)); } catch { /* sem confirmação */ }
      if (verified) report("info", `Commit ${verified.commit} confirmado em origin/${verified.branch}`);
      return;
    }
    if (line === "SDD_DELIVERY_CHECKS_FAILED") {
      checksFailed = true;
      return;
    }
    if (!line.trim()) return;
    lines.push(line);
    report(/^[❌⛔⚠]/u.test(line) ? "warn" : "info", line);
  };
  const env = { ...process.env, GH_REPO: repoSlug, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  const args = ["--run", "--repo", cwd, "--repo-slug", repoSlug, "--issue", String(issue.number),
    "--context-file", "-", "--delivery-from", delivery.from, "--fail-on-issue", "--fail-on-ci",
    "--commit-msg", `feat: ${issue.title.replace(/\s+/g, " ").slice(0, 100)}`];
  if (delivery.branch) args.push("--resume-branch", delivery.branch);
  const exitCode = await runHook(path.join(root, "hooks", "shipper.py"), args, {
    plan: outputs.planner, summary: outputs.builder, review: outputs.reviewer,
  }, { cwd, env, onLine });
  const details = lines.slice(-32).join("\n").slice(-8000);
  if (exitCode !== 0 || !verified || verified.branch !== current() || verified.commit !== git(cwd, ["rev-parse", "--verify", "HEAD"])) {
    return { error: `Hook shipper terminou com código ${exitCode ?? "indisponível"}.\n${details}`, verified,
      repairCode: checksFailed };
  }
  return { verified, details };
}
