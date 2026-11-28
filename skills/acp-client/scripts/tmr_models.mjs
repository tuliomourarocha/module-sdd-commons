/** Mescla modelos disponíveis sem repetir o mesmo ID; preserva a ordem ranqueada. */
export function mergeAvailableModels(ranked, available) {
  const availSet = new Set((available ?? []).map((item) => item.value));
  const result = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry.modelValue || seen.has(entry.modelValue)) return;
    seen.add(entry.modelValue);
    result.push(entry);
  };
  for (const entry of ranked) {
    if (!availSet.size || availSet.has(entry.modelValue)) add(entry);
  }
  const extras = (available ?? [])
    .filter((item) => !seen.has(item.value))
    .map((item) => ({ modelValue: item.value, label: item.name ?? item.value, input: null, output: null, context: null }))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const entry of extras) add(entry);
  return result;
}

export function sessionModels(info) {
  const option = info.configOptions?.find(({ category, type }) => category === "model" && type === "select");
  const values = option?.options?.flatMap((item) => item.options ?? [item]) ?? [];
  const byId = new Map();
  for (const { value, name } of [...values, ...(info.models?.availableModels ?? [])
    .map(({ modelId, name }) => ({ value: modelId, name }))]) {
    if (typeof value === "string" && value && !byId.has(value)) byId.set(value, { value, name });
  }
  return { option, available: [...byId.values()], current: option?.currentValue ?? info.models?.currentModelId };
}

export function modelDisplayName(entry) {
  if (entry.label === entry.modelValue) return entry.modelValue;
  const separator = entry.modelValue.indexOf("/");
  if (separator !== -1 && entry.label === entry.modelValue.slice(separator + 1)) return entry.modelValue;
  return `${entry.label}  [${entry.modelValue}]`;
}
