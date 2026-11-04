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
  const claudeHarness = await readFile(path.join(target, ".claude", "agents", "harness.md"), "utf8");
  const codexRouting = JSON.parse(await readFile(path.join(target, ".codex", "sdd-harness.json"), "utf8"));

  // OpenCode: todos os macros no plano OpenCode Go, `variant` em chave própria — com
  // chaves legadas no frontmatter o OpenCode descarta o sufixo inline `modelo#variante`
  // e o subagente herda o modelo do pai (opencode#50849). Nada de `console-openai/*`
  // (cobra crédito da organização OpenAI) nem do tier free `opencode/*` — o big-pickle
  // foi testado para o harness e a cota free esgota no meio do ciclo, travando o único
  // papel que inicia tudo (verificado em 04/11/2026: "Free usage limit reached").
  const openCodeModels = {
    harness: ["opencode-go/gpt-6-luna", "low"],
    planner: ["opencode-go/glm-5.3-flash", "high"],
    builder: ["opencode-go/claude-haiku-5-5", "medium"],
    reviewer: ["opencode-go/claude-haiku-5-5", "high"],
    shipper: ["opencode-go/gpt-6-luna", "medium"],
    supervisor: ["opencode-go/glm-5.3-flash", "low"],
  };
  for (const [role, [model, variant]] of Object.entries(openCodeModels)) {
    const content = await readFile(path.join(target, ".opencode", "agents", `${role}.md`), "utf8");
    // Só o frontmatter interessa — o corpo e os comentários YAML citam a sintaxe
    // `modelo#variante` exatamente para proibi-la, e não devem tripar as guardas.
    const fm = content.split(/^---\s*$/m)[1] ?? "";
    const declared = fm.match(/^model:\s*(\S+)\s*$/m)?.[1];
    const declaredVariant = fm.match(/^variant:\s*(\S+)\s*$/m)?.[1];
    assert.equal(declared, model, `${role} deve declarar ${model}`);
    assert.equal(declaredVariant, variant, `${role} deve usar a variante ${variant}`);
    assert.ok(!declared.includes("#"), `${role} não pode usar sufixo inline #variante`);
    assert.ok(!declared.startsWith("console-openai/"), `${role} não pode depender de crédito OpenAI`);
    assert.ok(!declared.startsWith("opencode/"), `${role} não pode usar o tier free do Zen (cota esgota e trava o ciclo)`);
  }
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
