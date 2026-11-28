const $ = (id) => document.getElementById(id);
function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children.filter((child) => child != null));
  return node;
}

const names = {
  running: "Em execução", completed: "Concluído", queued: "Na fila", waiting: "Aguardando", failed: "Falhou",
  cancelled: "Cancelado", cancelling: "Cancelando", pending: "Na fila", in_progress: "Em execução",
};
const number = new Intl.NumberFormat("pt-BR");
const usd = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 6 });
const clock = new Intl.DateTimeFormat("pt-BR", { timeStyle: "medium" });
const fragment = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment)) {
  sessionStorage.setItem("tmr-token", fragment);
  history.replaceState(null, "", location.pathname);
}
const token = sessionStorage.getItem("tmr-token") ?? "";
let runs = [];
let revision = -1;
let selectedId;
let view = "overview";
let filter = "all";
let live = true;
let frozenLogs = [];
let online = false;
let stepId;
let sending = false;
const prompt = $("prompt");
const form = $("prompt-form");
const selected = () => runs.find(({ id }) => id === selectedId) ?? runs[0];
const active = () => runs.find(({ status }) => ["running", "cancelling"].includes(status));
const pill = (status, title = names[status] ?? status) => element("span", { class: `pill ${status}` }, title);
const empty = (text) => element("li", { class: "empty" }, text);

async function api(route, data) {
  const headers = { "X-TMR-Token": token };
  const options = { headers };
  if (data) {
    headers["Content-Type"] = "application/json";
    Object.assign(options, { method: "POST", body: JSON.stringify(data) });
  }
  const response = await fetch(route, options);
  const content = await response.json();
  if (!response.ok) throw new Error(content.error);
  return content;
}

function notice(text) {
  $("notice").hidden = !text;
  $("notice").textContent = text ?? "";
}

function issueNumber(run) {
  if (!run.issue) return run.id.slice(0, 8);
  return typeof run.issue.number === "number" ? `#${run.issue.number}` : run.issue.number;
}

function duration(run) {
  if (!run.startedAt) return run.duration;
  const seconds = Math.floor(((run.endedAt ?? Date.now()) - run.startedAt) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, "0")).join(":");
}

function renderRuns(run) {
  const rows = runs;
  $("process-count").textContent = rows.length;
  $("run-rows").replaceChildren(...rows.map((item) => {
    const agent = item.stages?.find(({ status }) => ["running", "waiting"].includes(status))?.role ?? item.agent ?? item.harness ?? "ACP";
    const title = element("button", { class: "row-title", type: "button", "aria-pressed": item.id === run?.id }, item.issue?.title ?? "Configurando execução");
    return element("tr", { "data-run": item.id, class: item.id === run?.id ? "current" : "" },
      element("td", {}, element("span", { class: "row-label" }, issueNumber(item)), title),
      element("td", { class: "agent-name" }, `♧  ${agent}`),
      element("td", {}, pill(item.status)),
      element("td", { class: "mono muted" }, element("span", { "data-time": item.id }, duration(item))),
      element("td", { class: "row-arrow", "aria-hidden": "true" }, "›"));
  }));
  $("cancel").disabled = !run || run.id !== active()?.id || run.status !== "running" || !online;
  $("stop-phase").disabled = !run || run.id !== active()?.id || !run.steering || !online;
}

function renderLogs(run) {
  const rows = $("log-rows");
  const atEnd = rows.scrollHeight - rows.scrollTop - rows.clientHeight < 48;
  const source = live ? run?.logs ?? [] : frozenLogs;
  const items = source.filter(({ level }) => filter === "all" || filter === level);
  rows.replaceChildren(...(items.length ? items.map((log) => element("li", {},
    element("time", {}, clock.format(log.time)),
    element("span", { class: `log-level ${log.level}` }, { info: "INFO", tool: "TOOL", warn: "AVISO", file: "ARQ" }[log.level]),
    element("span", { class: "log-role" }, log.role ?? "ACP"),
    element("span", { class: "log-text" }, log.text))) : [empty("Nenhum evento para exibir.")]));
  if (live && atEnd && runs.length) rows.scrollTop = rows.scrollHeight;
  $("log-count").textContent = `${items.length} eventos`;
  $("log-footer").textContent = run ? `▣ sessão ${run.id.slice(0, 8)} · ${run.harness ?? "ACP"}` : "Aguardando execução";
  $("download").disabled = !source.length;
}

function sideItem(icon, title, detail, status, caption) {
  return element("li", {}, element("span", { class: "tile", "aria-hidden": "true" }, icon),
    element("div", {}, element("strong", {}, title), element("small", {}, detail ?? "")), pill(status, caption));
}

function renderDetails(run = {}) {
  const issue = run.issue;
  const stages = run.stages ?? [];
  $("issue-status").replaceChildren(...(run.status ? [pill(run.status)] : []));
  if (issue) {
    const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(issue.url) ? issue.url : null;
    const progress = run.progress ?? (stages.length ? Math.round(100 * stages.filter(({ status }) => status === "completed").length / stages.length) : 0);
    $("issue").replaceChildren(
      url ? element("a", { href: url, target: "_blank", rel: "noopener", class: "row-label" }, `⟐  ${issueNumber(run)}`) : element("span", { class: "row-label" }, `⟐  ${issueNumber(run)}`),
      element("h4", {}, issue.title), element("p", { class: "issue-body", title: issue.body }, issue.body ?? ""),
      element("div", { class: "progress-label" }, "Progresso da execução", element("b", {}, `${progress}%`)),
      element("progress", { value: progress, max: 100, "aria-label": "Progresso da execução" }));
  } else {
    $("issue").replaceChildren(element("p", { class: "empty" }, "A issue aparece após a configuração."));
  }

  const metric = (title, value, detail, accent = "") => element("div", { class: "metric" },
    element("p", {}, title), element("b", { class: accent }, value), element("span", { class: "mono muted" }, detail));
  const context = run.contextUsed == null ? "Entrada e saída" :
    `Contexto da fase · ${number.format(run.contextUsed)}${run.contextSize ? ` de ${number.format(run.contextSize)}` : ""}`;
  const costDetail = run.cost == null ? (run.status === "running" ? "Aguardando dados de custo" : "Sem dados de custo") :
    [run.costEstimated ? "Estimativa por tokens" : "Informado pelo harness", run.costPartial ? "total parcial" : null].filter(Boolean).join(" · ");
  $("metrics").replaceChildren(
    metric("♯ Tokens na sessão", number.format(run.tokens ?? 0), context),
    metric("◎ Custo acumulado", run.cost == null ? "—" : `US$ ${usd.format(run.cost)}`, costDetail, "accent"));
  $("agent-count").textContent = stages.length;
  $("agents").replaceChildren(...(stages.length ? stages.map((stage) => sideItem("♧", stage.role, stage.model, stage.status)) : [empty("Nenhum agente nesta execução.")]));
  const activity = [
    ...(run.skills ?? []).map((name) => sideItem("ϟ", name, "Skill", "completed", "Carregada")),
    ...(run.hooks ?? []).map((name) => sideItem("▣", name, "Hook", "observed", "Acionado")),
  ];
  $("activity").replaceChildren(...(activity.length ? activity : [empty("Nenhuma skill ou hook registrado nesta execução.")]));
}

function render() {
  const run = selected();
  renderRuns(run);
  renderLogs(run);
  renderDetails(run);
  const running = active();
  const pending = running?.prompts?.[0];
  $("start").disabled = !online || running?.status === "cancelling";
  $("start").textContent = pending ? "Responder à etapa" : running ? "Ver execução ativa" : "＋ Nova execução";
  $("steer").hidden = !online || !running?.steering || !!pending || running.id !== run?.id;
  if (pending?.id !== stepId) {
    if (prompt.open && prompt.dataset.kind === "workflow") prompt.close();
    stepId = pending?.id;
    if (pending) showPrompt(running, pending);
  }
}

function changeSelection(id) {
  if (id === selectedId) return;
  selectedId = id;
  frozenLogs = (selected()?.logs ?? []).map((item) => ({ ...item }));
  render();
}

function openDialog(title, body, actions, onSubmit, kind) {
  if (prompt.open) prompt.close();
  prompt.dataset.kind = kind;
  const header = element("div", { class: "dialog-header" }, element("h2", { id: "prompt-title" }, title),
    element("button", { type: "button", class: "icon-btn", "aria-label": "Fechar" }, "×"));
  header.querySelector("button").onclick = () => prompt.close();
  const error = element("p", { role: "alert", class: "muted" });
  form.replaceChildren(header, element("div", { class: "dialog-body" }, ...body, error), element("div", { class: "dialog-actions" }, ...actions));
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (sending) return;
    sending = true;
    actions.forEach((button) => { button.disabled = true; });
    try {
      await onSubmit(event.submitter);
      if (prompt.open && form.contains(header)) prompt.close();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      sending = false;
      actions.forEach((button) => { button.disabled = false; });
    }
  };
  prompt.setAttribute("aria-labelledby", "prompt-title");
  if ($("preferences").open) $("preferences").close();
  prompt.showModal();
}

function showPrompt(run, step) {
  const body = step.hint ? [element("p", { class: "muted" }, step.hint)] : [];
  const proceed = element("button", { class: "primary", value: "yes" }, step.kind === "confirm" ? "Confirmar" : "Continuar");
  const actions = [proceed];
  let read = () => true;
  if (step.kind === "confirm") {
    const no = element("button", { class: "secondary", value: "no" }, "Não");
    (step.defaultValue ? proceed : no).setAttribute("autofocus", "");
    actions.unshift(no);
    read = (button) => button?.value === "yes";
  }
  if (step.kind === "text") {
    const field = element("input", { "aria-label": step.title, maxlength: 12000, autofocus: "" });
    field.required = !!step.required;
    body.push(field);
    read = () => field.value.trim();
  }
  if (step.kind === "select") {
    const options = element("select", { "aria-label": step.title, autofocus: "" }, ...step.options.map((label, index) => element("option", { value: index }, label)));
    options.selectedIndex = step.defaultIndex;
    body.push(options);
    read = () => options.selectedIndex;
  }
  if (step.kind === "review") {
    body.push(element("pre", { tabindex: "0" }, step.output || "Nenhum texto retornado pelo agente."));
    const local = step.suggestions?.local ?? [];
    if (local.length) body.push(element("p", { class: "muted" }, `Skills locais · ${local.map(({ name }) => name).join(", ")}`));
    const remote = step.suggestions?.remote ?? [];
    const checks = remote.map(() => element("input", { type: "checkbox" }));
    if (remote.length) {
      body.push(element("p", {}, "Selecione skills para auditar e instalar."));
      remote.forEach((skill, index) => body.push(element("label", { class: "setting" }, checks[index], ` ${skill.name} · ${skill.source}`)));
    }
    const feedback = element("textarea", { "aria-label": "Feedback", placeholder: "Deixe observações ou continue sem feedback", maxlength: 12000 });
    body.push(feedback);
    read = () => ({ text: feedback.value.trim(), skills: checks.flatMap((check, index) => check.checked ? [index] : []) });
  }
  openDialog(step.title, body, actions, (button) => api("/api/answer", { runId: run.id, id: step.id, value: read(button) }), "workflow");
}

$("start").onclick = async () => {
  try {
    const running = active();
    if (running) {
      changeSelection(running.id);
      if (running.prompts[0]) showPrompt(running, running.prompts[0]);
      return;
    }
    $("start").disabled = true;
    selectedId = (await api("/api/runs", {})).id;
    await poll();
  } catch (error) {
    notice(error.message);
    render();
  }
};
$("cancel").onclick = () => {
  const run = selected();
  const stop = element("button", { class: "primary" }, "Encerrar execução");
  openDialog("Cancelar execução?", [element("p", {}, "A sessão ACP será encerrada. Alterações e operações já realizadas ficam no projeto.")],
    [stop], () => api("/api/cancel", { runId: run.id }), "cancel");
};
$("stop-phase").onclick = async () => {
  try {
    $("stop-phase").disabled = true;
    await api("/api/stop-phase", { runId: selected().id });
    await poll();
  } catch (error) { notice(error.message); render(); }
};
$("steer").onsubmit = async (event) => {
  event.preventDefault();
  const message = $("message");
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    await api("/api/steer", { runId: selected().id, value: message.value.trim() });
    message.value = "";
  } catch (error) {
    notice(error.message);
  } finally {
    if (button) button.disabled = false;
  }
};

$("run-rows").onclick = (event) => {
  const row = event.target.closest("[data-run]");
  if (row) changeSelection(row.dataset.run);
};
function navigate(next) {
  view = next;
  document.querySelectorAll("[data-view]").forEach((tab) => {
    tab.classList.toggle("selected", tab.dataset.view === view);
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  $("view-title").textContent = { overview: "Visão geral", processes: "Processos", logs: "Logs" }[view];
  $("subtitle").textContent = {
    overview: "Execuções, logs e telemetria em um só lugar.",
    processes: "Acompanhe as execuções da squad.",
    logs: "Consulte os eventos da execução selecionada.",
  }[view];
  $("processes").hidden = view === "logs";
  $("logs").hidden = view === "processes";
}
document.querySelectorAll("[data-view]").forEach((tab) => { tab.onclick = () => navigate(tab.dataset.view); });
document.querySelector(".brand").onclick = (event) => { event.preventDefault(); navigate("overview"); window.scrollTo(0, 0); };
document.querySelector(".filters").onclick = (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((item) => {
    item.classList.toggle("selected", item === button);
    item.setAttribute("aria-pressed", item === button);
  });
  renderLogs(selected());
};
$("live").onclick = () => {
  live = !live;
  if (!live) frozenLogs = (selected()?.logs ?? []).map((item) => ({ ...item }));
  $("live").setAttribute("aria-pressed", live);
  renderLogs(selected());
};
$("download").onclick = () => {
  const run = selected();
  if (!run) return;
  const text = (live ? run?.logs ?? [] : frozenLogs)
    .map((entry) => `[${clock.format(entry.time)}] [${entry.level}] [${entry.role ?? "ACP"}] ${entry.text}`).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  element("a", { href: url, download: `tmr-${run.id}.log` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const canvas = $("wave");
const context = canvas.getContext("2d");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
$("motion").checked = (localStorage.getItem("tmr-reduced-motion") ?? String(motion.matches)) === "true";
$("motion").onchange = () => localStorage.setItem("tmr-reduced-motion", $("motion").checked);
$("settings").onclick = () => $("preferences").showModal();

function draw(time) {
  const { clientWidth: width, clientHeight: height } = canvas;
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  if (context && width && height) {
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const t = $("motion").checked ? 0 : time / 9500;
    for (let line = 0; line < 26; line++) {
      const gradient = context.createLinearGradient(0, 0, width, 0);
      const weight = line % 6 === 0 ? .62 : .19 + line / 240;
      const rgb = line % 6 === 0 ? "247,232,231" : line % 2 ? "201,93,123" : "78,157,115";
      gradient.addColorStop(0, `rgba(${rgb},0)`);
      gradient.addColorStop(.32, `rgba(${rgb},${weight * .58})`);
      gradient.addColorStop(.66, `rgba(${rgb},${weight})`);
      gradient.addColorStop(1, `rgba(${rgb},${weight * .38})`);
      context.strokeStyle = gradient;
      context.beginPath();
      for (let x = 0; x <= width + 4; x += 4) {
        const u = x / width;
        const envelope = .24 + .76 * Math.exp(-((u - .6) ** 2) / .095);
        const phase = line * .19;
        const y = height * .57 + envelope * (Math.sin(u * 18 + phase + t) * 44 + Math.sin(u * 32 - phase * .3 - t) * 18) + (line - 13) * 1.35;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
  }
  setTimeout(() => requestAnimationFrame(draw), $("motion").checked ? 300 : 36);
}

let polling;
async function poll() {
  if (polling) return polling;
  polling = (async () => {
    try {
      const state = await api(`/api/state?since=${revision}`);
      const reconnect = !online;
      online = true;
      if (reconnect) notice("");
      if (state.runs) {
        revision = state.revision;
        runs = state.runs;
        if (runs.length) {
          $("workspace").textContent = "Ambiente local";
          if (!runs.some(({ id }) => id === selectedId)) selectedId = runs[0].id;
        }
        $("project").textContent = state.cwd;
      }
      if (state.runs || reconnect) render();
      for (const item of runs) {
        const cell = document.querySelector(`[data-time="${item.id}"]`);
        if (cell) cell.textContent = duration(item);
      }
    } catch (error) {
      online = false;
      notice(error.message);
      render();
    }
  })();
  try { await polling; } finally { polling = null; }
}

navigate("overview");
render();
requestAnimationFrame(draw);
await poll();
if (online && runs.length === 0) await $("start").onclick();
setInterval(poll, 700);
