import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

const pending = new Map();
let currentRole = null;
let steering = null;
let stopPhase = null;
let resolveResume;
const resumePromise = new Promise((resolve) => { resolveResume = resolve; });

export const send = (message) => { if (process.connected) process.send(message); };
export const role = () => currentRole;
export const setRole = (value) => { currentRole = value; };
export function log(level, text, append = false) {
  if (text) send({ type: "log", level, text: stripVTControlCharacters(text), role: currentRole, append });
}

export function connect() {
  console.log = (...args) => log("info", args.map(String).join(" "));
  console.error = (...args) => log("warn", args.map(String).join(" "));
  process.on("message", ({ type, id, value, data }) => {
    if (type === "resume") resolveResume(data ?? null);
    if (type === "answer" && pending.has(id)) {
      pending.get(id)(value);
      pending.delete(id);
      send({ type: "answered", id });
    }
    if (type === "steer" && pending.size === 0) steering?.(value);
    if (type === "stop-phase" && stopPhase) {
      for (const [promptId, resolve] of pending) {
        resolve(false);
        send({ type: "answered", id: promptId });
      }
      pending.clear();
      stopPhase();
    }
  });
  process.on("disconnect", () => process.exit(process.exitCode ?? 0));
}

function prompt(kind, title, data = {}) {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ type: "prompt", prompt: { id, kind, title, ...data } });
  });
}

export const ask = (title, data) => prompt("text", title, data);
export const confirm = (title, defaultValue, hint) => prompt("confirm", title, { defaultValue: defaultValue === "s", hint });
export const select = (title, options, defaultIndex) => prompt("select", title, { options, defaultIndex: defaultIndex - 1 });
export const review = (title, output, suggestions) => prompt("review", title, { output, suggestions });
export function setSteering(callback) {
  steering = callback;
  send({ type: "state", data: { steering: !!callback } });
}
export function setStopPhase(callback) { stopPhase = callback; }
export function receiveResume() { return resumePromise; }
