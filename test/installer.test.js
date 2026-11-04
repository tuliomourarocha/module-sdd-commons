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
  const openCodeBuilder = await readFile(path.join(target, ".opencode", "agents", "builder.md"), "utf8");
  const claudeHarness = await readFile(path.join(target, ".claude", "agents", "harness.md"), "utf8");
  const codexRouting = JSON.parse(await readFile(path.join(target, ".codex", "sdd-harness.json"), "utf8"));

  // OpenCode: modelos OpenAI exclusivos do provedor OpenAI (console-openai);
  // o restante (Anthropic) fica no provedor multimodelo opencode/*.
  // `variant` vai em chave própria — com chaves legadas no frontmatter, o
  // OpenCode descarta o sufixo inline `modelo#variante` (opencode#50849).
  assert.match(openCodeHarness, /model: console-openai\/gpt-6-luna\nvariant: low/);
  assert.doesNotMatch(openCodeHarness, /model: opencode\//);
  assert.doesNotMatch(openCodeHarness, /model: [^\n]*#/);
  // Anthropic no plano pago (opencode-go), nunca no tier free `opencode/*` (cota esgotada)
  assert.match(openCodeBuilder, /model: opencode-go\/claude-haiku-5-5\nvariant: medium/);
  assert.doesNotMatch(openCodeBuilder, /model: opencode\//);
  assert.match(claudeHarness, /model: haiku/);
  assert.deepEqual(codexRouting.roleModels, {
    harness: "gpt-5.6-luna", planner: "gpt-5.6-sol", builder: "gpt-5.6-sol",
    reviewer: "gpt-5.6-terra", shipper: "gpt-5.6-terra",
  });
  assert.equal((await stat(path.join(target, ".codex", "skills", "sdd-harness", "SKILL.md"))).isFile(), true);
  // 5 macros (checker removido) + supervisor (hook final) = 6
  assert.equal((await readdir(path.join(target, ".codex", "roles"))).length, 6);
  // valida hooks determinísticos instalados
  assert.equal((await stat(path.join(target, ".opencode", "plugins", "guard-rails.ts"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "plugins", "shipper.ts"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "plugins", "supervisor.ts"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "hooks", "guard_rails.py"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "hooks", "shipper.py"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".opencode", "hooks", "supervisor.py"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".claude", "settings.json"))).isFile(), true);
  assert.equal((await stat(path.join(target, ".claude", "hooks", "guard_rails.py"))).isFile(), true);
});
