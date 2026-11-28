import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("não reinstala executável presente que falha ao iniciar", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sdd-deps-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "opencode"), "#!/bin/sh\necho 'Permission denied: log' >&2\nexit 1\n", { mode: 0o700 });
  const script = fileURLToPath(new URL("../skills/acp-client/scripts/ensure_deps.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--only", "opencode", "--json"], {
    env: { ...process.env, PATH: dir }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /existe no PATH, mas não iniciou: Permission denied: log/);
  assert.doesNotMatch(result.stderr, /instalando/);
  assert.equal(JSON.parse(result.stdout)[0].action, "falhou");
});
