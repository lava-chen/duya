/**
 * Plan 624 — tool constraint selection.
 *
 * Names the four constraints the visibility filter consumes, with their
 * origin. The filter itself (`isToolVisible`) stays the single implementation;
 * this resolver only removes the inline `appliedProfile?.x ?? options?.y`
 * assembly from the session.
 *
 * `undefined` and `[]` are preserved as distinct values: the filter treats a
 * present-but-empty allow list as "allow nothing", so flattening the two would
 * silently deny every tool for an unconstrained profile.
 */
import type { AgentProfile } from '@duya/agent-core';

import type { CompositionDecision, ToolSelection, ToolSelectionInput } from './contract.js';

function copyIfDefined(list: readonly string[] | undefined): string[] | undefined {
  return list === undefined ? undefined : [...list];
}

export function resolveToolSelection(
  profile: AgentProfile | undefined,
  input: ToolSelectionInput = {},
): ToolSelection {
  const profileAllowedPatterns = copyIfDefined(profile?.allowedTools);
  const profileDisallowedPatterns = copyIfDefined(profile?.disallowedTools);
  const turnAllowedTools = copyIfDefined(input.allowedTools);
  const turnDisabledTools = copyIfDefined(input.disabledTools);
  const decisions: CompositionDecision[] = [];

  if (profileAllowedPatterns !== undefined) {
    decisions.push({
      field: 'tools.profileAllowed',
      value: profileAllowedPatterns.join(','),
      source: 'profile',
      note: `${profileAllowedPatterns.length} allow pattern(s) from the applied profile`,
    });
  }
  if (profileDisallowedPatterns !== undefined) {
    decisions.push({
      field: 'tools.profileDisallowed',
      value: profileDisallowedPatterns.join(','),
      source: 'profile',
      note: `${profileDisallowedPatterns.length} deny pattern(s) from the applied profile`,
    });
  }
  if (turnAllowedTools !== undefined) {
    decisions.push({
      field: 'tools.turnAllowed',
      value: turnAllowedTools.join(','),
      source: 'turn-override',
    });
  }
  if (turnDisabledTools !== undefined) {
    decisions.push({
      field: 'tools.turnDisabled',
      value: turnDisabledTools.join(','),
      source: 'turn-override',
    });
  }
  if (decisions.length === 0) {
    decisions.push({
      field: 'tools.constraints',
      value: 'none',
      source: 'host-default',
      note: 'no profile or turn constraint: every registered tool is eligible',
    });
  }

  return {
    ...(profileAllowedPatterns !== undefined ? { profileAllowedPatterns } : {}),
    ...(profileDisallowedPatterns !== undefined ? { profileDisallowedPatterns } : {}),
    ...(turnAllowedTools !== undefined ? { turnAllowedTools } : {}),
    ...(turnDisabledTools !== undefined ? { turnDisabledTools } : {}),
    decisions,
  };
}
