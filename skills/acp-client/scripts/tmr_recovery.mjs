export function phaseProblem(result) {
  if (!["end_turn", "max_tokens"].includes(result.stopReason)) return `Turno ACP terminou com ${result.stopReason}.`;
  const output = result.output.trim();
  if (!output) return "O agente encerrou o turno sem entregar a saída da fase.";
  const blocker = /^[ \t]*(?:[-*][ \t]+)?\**BLOQUEIO\**[ \t]*:\**[ \t]*(.+)$/im.exec(output);
  if (blocker) return blocker[1];
  return null;
}

export function reviewFailure(result) {
  const output = result.output.trim();
  const verdict = [...output.matchAll(/^[ \t]*(?:[-*][ \t]+)?[*`]*(?:(?:verdict|veredito)\**:?[ \t]+)?[*`]*(APPROVED|CHANGES_REQUESTED)[*`]*[ \t]*$/gim)]
    .at(-1)?.[1].toUpperCase();
  if (["end_turn", "max_tokens"].includes(result.stopReason) && verdict === "CHANGES_REQUESTED") {
    return { error: output, repairCode: true };
  }
  const error = phaseProblem(result);
  if (error) return { error };
  if (verdict !== "APPROVED") return { error: `Parecer sem veredito conclusivo.\n${output}` };
  return null;
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
    if (attempts < 2) {
      attempts++;
      let repair;
      try { repair = await recover(previous, result); } catch (error) { repair = { notes: error?.message || String(error) }; }
      if (repair?.notes) previous += `\n\n${repair.notes}`;
      if (repair?.ready) continue;
      if (repair?.notes) onBlocked(previous);
    }
    if (!await wait(previous)) return { blocked: previous };
    attempts = 0;
  }
}
