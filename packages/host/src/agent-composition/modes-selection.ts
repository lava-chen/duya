/**
 * Plan 624 — mode selection.
 *
 * `collectActiveModes` today is the whole story (`[options.mode]`), including
 * the quirk that `'normal'` is still passed to the registry; the orchestrator
 * flag is a separate lookup that excludes `'normal'`. Both behaviours are
 * reproduced here verbatim so the resolver is a move, not a rewrite.
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
  // Mirrors collectActiveModes: any non-empty mode string is an active id,
  // `'normal'` included. Only the orchestrator lookup treats it as special.
  const activeModeIds = input.mode && input.mode.length > 0 ? [input.mode] : [];

  if (activeModeIds.length === 0) {
    return {
      activeModeIds,
      decisions: [
        {
          field: 'modes.active',
          value: '',
          source: 'host-default',
          note: 'no mode declared: no modifier is resolved',
        },
      ],
    };
  }

  const id = activeModeIds[0]!;
  const decisions: CompositionDecision[] = [
    { field: 'modes.active', value: id, source: 'turn-override' },
  ];

  // Matches _readOrchestratorMode: 'normal' can never orchestrate.
  const orchestrator = id !== 'normal' && lookup?.get(id)?.orchestrator !== undefined;
  if (orchestrator) {
    decisions.push({
      field: 'modes.orchestrator',
      value: id,
      source: 'turn-override',
      note: 'the requested mode registers an orchestrator',
    });
  }

  return {
    activeModeIds,
    ...(orchestrator ? { orchestratorModeId: id } : {}),
    decisions,
  };
}
