/**
 * Plan 624 — scope resolution.
 *
 * One function answers "which composition is this profile", so the five
 * agent shapes stop being implicit in scattered predicates.
 */
import type { AgentProfile } from '@duya/agent-core';

import { PROJECT_COORDINATOR_PROFILE_ID } from '../project/identity.js';
import { isBotAgentProfile } from '../worker-prompts/bot/loader.js';
import type { CompositionDecision, ScopeResolution } from './contract.js';

function decision(
  value: string,
  source: CompositionDecision['source'],
  note?: string,
): CompositionDecision {
  return note === undefined
    ? { field: 'scope', value, source }
    : { field: 'scope', value, source, note };
}

/**
 * Resolve the composition scope for a profile.
 *
 * Order matters. A config-driven bot is `kind: 'main'` with `isPreset: false`,
 * so it must be recognized before the generic main-session branch; otherwise
 * every `[agents.<id>]` entry would silently lose its bot assembly.
 */
export function resolveCompositionScope(profile: AgentProfile): ScopeResolution {
  if (isBotAgentProfile(profile)) {
    return {
      scope: 'bot',
      decisions: [
        decision(
          'bot',
          'config',
          'config-driven agent ([agents.<id>]): non-preset main profile, prompt text comes from the bot assembly',
        ),
      ],
    };
  }

  if (profile.id === PROJECT_COORDINATOR_PROFILE_ID) {
    return {
      scope: 'coordinator',
      decisions: [
        decision(
          'coordinator',
          'profile',
          `preset ${PROJECT_COORDINATOR_PROFILE_ID}: same runtime, dedicated prompt system and tool scope`,
        ),
      ],
    };
  }

  if (profile.kind === 'subagent') {
    return {
      scope: 'subagent',
      decisions: [decision('subagent', 'profile', 'kind=subagent')],
    };
  }

  if (profile.kind === 'special') {
    return {
      scope: 'special',
      decisions: [decision('special', 'profile', 'kind=special')],
    };
  }

  return {
    scope: 'main-session',
    decisions: [decision('main-session', 'profile', `kind=${profile.kind ?? 'undefined'}`)],
  };
}
