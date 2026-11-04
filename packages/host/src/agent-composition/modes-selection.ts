/**
 * Plan 624 — mode selection.
 *
 * `collectActiveModes` today is the whole story (`[options.mode]`), and the
 * orchestrator flag is a second lookup on the same id. Both live here so the
 * session stops deciding "which mode am I in" in two places.
 */
import type { CompositionDecision, ModeSelection, ModeSelectionInput } from './contract.js';

/** Minimal view of the mode registry; the real registry is a process singleton. */
export interface ModeModifierLookup {
  get(id: string): { readonly orchestrator?: unknown } | undefined;
}

export function resolveModeSelection(
  input: ModeSelectionInput = {},
  lookup?: ModeModifierLookup,
): ModeSelection {
  const requested = input.mode && input.mode.length > 0 ? input.mode : 'normal';
  const decisions: CompositionDecision[] = [];

  if (requested === 'normal') {
    decisions.push({
      field: 'modes.active',
      value: '',
      source: 'host-default',
      note: 'normal mode applies no modifier',
    });
    return { activeModeIds: [], decisions };
  }

  const orchestrator = lookup?.get(requested)?.orchestrator !== undefined;
  decisions.push({
    field: 'modes.active',
    value: requested,
    source: 'turn-override',
  });
  if (orchestrator) {
    decisions.push({
      field: 'modes.orchestrator',
      value: requested,
      source: 'turn-override',
      note: 'the requested mode registers an orchestrator',
    });
  }

  return {
    activeModeIds: [requested],
    ...(orchestrator ? { orchestratorModeId: requested } : {}),
    decisions,
  };
}
