export function phaseProblem(result, { requireVerdict = false } = {}) {
  if (!["end_turn", "max_tokens"].includes(result.stopReason)) return `Turno ACP terminou com ${result.stopReason}.`;
  const output = result.output.trim();
  if (!output) return "O agente encerrou o turno sem entregar a saída da fase.";
  const blocker = /^[ \t]*(?:[-*][ \t]+)?\**BLOQUEIO\**[ \t]*:\**[ \t]*(.+)$/im.exec(output);
  if (blocker) return blocker[1];
  if (requireVerdict) {
    const verdict = [...output.matchAll(/\b(APPROVED|CHANGES_REQUESTED)\b/g)].at(-1)?.[1];
    if (verdict === "CHANGES_REQUESTED") return output;
    if (verdict !== "APPROVED") return `Parecer sem veredito conclusivo.\n${output}`;
  }
  return null;
}

export function recoveryOwner(output) {
  return /^\s*RESPONS[ÁA]VEL:\s*(planner|builder|reviewer|shipper|supervisor|humano)\s*$/im.exec(output)?.[1]?.toLowerCase() ?? "humano";
}

export async function settleStage({ run, recover, wait, onBlocked, resumeContext = "" }) {
  let previous = resumeContext;
  let attempts = 0;
  while (true) {
    let result;
    try { result = await run(previous); } catch (error) { result = { error: error?.message || String(error) }; }
    if (!result?.error) return result;
    previous = result.error;
    onBlocked(previous);
    let ready = false;
    while (attempts < 2) {
      attempts++;
      let repair;
      try { repair = await recover(previous); } catch (error) { repair = { notes: error?.message || String(error) }; }
      if (repair?.notes) previous += `\n\n${repair.notes}`;
      ready = !!repair?.ready;
      if (ready) break;
      onBlocked(previous);
      if (!repair?.retryRecovery) break;
    }
    if (ready) continue;
    if (!await wait(previous)) return { blocked: previous };
    attempts = 0;
  }
}
