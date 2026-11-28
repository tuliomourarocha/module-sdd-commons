const isCount = (value) => Number.isFinite(value) && value >= 0;

export class SessionUsage {
  tokens = 0;
  reportedCost = null;
  estimatedCost = null;
  missingCost = false;

  update({ cost, used, size }) {
    if (isCount(used)) this.contextUsed = used;
    if (isCount(size) && size > 0) this.contextSize = size;
    // O ACP publica snapshots cumulativos dentro de cada sessão.
    if (cost?.currency === "USD" && isCount(cost.amount)) this.reportedCost = cost.amount;
  }

  addTurn(usage, model, { steering = false } = {}) {
    if (!usage) {
      if (!steering) this.missingCost = true;
      return;
    }
    const { inputTokens, outputTokens, totalTokens, cachedReadTokens = 0, cachedWriteTokens = 0, thoughtTokens = 0 } = usage;
    const input = inputTokens ?? 0;
    const output = outputTokens ?? 0;
    const read = cachedReadTokens ?? 0;
    const write = cachedWriteTokens ?? 0;
    const knownTokens = input + output + read + write;
    this.tokens += isCount(totalTokens) ? totalTokens : knownTokens;
    if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(model?.input) || !isCount(model?.output)) {
      if (totalTokens !== 0) this.missingCost = true;
      return;
    }

    // Nas respostas do Codex a saída já inclui raciocínio. Outros adaptadores
    // podem reportá-lo à parte e incluí-lo apenas no total.
    const reasoning = thoughtTokens > 0 && totalTokens >= knownTokens + thoughtTokens ? thoughtTokens : 0;
    const cost = (input * model.input + read * (model.cacheRead ?? model.input) +
      write * (model.cacheWrite ?? model.input) + (output + reasoning) * model.output) / 1_000_000;
    this.estimatedCost = (this.estimatedCost ?? 0) + cost;
  }
}

export function summarizeUsage(sessions) {
  let tokens = 0;
  let cost = null;
  let estimated = false;
  let partial = false;
  for (const session of sessions) {
    tokens += session.tokens;
    const amount = session.reportedCost ?? session.estimatedCost;
    if (amount != null) cost = (cost ?? 0) + amount;
    if (session.reportedCost == null) {
      estimated ||= session.estimatedCost != null;
      partial ||= session.missingCost;
    }
  }
  return { tokens, cost, costEstimated: estimated, costPartial: cost != null && partial };
}
