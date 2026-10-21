/**
 * evals/agent/fixtures/to-harness-input.ts — the ONE adapter from a case to the
 * E4.1 harness.
 *
 * ## Why the adapter exists, and why it is the only one
 *
 * The harness (`apps/desktop/src/main/__tests__/eval-legacy-loop.ts`) owns the
 * real closed loop. A case must not re-implement any of it, and must not reach
 * past it either. So this file is the single translation point from the versioned
 * case format into `EvalCaseInput`, and the shape of that translation is
 * asserted by `adapter.test.ts` — if the harness's input type grows a field that
 * a case can express, the mapping either sets it or the test names the gap.
 *
 * ## What the mapping deliberately does NOT do
 *
 * It does not decide the run's outcome. Every field it copies is either an input
 * the case genuinely owns (the prompt, the provider script, the budget) or a
 * knob the harness already exposes. Nothing here computes an expectation, and
 * nothing here may read a result.
 */

import type { EvalCaseInput } from '../../../apps/desktop/src/main/__tests__/eval-legacy-loop';
import type { OfflineProviderScript } from '../../../apps/desktop/src/main/__tests__/eval-offline-provider';
import { CaseFormatError, type EvalCase } from '../cases/format';

/** The provider script a case declares, in the harness's own vocabulary. */
export function toProviderScript(c: EvalCase): OfflineProviderScript {
  return {
    seed: c.scenario.seed,
    turns: c.scenario.turns.map((turn) => ({
      blocks: turn.blocks.map((block) => {
        if (block.kind === 'text') return { kind: 'text' as const, text: block.text };
        if (block.kind === 'thinking') {
          return { kind: 'thinking' as const, thinking: block.thinking, signature: block.signature };
        }
        return { kind: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
      }),
      stopReason: turn.stopReason,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      error: turn.error,
    })),
  };
}

/**
 * The usage a case's own provider script declares.
 *
 * The LAST turn's numbers, because the harness reads the last `chat:token_usage`
 * frame the executor emitted. This is the comparison that makes usage
 * load-bearing: the fixture declares, the real adapter must extract exactly.
 */
export function declaredUsage(script: OfflineProviderScript): { inputTokens: number; outputTokens: number } {
  const last = script.turns[script.turns.length - 1];
  return {
    inputTokens: last?.inputTokens ?? 0,
    outputTokens: last?.outputTokens ?? 0,
  };
}

export function toHarnessInput(c: EvalCase): EvalCaseInput {
  if (c.mode === 'live') {
    // A live case is not run through the offline harness. Handing its prompt to
    // the loopback provider would produce a report labelled `live` whose bytes
    // came from a fixture — the exact fabrication the plan forbids.
    throw new CaseFormatError([
      `case "${c.id}": mode "live" is not run through the offline harness; the runner must send it to the live path`,
    ]);
  }
  return {
    prompt: c.input.prompt,
    script: toProviderScript(c),
    permissionMode: c.policy.permissionMode,
    maxTurns: c.budget.maxTurns,
    workspaceFiles: c.input.workspaceFiles ?? {},
    seed: c.scenario.seed,
    timeoutMs: c.budget.timeoutMs,
    tamperManifestHash: c.scenario.tamperManifestHash === true,
  };
}
