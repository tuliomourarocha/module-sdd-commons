import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deliveryStart, prepareDevelopmentBase, runDelivery } from "../skills/acp-client/scripts/tmr_delivery.mjs";
import { phaseProblem, reviewFailure, settleStage } from "../skills/acp-client/scripts/tmr_recovery.mjs";

const hook = fileURLToPath(new URL("../hooks/shipper.py", import.meta.url));

test("um ciclo novo parte da develop atualizada e para se ela divergir", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sdd-acp-develop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const remote = path.join(dir, "origin.git");
  const project = path.join(dir, "project");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd, message) => git(cwd, "-c", "user.name=Tester", "-c", "user.email=tester@example.com", "commit", "--allow-empty", "-m", message);

  git(dir, "init", "-b", "main", source);
  commit(source, "initial");
  git(source, "switch", "-c", "develop");
  commit(source, "develop inicial");
  git(dir, "clone", "--bare", source, remote);
  git(dir, "clone", "--single-branch", "--branch", "main", remote, project);

  await prepareDevelopmentBase(project);
  assert.equal(git(project, "branch", "--show-current"), "develop");
  assert.equal(deliveryStart(project).from, git(source, "rev-parse", "HEAD"));

  git(project, "switch", "-c", "fix/entrega-anterior");
  commit(project, "entrega anterior");
  const previous = git(project, "rev-parse", "HEAD");
  commit(source, "atualização remota");
  git(source, "push", remote, "develop");
  await prepareDevelopmentBase(project);
  assert.equal(git(project, "branch", "--show-current"), "develop");
  assert.equal(deliveryStart(project).from, git(source, "rev-parse", "HEAD"));
  assert.equal(git(project, "rev-parse", "fix/entrega-anterior"), previous);

  commit(project, "alteração local");
  const local = deliveryStart(project).from;
  commit(source, "alteração remota divergente");
  git(source, "push", remote, "develop");
  await assert.rejects(prepareDevelopmentBase(project), /git pull --ff-only origin develop falhou/);
  assert.equal(deliveryStart(project).from, local);
});

test("nova execução limpa com autorização antes do pull e reinstala após a atualização", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sdd-acp-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const remote = path.join(root, "remote.git");
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (dir, message) => git(dir, "-c", "user.name=Tester", "-c", "user.email=tester@example.com", "commit", "-m", message);

  git(root, "init", "-b", "develop", "upstream");
  const upstream = path.join(root, "upstream");
  await mkdir(path.join(upstream, ".claude"));
  await writeFile(path.join(upstream, ".claude", "CLAUDE.md"), "Configuração versionada\n");
  await writeFile(path.join(upstream, "app.txt"), "base\n");
  git(upstream, "add", "--", ".");
  commit(upstream, "Base");
  git(root, "clone", "--bare", upstream, remote);
  git(root, "clone", remote, cwd);
  git(cwd, "switch", "-c", "anterior");
  await writeFile(path.join(upstream, "app.txt"), "atualizado\n");
  git(upstream, "add", "--", "app.txt");
  commit(upstream, "Atualização");
  git(upstream, "push", remote, "develop");

  await mkdir(path.join(cwd, ".opencode"));
  await writeFile(path.join(cwd, ".opencode", "stale"), "antigo");
  await writeFile(path.join(cwd, ".git", "hooks", "post-merge"), [
    "#!/bin/sh",
    'test ! -e .opencode && echo "ausente no pull" > .git/estado-durante-pull',
    "",
  ].join("\n"), { mode: 0o700 });

  async function runUntilIssue(approve) {
    const script = fileURLToPath(new URL("../skills/acp-client/scripts/acp_orchestrate.mjs", import.meta.url));
    const child = fork(script, ["--agent", "opencode", "--no-ensure"], { cwd, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("O ACP não chegou ao prompt da issue.")), 5000);
        child.on("error", reject);
        child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`ACP saiu com código ${code}`)); });
        child.on("message", (event) => {
          if (event.type !== "prompt") return;
          try {
            const { id, title, defaultValue, hint } = event.prompt;
            if (title.startsWith("Apagar artefatos")) {
              assert.equal(defaultValue, false);
              assert.equal(git(cwd, "branch", "--show-current"), "anterior");
              assert.equal(existsSync(path.join(cwd, ".opencode", "stale")), true);
              assert.match(hint, /\.opencode/);
              assert.doesNotMatch(hint, /\.claude/);
              child.send({ type: "answer", id, value: approve });
            } else {
              assert.equal(title, "Issue do GitHub");
              clearTimeout(timeout);
              resolve();
            }
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
        child.send({ type: "resume", data: null });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
    }
  }

  await runUntilIssue(true);
  assert.equal(await readFile(path.join(cwd, ".git", "estado-durante-pull"), "utf8"), "ausente no pull\n");
  assert.equal(await readFile(path.join(cwd, "app.txt"), "utf8"), "atualizado\n");
  assert.equal(existsSync(path.join(cwd, ".opencode", "stale")), false);
  assert.equal(existsSync(path.join(cwd, ".opencode", "agents", "builder.md")), true);
  assert.equal(await readFile(path.join(cwd, ".claude", "CLAUDE.md"), "utf8"), "Configuração versionada\n");

  git(cwd, "switch", "anterior");
  await writeFile(path.join(cwd, ".opencode", "stale"), "preservar\n");
  await runUntilIssue(false);
  assert.equal(git(cwd, "branch", "--show-current"), "develop");
  assert.equal(await readFile(path.join(cwd, ".opencode", "stale"), "utf8"), "preservar\n");
});

test("o gate do ACP rejeita o hook que saiu com zero sem comprovar commit e push", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "sdd-acp-gate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-b", "develop");
  git("-c", "user.name=Tester", "-c", "user.email=tester@example.com", "commit", "--allow-empty", "-m", "initial");
  git("remote", "add", "origin", "git@github.com:example/project.git");
  await mkdir(path.join(cwd, "hooks"));
  await writeFile(path.join(cwd, "hooks", "shipper.py"), 'print("Nada para enviar")\n');
  const options = {
    root: cwd, cwd, issue: { number: 1, title: "Teste", url: "https://github.com/example/project/issues/1" },
    delivery: deliveryStart(cwd), outputs: {}, report: () => {}, checkpoint: () => {},
  };
  const result = await runDelivery(options);
  assert.equal(result.verified, undefined);
  assert.match(result.error, /código 0.*\nNada para enviar/);
  assert.equal(result.repairCode, false);

  await writeFile(path.join(cwd, "hooks", "shipper.py"), 'print("SDD_DELIVERY_CHECKS_FAILED")\nraise SystemExit(2)\n');
  const failedChecks = await runDelivery(options);
  assert.equal(failedChecks.repairCode, true);
  assert.match(failedChecks.error, /código 2/);
});

test("a entrega preserva o commit após rejeição do push e confirma a branch em origin", { skip: process.platform === "win32", timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sdd-delivery-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "project");
  const origin = path.join(dir, "origin.git");
  const bin = path.join(dir, "bin");
  const planning = path.join(cwd, ".planning");
  await mkdir(bin);
  await mkdir(planning, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "develop");
  git("init", "--bare", origin);
  git("config", "user.email", "tester@example.com");
  git("config", "user.name", "Tester");
  git("remote", "add", "origin", origin);
  await writeFile(path.join(cwd, "app.txt"), "original\n");
  git("add", "app.txt");
  git("commit", "-m", "initial");
  git("push", "-u", "origin", "develop");
  const baseline = git("rev-parse", "HEAD");
  await writeFile(path.join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "auth status") exit 0 ;;
  "pr view") echo '{"number":1,"url":"https://github.com/example/project/pull/1","baseRefName":"develop"}' ;;
  "pr checks")
    if test -f .planning/fail-ci; then
      echo '[{"name":"tests","bucket":"fail"}]'
      exit 1
    fi
    echo '[{"name":"tests","bucket":"pass"}]' ;;
  "issue view") echo '{"number":1,"title":"Entregar","state":"CLOSED"}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  const rejectPush = path.join(origin, "hooks", "pre-receive");
  await writeFile(rejectPush, "#!/bin/sh\necho fixture-push-rejected >&2\nexit 1\n", { mode: 0o700 });
  const ship = (start, ...extra) => spawnSync("python3", [hook, "--run", "--repo", cwd, "--issue", "1",
    "--delivery-from", start, "--context-file", "-", "--fail-on-ci", ...extra], {
    cwd, encoding: "utf8", input: '{"summary":"Entrega em teste"}', timeout: 7000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SDD_GITHUB_PROJECT: "" },
  });
  const clean = ship(baseline);
  assert.equal(clean.status, 2, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /nenhum arquivo ou commit/);
  assert.equal(git("branch", "--show-current"), "develop");

  await writeFile(path.join(cwd, "app.txt"), "implementação\n");
  const first = ship(baseline);
  assert.equal(first.status, 2, first.stdout + first.stderr);
  assert.match(first.stdout, /fixture-push-rejected/);
  assert.doesNotMatch(first.stdout, /SDD_DELIVERY_VERIFIED|Issue GitHub/);
  const branch = git("branch", "--show-current");
  const firstCommit = git("rev-parse", "HEAD");
  assert.notEqual(branch, "develop");
  assert.notEqual(firstCommit, baseline);
  assert.equal(git("ls-remote", "origin", `refs/heads/${branch}`), "");

  await rm(rejectPush);
  await writeFile(path.join(cwd, "fix.txt"), "correção\n");
  await writeFile(path.join(planning, "STATE.md"), "estado local\n");
  git("add", ".planning/STATE.md");
  const failCI = path.join(planning, "fail-ci");
  await writeFile(failCI, "");
  const rejectedCI = ship(baseline, "--resume-branch", branch);
  assert.equal(rejectedCI.status, 2, rejectedCI.stdout + rejectedCI.stderr);
  assert.match(rejectedCI.stdout, /SDD_DELIVERY_VERIFIED/);
  assert.match(rejectedCI.stdout, /SDD_DELIVERY_CHECKS_FAILED/);
  assert.match(rejectedCI.stdout, /CI check \[fail\]/);
  assert.doesNotMatch(rejectedCI.stdout, /GITHUB_SYNC_OK/);
  assert.match(await readFile(path.join(planning, "STATE.md"), "utf8"), /Gate:\*\* `blocked`/);
  const published = git("rev-parse", "HEAD");

  await rm(failCI);
  const retry = ship(baseline, "--resume-branch", branch);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  const head = git("rev-parse", "HEAD");
  assert.equal(head, published);
  assert.equal(git("rev-parse", "HEAD^"), firstCommit);
  assert.equal(git("ls-remote", "origin", `refs/heads/${branch}`), `${head}\trefs/heads/${branch}`);
  assert.match(retry.stdout, /SDD_DELIVERY_VERIFIED/);
  assert.equal(git("ls-tree", "--name-only", "HEAD", "fix.txt", ".planning"), "fix.txt");
  assert.equal(git("rev-parse", "develop"), baseline);
});

test("volta ao builder após rejeição e exige novo parecer para avançar", async () => {
  const requests = [];
  const blocks = [];
  const result = await settleStage({
    run(context) {
      requests.push(context);
      const output = requests.length === 1 ? "app.js:3 separação de camadas\n\n**Veredito: CHANGES_REQUESTED**" : "APPROVED";
      return reviewFailure({ stopReason: "end_turn", output }) ?? { completed: true };
    },
    recover(error, failure) {
      assert.match(error, /app\.js:3/);
      assert.equal(failure.repairCode, true);
      return { ready: true, notes: "builder corrigiu a validação" };
    },
    wait: () => assert.fail("correção disponível"),
    onBlocked: (error) => blocks.push(error),
  });
  assert.deepEqual(result, { completed: true });
  assert.equal(blocks.length, 1);
  assert.match(requests[1], /builder corrigiu/);
});

test("mantém o bloqueio após tentativas e pausa somente por decisão humana", async () => {
  let retries = 0;
  const result = await settleStage({
    run: () => { throw new Error("origin inacessível"); },
    recover: () => { retries++; return { ready: true }; },
    wait: (error) => { assert.equal(error, "origin inacessível"); return false; },
    onBlocked: () => {},
  });
  assert.equal(retries, 2);
  assert.deepEqual(result, { blocked: "origin inacessível" });
  assert.equal(phaseProblem({ stopReason: "end_turn", output: "**BLOQUEIO:** chave SSH indisponível" }), "chave SSH indisponível");
  assert.deepEqual(reviewFailure({ stopReason: "end_turn", output: "BLOQUEIO: credencial indisponível" }),
    { error: "credencial indisponível" });
  assert.match(reviewFailure({ stopReason: "end_turn", output: "Ainda não posso emitir APPROVED." }).error, /sem veredito/);
});
