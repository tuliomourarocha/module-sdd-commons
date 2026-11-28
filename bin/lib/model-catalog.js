// ── Catálogo de modelos — recomendação por papel ────────────────────────────
// Metadados de qualidade são uma curadoria local (aproximada) usada apenas para
// ordenar as opções. Preço/contexto/variantes vêm do catálogo do próprio harness
// quando disponível (`opencode models` + cache do OpenCode) e são apenas
// referência: o que vale no plano é a cota/contrato do provedor.
//
// general     — raciocínio geral e análise
// coding      — implementação, edição de repositório e uso de ferramentas
// instruction — seguir procedimento/papel sem desviar
// speed       — latência percebida em ciclos curtos
// reliability — estabilidade de cota e disponibilidade no plano
//
// A ordem final combina esses eixos com o custo (custo-benefício) e um pequeno
// bônus de fit para o modelo que a squad já recomenda por papel.

export const MODEL_INFO = {
  // OpenAI / Codex / OpenCode Go
  "gpt-6-astra": { label: "GPT-6 Astra", general: 99, coding: 98, instruction: 97, speed: 50, reliability: 100, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, context: 1050000 },
  "gpt-6.1-sol": { label: "GPT-6.1 Sol", general: 97, coding: 97, instruction: 96, speed: 78, reliability: 100, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, context: 1050000 },
  "gpt-6.1-terra": { label: "GPT-6.1 Terra", general: 92, coding: 93, instruction: 93, speed: 88, reliability: 100, input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25, context: 1050000 },
  "gpt-6-sol": { label: "GPT-6 Sol", general: 96, coding: 96, instruction: 95, speed: 78, reliability: 100, input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, context: 1050000 },
  "gpt-6-luna": { label: "GPT-6 Luna", general: 82, coding: 80, instruction: 96, speed: 96, reliability: 100, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, context: 1050000, variants: ["none", "low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6-sol": { label: "GPT-5.6 Sol", general: 95, coding: 96, instruction: 94, speed: 75, reliability: 100, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, context: 1050000 },
  "gpt-5.6-terra": { label: "GPT-5.6 Terra", general: 89, coding: 90, instruction: 90, speed: 85, reliability: 100, input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5, context: 1050000 },
  "gpt-5.6-luna": { label: "GPT-5.6 Luna", general: 82, coding: 80, instruction: 90, speed: 92, reliability: 100, input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, context: 1050000, variants: ["none", "low", "medium", "high", "xhigh", "max"] },
  "gpt-5.6": { label: "GPT-5.6", general: 95, coding: 96, instruction: 94, speed: 75, reliability: 100, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, context: 1050000 },
  "gpt-5.5": { label: "GPT-5.5", general: 95, coding: 96, instruction: 94, speed: 60, reliability: 100, input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, context: 1050000 },
  "gpt-5.5-pro": { label: "GPT-5.5 Pro", general: 97, coding: 97, instruction: 95, speed: 40, reliability: 100, input: 30, output: 180, context: 1050000 },
  "gpt-5.4": { label: "GPT-5.4", general: 91, coding: 92, instruction: 90, speed: 75, reliability: 100, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125, context: 1050000 },
  "gpt-5.4-mini": { label: "GPT-5.4 Mini", general: 83, coding: 85, instruction: 84, speed: 90, reliability: 100, input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.9375, context: 400000 },
  "gpt-5.4-nano": { label: "GPT-5.4 Nano", general: 74, coding: 76, instruction: 78, speed: 96, reliability: 100, input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.25, context: 400000 },
  "gpt-5.3-codex": { label: "GPT-5.3 Codex", general: 90, coding: 94, instruction: 88, speed: 75, reliability: 100, input: 1.75, output: 14, cacheRead: 0.175, context: 400000 },
  "gpt-5.3-codex-spark": { label: "GPT-5.3 Codex Spark", general: 90, coding: 94, instruction: 88, speed: 85, reliability: 100, input: 1.75, output: 14, context: 128000 },
  "o3": { label: "o3", general: 88, coding: 89, instruction: 86, speed: 60, reliability: 100, input: 2, output: 8, context: 200000 },
  "o4-mini": { label: "o4-mini", general: 82, coding: 84, instruction: 82, speed: 85, reliability: 100, input: 1.1, output: 4.4, context: 200000 },
  "gpt-4.1": { label: "GPT-4.1", general: 80, coding: 82, instruction: 82, speed: 80, reliability: 100, input: 2, output: 8, context: 1047576 },

  // Anthropic / Claude Code / OpenCode
  "claude-opus-5-5": { label: "Claude Opus 5.5", general: 98, coding: 98, instruction: 97, speed: 55, reliability: 100, input: 4, output: 20, context: 1000000, variants: ["low", "medium", "high", "xhigh", "max"] },
  "claude-opus-5": { label: "Claude Opus 5", general: 96, coding: 97, instruction: 96, speed: 60, reliability: 100, input: 5, output: 25, context: 1000000 },
  "claude-opus-4-8": { label: "Claude Opus 4.8", general: 95, coding: 96, instruction: 94, speed: 60, reliability: 100, input: 5, output: 25, context: 1000000 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", general: 94, coding: 94, instruction: 94, speed: 80, reliability: 100, input: 2, output: 10, context: 1000000, variants: ["low", "medium", "high", "xhigh", "max"] },
  "claude-sonnet-5": { label: "Claude Sonnet 5", general: 92, coding: 93, instruction: 92, speed: 82, reliability: 100, input: 2, output: 10, context: 1000000 },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", general: 90, coding: 91, instruction: 90, speed: 80, reliability: 100, input: 3, output: 15, context: 1000000 },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", general: 88, coding: 90, instruction: 90, speed: 92, reliability: 100, input: 0.1, output: 0.5, context: 1000000, variants: ["low", "medium", "high", "xhigh", "max"] },
  "claude-haiku-4-5": { label: "Claude Haiku 4.5", general: 80, coding: 82, instruction: 82, speed: 90, reliability: 100, input: 1, output: 5, context: 200000 },
  "claude-fable-5-1": { label: "Claude Fable 5.1", general: 95, coding: 94, instruction: 93, speed: 50, reliability: 100, input: 10, output: 50, context: 1000000 },

  // Zhipu / Moonshot / DeepSeek / Google / Alibaba / MiniMax / Xiaomi / xAI / outros
  "glm-5.3": { label: "GLM-5.3", general: 95, coding: 94, instruction: 94, speed: 65, reliability: 100, input: 1.4, output: 4.4, context: 1000000, variants: ["low", "high", "max"] },
  "glm-5.2": { label: "GLM-5.2", general: 93, coding: 92, instruction: 92, speed: 68, reliability: 100, input: 1.4, output: 4.4, context: 1000000 },
  "glm-5.3-flash": { label: "GLM-5.3-Flash", general: 90, coding: 88, instruction: 90, speed: 88, reliability: 98, input: 0.15, output: 0.5, context: 1000000, variants: ["low", "high", "max"] },
  "kimi-k3.1-pro": { label: "Kimi K3.1 Pro", general: 96, coding: 95, instruction: 93, speed: 55, reliability: 95, input: 2, output: 10, context: 1048576, variants: ["low", "high", "max"] },
  "kimi-k3": { label: "Kimi K3", general: 95, coding: 94, instruction: 92, speed: 60, reliability: 95, input: 3, output: 15, context: 1048576 },
  "kimi-k2.7-code": { label: "Kimi K2.7 Code", general: 88, coding: 94, instruction: 88, speed: 70, reliability: 100, input: 0.95, output: 4, context: 262144 },
  "kimi-k2.6": { label: "Kimi K2.6", general: 86, coding: 88, instruction: 85, speed: 75, reliability: 100, input: 0.95, output: 4, context: 262144 },
  "deepseek-v4-pro": { label: "DeepSeek V4 Pro", general: 93, coding: 94, instruction: 92, speed: 65, reliability: 100, input: 0.66, output: 1.98, context: 1000000 },
  "deepseek-v4.1-flash": { label: "DeepSeek V4.1 Flash", general: 87, coding: 88, instruction: 88, speed: 92, reliability: 100, input: 0.15, output: 0.6, context: 1000000 },
  "deepseek-v4-flash": { label: "DeepSeek V4 Flash", general: 84, coding: 85, instruction: 85, speed: 92, reliability: 100, input: 0.14, output: 0.28, context: 1000000 },
  "gemini-4-argon": { label: "Gemini 4 Argon", general: 94, coding: 94, instruction: 92, speed: 65, reliability: 100, input: 2, output: 10, context: 1048576 },
  "gemini-3.8-flash": { label: "Gemini 3.8 Flash", general: 85, coding: 86, instruction: 86, speed: 90, reliability: 100, input: 1.5, output: 7.5, context: 1048576 },
  "qwen3.8-flash": { label: "Qwen3.8 Flash", general: 85, coding: 86, instruction: 86, speed: 90, reliability: 100, input: 0.15, output: 0.47, context: 1000000 },
  "qwen3.8-max": { label: "Qwen3.8 Max", general: 93, coding: 94, instruction: 92, speed: 60, reliability: 100, input: 2, output: 6, context: 1000000 },
  "qwen4-max": { label: "Qwen4 Max", general: 95, coding: 96, instruction: 93, speed: 55, reliability: 100, input: 3, output: 12, context: 1000000 },
  "minimax-m3": { label: "MiniMax M3", general: 86, coding: 88, instruction: 85, speed: 75, reliability: 100, input: 0.3, output: 1.2, context: 1000000 },
  "minimax-m3.1-flash": { label: "MiniMax M3.1 Flash", general: 87, coding: 89, instruction: 86, speed: 88, reliability: 100, input: 0.15, output: 0.6, context: 1000000 },
  "mimo-v2.6-flash": { label: "MiMo V2.6 Flash", general: 83, coding: 85, instruction: 84, speed: 90, reliability: 100, input: 0.14, output: 0.28, context: 1048576 },
  "mimo-v2.6-pro": { label: "MiMo V2.6 Pro", general: 88, coding: 90, instruction: 87, speed: 78, reliability: 100, input: 0.435, output: 0.87, context: 1048576 },
  "grok-4.7": { label: "Grok 4.7", general: 93, coding: 93, instruction: 90, speed: 60, reliability: 100, input: 2, output: 6, context: 500000 },
  "longcat-2.5": { label: "LongCat 2.5", general: 86, coding: 87, instruction: 85, speed: 80, reliability: 100, input: 0.3, output: 1.2, context: 1000000 },
  "step-5-preview": { label: "Step 5 Preview", general: 92, coding: 93, instruction: 90, speed: 65, reliability: 95, input: 1, output: 2.7, context: 1000000 },
  "hy4-preview": { label: "Hy4 Preview", general: 88, coding: 89, instruction: 86, speed: 70, reliability: 95, input: 0.834, output: 2.501, context: 1024000 },
  "big-pickle": { label: "Big Pickle", general: 74, coding: 72, instruction: 80, speed: 80, reliability: 60, input: 0, output: 0, context: 200000, free: true },
};

// Pesos por papel: a soma de quality (general/coding/instruction/speed/reliability)
// e cost é 1. O fit do papel fica explícito no catálogo, não escondido na ordem.
export const ROLE_WEIGHTS = {
  harness: { general: 0.04, coding: 0.02, instruction: 0.18, speed: 0.06, reliability: 0.05, cost: 0.65 },
  planner: { general: 0.28, coding: 0.18, instruction: 0.12, speed: 0.02, reliability: 0.05, cost: 0.35 },
  builder: { general: 0.14, coding: 0.28, instruction: 0.06, speed: 0.02, reliability: 0.05, cost: 0.45 },
  reviewer: { general: 0.22, coding: 0.24, instruction: 0.08, speed: 0.02, reliability: 0.04, cost: 0.40 },
  shipper: { general: 0.03, coding: 0.02, instruction: 0.20, speed: 0.06, reliability: 0.04, cost: 0.65 },
  supervisor: { general: 0.18, coding: 0.10, instruction: 0.10, speed: 0.04, reliability: 0.03, cost: 0.55 },
};

export const ROLE_INFO = {
  harness: {
    label: "Harness",
    purpose: "orquestra e delega; procedimento vale mais que raciocínio",
    variant: "low",
    claude: "haiku",
    codex: "gpt-5.6-luna",
  },
  planner: {
    label: "Planner",
    purpose: "PRD e arquitetura; raciocínio alto e contexto grande",
    variant: "high",
    claude: "sonnet",
    codex: "gpt-5.6-sol",
  },
  builder: {
    label: "Builder",
    purpose: "implementa código em volume; cache e edição de repositório",
    variant: "medium",
    claude: "sonnet",
    codex: "gpt-5.6-sol",
  },
  reviewer: {
    label: "Reviewer",
    purpose: "parecer de arquitetura; leitura crítica sem rodar lint/testes",
    variant: "high",
    claude: "sonnet",
    codex: "gpt-5.6-terra",
  },
  shipper: {
    label: "Shipper",
    purpose: "procedimento exato de git/PR/issue; pouca criatividade",
    variant: "medium",
    claude: "haiku",
    codex: "gpt-5.6-terra",
  },
  supervisor: {
    label: "Supervisor",
    purpose: "auditoria e relatório longo; custo de saída pesa",
    variant: "low",
    claude: "haiku",
    codex: "gpt-5.6-terra",
  },
};

export const ROLE_ORDER = ["harness", "planner", "builder", "reviewer", "shipper", "supervisor"];

// Aliases do Claude Code. O valor gravado é o alias (resolvido pela conta);
// o modelo subjacente serve só para ranking/preço de referência.
export const CLAUDE_ALIASES = [
  { id: "haiku", label: "Claude Haiku (alias)", underlying: "claude-haiku-5-5", note: "mais barato/rápido da conta" },
  { id: "sonnet", label: "Claude Sonnet (alias)", underlying: "claude-sonnet-5-5", note: "equilíbrio padrão da conta" },
  { id: "opus", label: "Claude Opus (alias)", underlying: "claude-opus-5-5", note: "maior qualidade; consome mais cota" },
];

// Modelos conhecidos do Codex/OpenAI. O Codex também aceita o modelo que já
// estiver configurado em ~/.codex/config.toml — o instalador o adiciona à lista.
export const CODEX_MODELS = [
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
];

export const OPENCODE_DEFAULT_FALLBACK = {
  harness: { model: "opencode-go/gpt-6-luna", variant: "low" },
  planner: { model: "opencode-go/glm-5.3-flash", variant: "high" },
  builder: { model: "opencode-go/claude-haiku-5-5", variant: "medium" },
  reviewer: { model: "opencode-go/claude-haiku-5-5", variant: "high" },
  shipper: { model: "opencode-go/gpt-6-luna", variant: "medium" },
  supervisor: { model: "opencode-go/glm-5.3-flash", variant: "low" },
};

export const CLAUDE_DEFAULT_MODELS = {
  harness: "haiku",
  planner: "sonnet",
  builder: "sonnet",
  reviewer: "sonnet",
  shipper: "haiku",
  supervisor: "haiku",
};

export const CODEX_DEFAULT_MODELS = {
  harness: "gpt-5.6-luna",
  planner: "gpt-5.6-sol",
  builder: "gpt-5.6-sol",
  reviewer: "gpt-5.6-terra",
  shipper: "gpt-5.6-terra",
  supervisor: "gpt-5.6-terra",
};

// Custo relativo de cota nos planos Claude/Codex (assinatura). No OpenCode o
// custo real por token vem do catálogo do harness.
export const QUOTA_COST = {
  // Claude
  "claude-haiku-5-5": 0.2,
  "claude-haiku-4-5": 0.5,
  "claude-sonnet-5-5": 0.8,
  "claude-sonnet-5": 0.9,
  "claude-sonnet-4-6": 1,
  "claude-opus-5-5": 2.5,
  "claude-opus-5": 2.5,
  "claude-opus-4-8": 2.5,
  "claude-fable-5-1": 3.5,
  // Codex
  "gpt-6-luna": 0.2,
  "gpt-5.6-luna": 0.2,
  "gpt-6.1-terra": 0.6,
  "gpt-5.6-terra": 0.8,
  "gpt-6-sol": 1.2,
  "gpt-6.1-sol": 1.5,
  "gpt-5.6-sol": 1.5,
  "gpt-5.6": 1.5,
  "gpt-5.5": 2,
  "gpt-5.4": 1,
  "gpt-5.4-mini": 0.4,
  "gpt-5.4-nano": 0.15,
  "gpt-5.3-codex": 1,
  "gpt-5.3-codex-spark": 1,
  "gpt-6-astra": 3,
  "o3": 1,
  "o4-mini": 0.5,
  "gpt-4.1": 0.7,
};

export const VARIANT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_VARIANTS = {
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "claude-haiku-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "glm-5.3-flash": ["low", "high", "max"],
  "glm-5.3": ["low", "high", "max"],
  "kimi-k3.1-pro": ["low", "high", "max"],
};
