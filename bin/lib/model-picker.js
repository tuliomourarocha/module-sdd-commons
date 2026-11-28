import { spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  CLAUDE_ALIASES,
  CLAUDE_DEFAULT_MODELS,
  CODEX_DEFAULT_MODELS,
  CODEX_MODELS,
  DEFAULT_VARIANTS,
  MODEL_INFO,
  OPENCODE_DEFAULT_FALLBACK,
  QUOTA_COST,
  ROLE_INFO,
  ROLE_ORDER,
  ROLE_WEIGHTS,
  VARIANT_ORDER,
} from "./model-catalog.js";

const TOP_MODELS = 8;
const FIT_BONUS = 4;

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function modelKey(id) {
  return String(id)
    .replace(/^[^/]+\//, "")
    .replace(/@.*$/, "")
    .replace(/:[^:]*$/, "");
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// ── Cache de catálogo do OpenCode ───────────────────────────────────────────
// `opencode models` diz quais modelos existem; o cache local (models.json)
// acrescenta preço, contexto, variantes e descrição. Se o cache não existir,
// o catálogo local cobre os modelos recomendados e heurísticas cobrem o resto.

function openCodeCachePath() {
  const base = process.env.XDG_CACHE_HOME
    ? process.env.XDG_CACHE_HOME
    : path.join(os.homedir(), ".cache");
  return path.join(base, "opencode", "models.json");
}

async function loadOpenCodeCache() {
  const cachePath = openCodeCachePath();
  if (!(await fileExists(cachePath))) return null;
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function cacheModel(cache, provider, id) {
  if (!cache || !provider) return null;
  return cache?.[provider]?.models?.[id] ?? null;
}

// ── Heurísticas para modelos sem curadoria ──────────────────────────────────

function heuristicScores(text, meta) {
  let general = 68;
  let coding = 68;
  let instruction = 72;
  let speed = 75;

  if (/astra|opus|ultra|most capable|strongest|flagship|frontier/.test(text)) {
    general += 20;
    coding += 18;
    instruction += 12;
    speed -= 22;
  } else if (/\bpro\b|\bmax\b|\bsol\b|fable|k3\.1|kimi-k3/.test(text)) {
    general += 13;
    coding += 13;
    instruction += 8;
    speed -= 10;
  } else if (/sonnet|terra|workhorse|balanced/.test(text)) {
    general += 9;
    coding += 10;
    instruction += 8;
    speed -= 3;
  } else if (/haiku|luna|flash|mini|nano|lite|lightning|efficient|high-volume|compact/.test(text)) {
    general -= 1;
    coding -= 1;
    instruction += 4;
    speed += 15;
  }

  if (/code|coding|software|agentic|repo/.test(text)) coding += 6;
  if (meta?.reasoning || /reasoning/.test(text)) general += 3;
  if ((meta?.limit?.context ?? 0) >= 1000000) general += 2;

  return {
    general: clamp(general, 30, 99),
    coding: clamp(coding, 30, 99),
    instruction: clamp(instruction, 30, 99),
    speed: clamp(speed, 30, 99),
  };
}

function tagsFor(entry, meta) {
  const text = `${entry.modelKey} ${meta?.name ?? ""} ${meta?.description ?? ""}`;
  return {
    free: Boolean(entry.forceFree || entry.info.free || (entry.input === 0 && entry.output === 0) || /(?:^|-)free(?:$|-)/.test(entry.modelKey)),
    preview: /preview|experimental|alpha|contributor|stealth/i.test(text),
    legacy: /legacy/i.test(meta?.description ?? ""),
    console: entry.provider === "console-openai",
  };
}

function reliabilityFor(entry, meta, tags) {
  let reliability = entry.info.reliability ?? 90;
  if (tags.free) reliability = Math.min(reliability, 65);
  if (tags.preview) reliability = Math.min(reliability, 80);
  if (tags.console) reliability = Math.min(reliability, 55);
  if (tags.legacy) reliability = Math.min(reliability, 50);
  if (meta?.release_date) {
    const age = Date.now() - Date.parse(meta.release_date);
    if (Number.isFinite(age) && age > 1000 * 60 * 60 * 24 * 365 * 1.5) reliability = Math.min(reliability, 85);
  }
  return reliability;
}

// ── Construção de uma opção de modelo ───────────────────────────────────────

function buildEntry({ id, modelValue, provider, underlying, cache, label, note, forceFree, configNote }) {
  const key = underlying ?? modelKey(id);
  const normalizedKey = modelKey(id).replace(/-(free|preview|contributor)$/, "");
  const info = MODEL_INFO[key] ?? MODEL_INFO[modelKey(id)] ?? MODEL_INFO[normalizedKey] ?? {};
  const providerId = id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
  const meta = cacheModel(cache, provider, providerId) ?? cacheModel(cache, provider, key) ?? cacheModel(cache, provider, modelKey(id));

  const input = meta?.cost?.input ?? info.input ?? null;
  const output = meta?.cost?.output ?? info.output ?? null;
  const context = meta?.limit?.context ?? info.context ?? null;
  const effort = meta?.reasoning_options?.find((option) => option.type === "effort")?.values;
  const variants = effort ?? info.variants ?? DEFAULT_VARIANTS[key] ?? [];

  const entry = {
    id,
    modelValue,
    provider,
    underlying: underlying ?? null,
    modelKey: key,
    label: label ?? meta?.name ?? info.label ?? modelKey(id),
    note: note ?? configNote ?? "",
    input,
    output,
    cacheRead: meta?.cost?.cache_read ?? info.cacheRead ?? null,
    cacheWrite: meta?.cost?.cache_write ?? info.cacheWrite ?? null,
    context,
    variants,
    info,
    forceFree: Boolean(forceFree),
  };

  const text = `${id} ${entry.label} ${meta?.description ?? ""}`.toLowerCase();
  const heuristic = heuristicScores(text, meta);
  entry.general = info.general ?? heuristic.general;
  entry.coding = info.coding ?? heuristic.coding;
  entry.instruction = info.instruction ?? heuristic.instruction;
  entry.speed = info.speed ?? heuristic.speed;
  entry.tags = tagsFor(entry, meta);
  entry.reliability = reliabilityFor(entry, meta, entry.tags);
  return entry;
}

// ── Disponibilidade por harness ────────────────────────────────────────────

function listOpenCodeModelIds() {
  const result = spawnSync("opencode", ["models"], {
    encoding: "utf8",
    timeout: 20000,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) return null;
  const lines = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/[\w./:@-]+$/.test(line) && !line.includes(" "));
  return lines.length > 0 ? [...new Set(lines)] : null;
}

async function buildOpenCodePool(cache, availableIds) {
  const fromCli = availableIds?.length ? availableIds : listOpenCodeModelIds();
  const ids = fromCli ?? [];
  if (ids.length === 0 && cache) {
    for (const provider of ["opencode-go", "opencode"]) {
      for (const id of Object.keys(cache?.[provider]?.models ?? {})) {
        ids.push(`${provider}/${id}`);
      }
    }
  }
  if (ids.length === 0) {
    for (const { model } of Object.values(OPENCODE_DEFAULT_FALLBACK)) {
      if (!ids.includes(model)) ids.push(model);
    }
  }

  const pool = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const provider = id.split("/")[0];
    pool.push(buildEntry({ id, modelValue: id, provider, cache }));
  }
  return pool;
}

async function buildClaudePool(cache) {
  const pool = CLAUDE_ALIASES.map((alias) =>
    buildEntry({
      id: alias.id,
      modelValue: alias.id,
      provider: "anthropic",
      underlying: alias.underlying,
      cache,
      label: alias.label,
      note: alias.note,
    }),
  );
  const configured = process.env.ANTHROPIC_MODEL;
  if (configured && !pool.some((entry) => entry.modelValue === configured)) {
    pool.push(buildEntry({ id: configured, modelValue: configured, provider: "anthropic", cache, note: "configurado no ambiente" }));
  }
  return pool;
}

async function readCodexConfigModel() {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  if (!(await fileExists(configPath))) return null;
  try {
    const content = await readFile(configPath, "utf8");
    return content.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function buildCodexPool(cache, availableIds) {
  const ids = new Set(availableIds?.length ? availableIds : CODEX_MODELS);
  const configured = (await readCodexConfigModel()) ?? process.env.CODEX_MODEL ?? process.env.OPENAI_MODEL;
  if (configured) ids.add(configured);

  // Modelos de chat/reasoning atuais do catálogo OpenAI que o cache conhece.
  // Modelos de imagem/embedding/realtime e variantes datadas ficam de fora.
  for (const [id, meta] of Object.entries(cache?.openai?.models ?? {})) {
    if (!meta?.reasoning || (meta?.limit?.context ?? 0) < 200000) continue;
    if (!/^gpt-|^o[134]/.test(id)) continue;
    if (/embedding|image|realtime|audio|moderation|tts|whisper|search|daybreak|chat-latest/.test(id)) continue;
    if (/-\d{8}$/.test(id)) continue;
    if (/legacy/i.test(meta?.description ?? "")) continue;
    ids.add(id);
  }

  return [...ids].map((id) =>
    buildEntry({
      id,
      modelValue: id,
      provider: "openai",
      cache,
      note: id === configured ? "config atual" : "",
    }),
  );
}

export async function loadModelPools(platforms, availableIds) {
  const cache = await loadOpenCodeCache();
  const pools = {};
  for (const platform of platforms) {
    if (platform === "opencode") pools.opencode = await buildOpenCodePool(cache, availableIds);
    if (platform === "claude") pools.claude = await buildClaudePool(cache);
    if (platform === "codex") pools.codex = await buildCodexPool(cache, availableIds);
  }
  return pools;
}

export async function modelPricing(platform, modelValue) {
  const id = modelValue.replace(/\[.*\]$/, "");
  const provider = platform === "codex" ? "openai" : id.split("/")[0];
  const cache = await loadOpenCodeCache();
  return buildEntry({ id, modelValue, provider, cache });
}

// ── Ranking por papel ──────────────────────────────────────────────────────

function costScore(entry, platform) {
  if (platform === "opencode") {
    if (entry.tags.free) return 92;
    if (entry.input == null || entry.output == null) return 55;
    // uso de agente é input-heavy: o custo de saída pesa ~3x no orçamento.
    const blended = entry.input + 3 * entry.output;
    return clamp(100 - 40 * Math.log10(1 + blended));
  }
  const quota = QUOTA_COST[entry.modelKey];
  if (quota != null) return clamp(100 - 45 * Math.log10(1 + quota));
  if (entry.input == null || entry.output == null) return 55;
  const blended = entry.input + 3 * entry.output;
  return clamp(100 - 40 * Math.log10(1 + blended));
}

function riskPenalty(entry, role) {
  let penalty = 0;
  if (entry.tags.free) penalty += role === "harness" || role === "shipper" ? 10 : 5;
  if (entry.tags.console) penalty += 8;
  if (entry.tags.preview) penalty += 3;
  if (entry.tags.legacy) penalty += 6;
  return penalty;
}

export function chooseVariant(entry, role, defaultVariant) {
  if (!entry.variants || entry.variants.length === 0) return null;
  const preferred = defaultVariant ?? ROLE_INFO[role]?.variant ?? "medium";
  if (entry.variants.includes(preferred)) return preferred;
  const preferredIndex = VARIANT_ORDER.indexOf(preferred);
  const preferHigher = ["planner", "builder", "reviewer"].includes(role);
  let best = entry.variants[0];
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const variant of entry.variants) {
    const index = VARIANT_ORDER.indexOf(variant);
    const distance = index === -1 ? Number.POSITIVE_INFINITY : Math.abs(index - preferredIndex);
    const betterTie = distance === bestDistance && preferHigher && index > bestIndex;
    if (distance < bestDistance || betterTie) {
      best = variant;
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return best;
}

function isDefaultModel(entry, platform, defaultModel) {
  if (!defaultModel) return false;
  if (platform === "opencode") return entry.modelValue === defaultModel.model;
  return entry.modelValue === defaultModel;
}

export function rankModels(pool, platform, role, defaultModel) {
  const weights = ROLE_WEIGHTS[role];
  return pool
    .map((entry) => {
      const quality =
        weights.general * entry.general +
        weights.coding * entry.coding +
        weights.instruction * entry.instruction +
        weights.speed * entry.speed +
        weights.reliability * entry.reliability;
      const cost = weights.cost * costScore(entry, platform);
      const fit = isDefaultModel(entry, platform, defaultModel) ? FIT_BONUS : 0;
      return {
        ...entry,
        score: Number((quality + cost + fit - riskPenalty(entry, role)).toFixed(2)),
        isDefault: isDefaultModel(entry, platform, defaultModel),
      };
    })
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

// ── Defaults (fonte única) ─────────────────────────────────────────────────

function parseFrontmatterValue(content, key) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return frontmatter.match(new RegExp(`^${key}\\s*:\\s*(\\S+)\\s*$`, "m"))?.[1] ?? null;
}

export async function loadDefaults(sourceRoot) {
  const opencode = {};
  for (const role of ROLE_ORDER) {
    const fallback = OPENCODE_DEFAULT_FALLBACK[role];
    opencode[role] = { ...fallback };
    const file = path.join(sourceRoot, "agents", `${role}.agent.md`);
    if (!(await fileExists(file))) continue;
    const content = await readFile(file, "utf8");
    const model = parseFrontmatterValue(content, "model");
    const variant = parseFrontmatterValue(content, "variant");
    if (model) opencode[role] = { model, variant: variant ?? fallback.variant };
  }
  return {
    opencode,
    claude: { ...CLAUDE_DEFAULT_MODELS },
    codex: { ...CODEX_DEFAULT_MODELS },
  };
}

function defaultSelection(platform, role, defaults, ranked) {
  const defaultModel = defaults[platform][role];
  const model = platform === "opencode" ? defaultModel.model : defaultModel;
  const variant = platform === "opencode" ? defaultModel.variant : null;
  const entry = ranked.find((item) => item.modelValue === model);
  return {
    model,
    variant,
    label: entry?.label ?? model,
    recommended: true,
    default: true,
  };
}

function recommendedSelection(platform, role, ranked, defaultVariant) {
  const entry = ranked[0];
  if (!entry) {
    const fallback = OPENCODE_DEFAULT_FALLBACK[role];
    return {
      model: platform === "opencode" ? fallback.model : (ROLE_INFO[role]?.[platform] ?? ""),
      variant: platform === "opencode" ? fallback.variant : null,
      label: "",
      recommended: true,
    };
  }
  return {
    model: entry.modelValue,
    variant: platform === "opencode" ? chooseVariant(entry, role, entry.isDefault ? defaultVariant : null) : null,
    label: entry.label,
    recommended: true,
    default: entry.isDefault,
    score: entry.score,
  };
}

// ── Frontmatter do agente OpenCode ─────────────────────────────────────────

export function setFrontmatterModel(content, model, variant) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return content;
  let frontmatter = match[1];

  if (/^model\s*:/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^model\s*:.*$/m, `model: ${model}`);
  } else {
    frontmatter = `model: ${model}\n${frontmatter}`;
  }

  if (variant) {
    if (/^variant\s*:/m.test(frontmatter)) {
      frontmatter = frontmatter.replace(/^variant\s*:.*$/m, `variant: ${variant}`);
    } else {
      frontmatter = `${frontmatter.replace(/\s*$/, "")}\nvariant: ${variant}`;
    }
  } else {
    frontmatter = frontmatter.replace(/^variant\s*:.*(?:\r?\n)?/m, "");
  }

  return `---\n${frontmatter}\n---\n${content.slice(match[0].length)}`;
}

export async function applyOpenCodeSelections(root, selections) {
  if (!selections) return 0;
  let applied = 0;
  for (const role of ROLE_ORDER) {
    const selection = selections[role];
    if (!selection) continue;
    const file = path.join(root, "agents", `${role}.md`);
    if (!(await fileExists(file))) continue;
    const content = await readFile(file, "utf8");
    const updated = setFrontmatterModel(content, selection.model, selection.variant);
    if (updated !== content) {
      await writeFile(file, updated);
      applied += 1;
    }
  }
  return applied;
}

// ── Apresentação ────────────────────────────────────────────────────────────

function useAnsi() {
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  const force = process.env.FORCE_COLOR;
  if (force && force !== "0") return true;
  if (force === "0") return false;
  return Boolean(process.stdout.isTTY);
}

function painter(enabled) {
  const wrap = (code, text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    bold: (text) => wrap("1", text),
    dim: (text) => wrap("2", text),
    cyan: (text) => wrap("1;36", text),
    green: (text) => wrap("1;32", text),
    yellow: (text) => wrap("1;33", text),
    red: (text) => wrap("1;31", text),
  };
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "n/d";
  if (value === 0) return "0";
  const text = value < 1 ? value.toFixed(2) : value.toFixed(value % 1 === 0 ? 0 : 2);
  return text.replace(".", ",");
}

function formatPrice(entry) {
  if (entry.input == null || entry.output == null) return "n/d";
  return `$${formatNumber(entry.input)}/$${formatNumber(entry.output)}`;
}

function formatContext(context) {
  if (!context) return "n/d";
  if (context >= 1000000) return `${(context / 1000000).toFixed(1).replace(".", ",")}M`;
  return `${Math.round(context / 1000)}k`;
}

function entryTags(entry) {
  const tags = [];
  if (entry.tags.free) tags.push("grátis");
  if (entry.tags.console) tags.push("conta OpenAI");
  if (entry.tags.preview) tags.push("preview");
  if (entry.tags.legacy) tags.push("legacy");
  if (entry.note) tags.push(entry.note);
  return tags.join(" · ");
}

function printRoleModels(platform, role, ranked, limit, colors) {
  const info = ROLE_INFO[role];
  const recommended = ranked[0];
  const supportsVariant = platform === "opencode";
  const variant = supportsVariant && recommended
    ? chooseVariant(recommended, role, recommended.isDefault ? info.variant : null)
    : null;
  console.log(
    `\n  ${colors.cyan(`▸ ${info.label}`)} ${colors.dim(`— ${info.purpose}`)}`,
  );
  console.log(
    `    ${colors.green("★ recomendado:")} ${recommended?.modelValue ?? "n/d"}${variant ? colors.dim(` · ${variant}`) : ""}`,
  );

  const rows = ranked.slice(0, Math.min(limit, ranked.length));
  const maxId = Math.min(42, Math.max(12, ...rows.map((entry) => String(entry.modelValue).length)));
  console.log(colors.dim(`       #  ${"modelo".padEnd(maxId)}  ${"preço/M tok".padEnd(17)}  ${"ctx".padEnd(5)}  var      notas`));

  rows.forEach((entry, index) => {
    const isRecommended = index === 0;
    const variantLabel = supportsVariant
      ? (chooseVariant(entry, role, entry.isDefault ? info.variant : null) ?? "-")
      : "-";
    const tags = [isRecommended ? "★ recomendado" : "", entryTags(entry)].filter(Boolean).join(" · ");
    const plain = `    ${isRecommended ? "★" : " "} ${String(index + 1).padStart(2)}  ${String(entry.modelValue).padEnd(maxId)}  ${formatPrice(entry).padEnd(17)}  ${formatContext(entry.context).padEnd(5)}  ${variantLabel.padEnd(7)}  ${tags}`;
    console.log(isRecommended ? colors.green(plain) : plain);
  });

  if (ranked.length > rows.length) {
    console.log(colors.dim(`    … +${ranked.length - rows.length} modelos disponíveis (t = ver todos)`));
  }
}

function printPlatformHeader(platform, pool, colors) {
  const names = { opencode: "OpenCode", claude: "Claude Code", codex: "Codex" };
  console.log(`\n${colors.cyan(`== Modelos por agente — ${names[platform] ?? platform} ==`)}`);
  console.log(
    colors.dim(
      platform === "opencode"
        ? `${pool.length} modelos OpenCode disponíveis. Preço/contexto do catálogo do harness; ★ = recomendação da squad.`
        : platform === "claude"
          ? "Aliases resolvidos pela conta Claude; preços de referência da API, no plano o que pesa é a cota."
          : `${pool.length} modelos OpenAI conhecidos; o Codex também aceita o modelo configurado na sua conta. Preços de referência da API.`,
    ),
  );
  console.log(colors.dim("Ordem = qualidade × custo-benefício para o papel. Enter aceita o recomendado; você pode escolher outro."));
}

function printFinalSummary(platform, selections, colors) {
  const names = { opencode: "OpenCode", claude: "Claude Code", codex: "Codex" };
  console.log(`\n  ${colors.cyan(`Modelos escolhidos — ${names[platform] ?? platform}`)}`);
  for (const role of ROLE_ORDER) {
    const selection = selections[role];
    if (!selection) continue;
    const variant = selection.variant ? colors.dim(` · ${selection.variant}`) : "";
    const mark = selection.recommended ? colors.green("★") : " ";
    console.log(`    ${mark} ${ROLE_INFO[role].label.padEnd(11)} ${selection.model}${variant}`);
  }
}

// ── Interação ──────────────────────────────────────────────────────────────

function normalize(answer) {
  return String(answer ?? "").trim();
}

function findEntry(ranked, answer) {
  const value = answer.toLowerCase();
  return ranked.find(
    (entry) =>
      entry.modelValue.toLowerCase() === value ||
      entry.id.toLowerCase() === value ||
      entry.label.toLowerCase() === value ||
      entry.modelKey.toLowerCase() === value,
  );
}

async function ask(rl, prompt) {
  try {
    return normalize(await rl.question(prompt));
  } catch {
    return "";
  }
}

async function platformPrompt(rl, platform, ranked, defaults, colors) {
  const name = { opencode: "OpenCode", claude: "Claude Code", codex: "Codex" }[platform] ?? platform;
  let showAll = false;
  for (const role of ROLE_ORDER) {
    printRoleModels(platform, role, ranked[role], showAll ? ranked[role].length : TOP_MODELS, colors);
  }

  for (;;) {
    const answer = await ask(
      rl,
      `\n  Aceitar os recomendados para ${name}? [Enter = sim, r = revisar agente por agente, t = ver todos] `,
    );
    if (answer === "" || /^(s|sim|y|yes)$/i.test(answer)) {
      return Object.fromEntries(ROLE_ORDER.map((role) => [role, recommendedSelection(platform, role, ranked[role], defaults[platform][role]?.variant)]));
    }
    if (/^t|todos$/i.test(answer)) {
      showAll = true;
      for (const role of ROLE_ORDER) printRoleModels(platform, role, ranked[role], ranked[role].length, colors);
      continue;
    }
    if (/^r|revisar$/i.test(answer)) {
      return reviewRoles(rl, platform, ranked, defaults, colors);
    }
    console.log(colors.yellow("  Responda Enter, r ou t."));
  }
}

async function reviewRoles(rl, platform, ranked, defaults, colors) {
  const selections = {};
  for (let index = 0; index < ROLE_ORDER.length; index += 1) {
    const role = ROLE_ORDER[index];
    let displayed = ranked[role].slice(0, TOP_MODELS);
    console.log("");
    printRoleModels(platform, role, displayed, displayed.length, colors);

    for (;;) {
      const answer = await ask(
        rl,
        `  Escolha para ${ROLE_INFO[role].label} [Enter = ★, nº, t = todos, a = aceitar restantes, s = pular]: `,
      );

      if (answer === "" || /^(s|pular)$/i.test(answer)) {
        selections[role] = recommendedSelection(platform, role, ranked[role], defaults[platform][role]?.variant);
        break;
      }
      if (/^(a|aceitar)$/i.test(answer)) {
        for (const remaining of ROLE_ORDER.slice(index)) {
          selections[remaining] = recommendedSelection(platform, remaining, ranked[remaining], defaults[platform][remaining]?.variant);
        }
        return selections;
      }
      if (/^t|todos$/i.test(answer)) {
        displayed = ranked[role];
        printRoleModels(platform, role, displayed, displayed.length, colors);
        continue;
      }

      const number = Number.parseInt(answer, 10);
      if (String(number) === answer && number >= 1 && number <= displayed.length) {
        const entry = displayed[number - 1];
        selections[role] = {
          model: entry.modelValue,
          variant: platform === "opencode" ? chooseVariant(entry, role, entry.isDefault ? defaults.opencode[role]?.variant : null) : null,
          label: entry.label,
          recommended: entry.isDefault || number === 1,
          default: entry.isDefault,
        };
        break;
      }

      const entry = findEntry(ranked[role], answer);
      if (entry) {
        selections[role] = {
          model: entry.modelValue,
          variant: platform === "opencode" ? chooseVariant(entry, role, entry.isDefault ? defaults.opencode[role]?.variant : null) : null,
          label: entry.label,
          recommended: entry.isDefault,
          default: entry.isDefault,
        };
        break;
      }

      console.log(colors.yellow("  Opção não encontrada. Use o número, o nome exato, t para ver todos ou Enter para o recomendado."));
    }
  }
  return selections;
}

export async function selectModels({ platforms, sourceRoot, dryRun, interactive, colors: colorsEnabled }) {
  const colors = painter(colorsEnabled ?? useAnsi());
  const defaults = await loadDefaults(sourceRoot);

  // Instalação não interativa: nem toca no catálogo do harness. O padrão da
  // squad é determinístico (importante para CI e para o teste do instalador).
  if (!interactive && !dryRun) {
    return Object.fromEntries(
      platforms.map((platform) => [
        platform,
        Object.fromEntries(ROLE_ORDER.map((role) => [role, defaultSelection(platform, role, defaults, [])])),
      ]),
    );
  }

  const pools = await loadModelPools(platforms);
  const selections = {};
  let rl = null;

  try {
    for (const platform of platforms) {
      const ranked = Object.fromEntries(
        ROLE_ORDER.map((role) => [role, rankModels(pools[platform] ?? [], platform, role, defaults[platform][role])]),
      );

      if (interactive && !dryRun) {
        if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
        printPlatformHeader(platform, pools[platform] ?? [], colors);
        selections[platform] = await platformPrompt(rl, platform, ranked, defaults, colors);
        printFinalSummary(platform, selections[platform], colors);
      } else {
        selections[platform] = Object.fromEntries(
          ROLE_ORDER.map((role) => [role, defaultSelection(platform, role, defaults, ranked[role])]),
        );
        if (dryRun) {
          printPlatformHeader(platform, pools[platform] ?? [], colors);
          for (const role of ROLE_ORDER) printRoleModels(platform, role, ranked[role], TOP_MODELS, colors);
          printFinalSummary(platform, selections[platform], colors);
        }
      }
    }
  } finally {
    rl?.close();
  }

  return selections;
}
