import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("instala adaptadores com os provedores esperados", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "sdd-harness-test-"));
  await run(process.execPath, ["bin/sdd-harness.js", "--all", "--target", target], { cwd: projectRoot });
  const openCodeHarness = await readFile(path.join(target, ".opencode", "agents", "harness.md"), "utf8");
  const claudeHarness = await readFile(path.join(target, ".claude", "agents", "harness.md"), "utf8");
  const codexRouting = JSON.parse(await readFile(path.join(target, ".codex", "sdd-harness.json"), "utf8"));

  assert.match(openCodeHarness, /model: opencode\/muse-spark-1\.2-contributor-free/);
  assert.match(claudeHarness, /model: haiku/);
  assert.deepEqual(codexRouting.roleModels, {
    harness: "gpt-5.6-luna", planner: "gpt-5.6-sol", builder: "gpt-5.6-sol",
    checker: "gpt-5.6-luna", reviewer: "gpt-5.6-terra", shipper: "gpt-5.6-terra",
  });
  assert.equal((await stat(path.join(target, ".codex", "skills", "sdd-harness", "SKILL.md"))).isFile(), true);
  // 6 macros originais + supervisor (hook final)
  assert.equal((await readdir(path.join(target, ".codex", "roles"))).length, 7);
  // valida hooks determinísticos instalados
  assert.equal((await stat(path.join(target, ".opencode", "plugins", "guard-rails.ts"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "plugins", "supervisor.ts"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "hooks", "guard_rails.py"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "hooks", "supervisor.py"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".claude", "settings.json"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".claude", "hooks", "guard_rails.py"))).isFile(), true);
});
