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

/** O identificador só complementa o nome quando eles forem diferentes. */
export function modelDisplayName(entry) {
  return entry.label === entry.modelValue ? entry.modelValue : `${entry.label}  [${entry.modelValue}]`;
}
