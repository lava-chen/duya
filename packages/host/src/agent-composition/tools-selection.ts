/**
 * Plan 624 — tool constraint selection.
 *
 * Names the four constraints the visibility filter consumes, with their
 * origin. The filter itself (`isToolVisible`) stays the single implementation;
 * this resolver only removes the inline `appliedProfile?.x ?? options?.y`
 * assembly from the session.
 */
import type { AgentProfile } from '@duya/agent-core';

import type { CompositionDecision, ToolSelection, ToolSelectionInput } from './contract.js';

export function resolveToolSelection(
  profile: AgentProfile | undefined,
  input: ToolSelectionInput = {},
): ToolSelection {
  const profileAllowedPatterns = [...(profile?.allowedTools ?? [])];
  const profileDisallowedPatterns = [...(profile?.disallowedTools ?? [])];
  const turnAllowedTools = [...(input.allowedTools ?? [])];
  const turnDisabledTools = [...(input.disabledTools ?? [])];
  const decisions: CompositionDecision[] = [];

  if (profileAllowedPatterns.length > 0) {
    decisions.push({
      field: 'tools.profileAllowed',
      value: profileAllowedPatterns.join(','),
      source: 'profile',
      note: `${profileAllowedPatterns.length} allow pattern(s) from the applied profile`,
    });
  }
  if (profileDisallowedPatterns.length > 0) {
    decisions.push({
      field: 'tools.profileDisallowed',
      value: profileDisallowedPatterns.join(','),
      source: 'profile',
      note: `${profileDisallowedPatterns.length} deny pattern(s) from the applied profile`,
    });
  }
  if (turnAllowedTools.length > 0) {
    decisions.push({
      field: 'tools.turnAllowed',
      value: turnAllowedTools.join(','),
      source: 'turn-override',
    });
  }
  if (turnDisabledTools.length > 0) {
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
    profileAllowedPatterns,
    profileDisallowedPatterns,
    turnAllowedTools,
    turnDisabledTools,
    decisions,
  };
}
