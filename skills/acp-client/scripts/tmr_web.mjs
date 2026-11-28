import { fork, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assets = {
  "/": ["index.html", "text/html"],
  "/tmr.css": ["tmr.css", "text/css"],
  "/tmr.js": ["tmr.js", "text/javascript"],
};

function validAnswer(prompt, value) {
  const text = (input) => typeof input === "string" && input.length <= 12000;
  switch (prompt.kind) {
    case "text": return text(value) && (!prompt.required || !!value.trim());
    case "confirm": return typeof value === "boolean";
    case "select": return Number.isInteger(value) && value >= 0 && value < prompt.options.length;
    case "review": return value && text(value.text) && Array.isArray(value.skills) &&
      value.skills.every((index) => Number.isInteger(index) && index >= 0 && index < (prompt.suggestions?.remote.length ?? 0));
    default: return false;
  }
}

function stopWorker(worker, signal = "SIGTERM") {
  if (!worker?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-worker.pid, signal);
    else worker.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(error.message);
  }
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("Pedido muito grande.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function serveTmr(argv) {
  const value = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  const cwd = path.resolve(value("--cwd") ?? process.cwd());
  const token = randomBytes(32).toString("hex");
  const runs = [];
  let active = null;
  let sequence = 0;
  let origin;
  let revision = 0;
  let checkpoint = null;

  function append(run, { level, text, role, append }) {
    const last = run.logs.at(-1);
    if (append && last?.streaming && last.role === role && last.text.length < 4000) {
      last.text += text.slice(0, 12000);
    } else {
      run.logs.push({ id: ++sequence, level, text: text.slice(0, 12000), role, streaming: append, time: Date.now() });
      if (run.logs.length > 600) run.logs.shift();
    }
    revision++;
  }

  function start() {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "sdd-tmr-"));
    const run = {
      id: randomUUID(), status: "running", startedAt: Date.now(),
      issue: null, stages: [], prompts: [], logs: [], tools: [], skills: [], hooks: [],
    };
    runs.unshift(run);
    if (runs.length > 12) runs.pop();
    const worker = fork(fileURLToPath(new URL("./acp_orchestrate.mjs", import.meta.url)), argv, {
      cwd, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32",
      env: { ...process.env, SDD_TMR_TMP: scratch },
    });
    worker.send({ type: "resume", data: checkpoint });
    const job = { run, worker, outcome: null, cancelling: false, timer: null };
    active = job;
    revision++;
    for (const [stream, level] of [[worker.stdout, "info"], [worker.stderr, "warn"]]) {
      stream.setEncoding("utf8").on("data", (text) => append(run, { text: text.trim(), level }));
    }
    worker.on("message", (message) => {
      if (job.cancelling) return;
      if (message.type === "log") return append(run, message);
      if (message.type === "state") Object.assign(run, message.data);
      if (message.type === "checkpoint") checkpoint = message.data;
      if (message.type === "clear_checkpoint") checkpoint = null;
      if (message.type === "prompt") run.prompts.push(message.prompt);
      if (message.type === "answered") run.prompts = run.prompts.filter(({ id }) => id !== message.id);
      if (message.type === "finish") job.outcome = message.status;
      revision++;
    });
    worker.on("error", (error) => append(run, { text: error.message, level: "warn" }));
    worker.on("exit", () => stopWorker(worker, "SIGKILL"));
    worker.on("close", () => {
      clearTimeout(job.timer);
      try { rmSync(scratch, { recursive: true, force: true }); }
      catch (error) { append(run, { text: error.message, level: "warn" }); }
      run.status = job.cancelling ? "cancelled" : job.outcome ?? "failed";
      for (const stage of run.stages) {
        if (["running", "waiting"].includes(stage.status)) stage.status = run.status;
      }
      run.endedAt = Date.now();
      run.steering = false;
      run.prompts = [];
      active = null;
      revision++;
    });
    return run;
  }

  const server = createServer(async (request, response) => {
    const json = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(data));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== new URL(origin).host) return json(403, { error: "Endereço inválido." });
    if (!request.url?.startsWith("/")) return json(400, { error: "Endereço inválido." });
    const url = new URL(origin + request.url);
    const route = url.pathname;
    if (request.method === "GET" && Object.hasOwn(assets, route)) {
      const [file, mime] = assets[route];
      try {
        const data = await readFile(new URL(`./web/${file}`, import.meta.url));
        response.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
        return response.end(data);
      } catch {
        return json(500, { error: "Arquivos da interface indisponíveis." });
      }
    }
    if (request.headers["x-tmr-token"] !== token) return json(403, { error: "Abra o link gerado por sdd-acp." });
    if (request.method === "GET" && route === "/api/state") {
      return json(200, url.searchParams.get("since") === String(revision) ? { revision } : { runs, cwd, revision });
    }
    if (request.method !== "POST" || request.headers.origin !== origin) return json(403, { error: "Origem inválida." });

    try {
      const body = await readBody(request);
      if (!body || typeof body !== "object") return json(400, { error: "Pedido inválido." });
      if (route === "/api/runs") {
        if (active) return json(409, { error: "Já há uma execução ativa." });
        return json(201, { id: start().id });
      }
      if (!active || active.cancelling || body.runId !== active.run.id || !active.worker.connected) {
        return json(409, { error: "A execução já foi encerrada." });
      }
      const { run, worker } = active;
      if (route === "/api/cancel") {
        active.cancelling = true;
        run.status = "cancelling";
        run.prompts = [];
        revision++;
        stopWorker(worker);
        active.timer = setTimeout(() => stopWorker(worker, "SIGKILL"), 1500);
      } else if (route === "/api/stop-phase") {
        if (!run.steering) return json(409, { error: "Nenhum agente está em execução." });
        run.steering = false;
        revision++;
        worker.send({ type: "stop-phase" });
      } else if (route === "/api/answer") {
        const prompt = run.prompts[0];
        if (!prompt || prompt.id !== body.id || prompt.sent || !validAnswer(prompt, body.value)) return json(409, { error: "Resposta inválida ou pergunta já respondida." });
        prompt.sent = true;
        worker.send({ type: "answer", id: body.id, value: body.value });
      } else if (route === "/api/steer") {
        if (!run.steering || run.prompts.length || typeof body.value !== "string" || !body.value.trim() || body.value.length > 12000) {
          return json(409, { error: "O agente não está recebendo mensagens agora." });
        }
        worker.send({ type: "steer", value: body.value });
      } else {
        return json(404, { error: "Recurso indisponível." });
      }
      return json(200, {});
    } catch (error) {
      return json(400, { error: error.message });
    }
  });

  const port = Number(value("--port") ?? 0);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/#${token}`;
  console.log(`TMR · Console ACP\n${url}`);
  if (!argv.includes("--no-open")) {
    const command = { darwin: "open", win32: "explorer.exe" }[process.platform] ?? "xdg-open";
    const browser = spawn(command, [url], { stdio: "ignore" });
    browser.on("error", () => console.error("Abra o endereço acima no navegador."));
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      stopWorker(active?.worker, "SIGKILL");
      server.closeAllConnections();
      server.close();
    });
  }
}
