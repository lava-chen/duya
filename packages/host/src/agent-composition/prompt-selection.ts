/**
 * Plan 624 — prompt selection.
 *
 * Extracted from `WorkerSession._buildSystemPrompt`, which today resolves the
 * prompt system, the section overrides and the bot tail inline. Keeping the
 * decision pure makes it assertable without a session instance, and gives the
 * composition layer one place to explain its choice.
 */
import type { AgentProfile } from '@duya/agent-core';

import { isBotAgentProfile } from '../worker-prompts/bot/loader.js';
import { resolvePromptSystemName } from '../worker-prompts/registry.js';
import type { CompositionDecision, PromptSelection } from './contract.js';

const NO_PROFILE_SYSTEM = 'general';

/**
 * Resolve which prompt system a profile runs, plus the section overrides that
 * narrow it.
 *
 * The fallback to `general` is deliberate and load-bearing: built-in sub-agents
 * (explore / plan) and infrastructure profiles (cron) declare no `promptSystem`
 * and rely on `promptProfile.disableSections` instead. It is recorded as
 * `fallback`, not as `host-default`, because it is a property of the profile
 * shape rather than a host-level choice.
 */
export function resolvePromptSelection(profile?: AgentProfile): PromptSelection {
  const decisions: CompositionDecision[] = [];
  const requestedSystem = profile?.promptSystem;

  if (!profile) {
    decisions.push({
      field: 'prompt.system',
      value: NO_PROFILE_SYSTEM,
      source: 'host-default',
      note: 'no applied profile: the default composition',
    });
    return {
      promptSystem: NO_PROFILE_SYSTEM,
      suppressIdentityBlock: false,
      usesBotAssembly: false,
      disableSections: [],
      enableSections: [],
      decisions,
    };
  }

  const promptSystem = resolvePromptSystemName(requestedSystem);
  if (requestedSystem === undefined) {
    decisions.push({
      field: 'prompt.system',
      value: promptSystem,
      source: 'fallback',
      note: `${profile.id} declares no promptSystem; sections are narrowed by promptProfile.disableSections`,
    });
  } else {
    decisions.push({
      field: 'prompt.system',
      value: promptSystem,
      source: 'profile',
    });
  }

  const usesBotAssembly = isBotAgentProfile(profile);
  if (usesBotAssembly) {
    decisions.push({
      field: 'prompt.botAssembly',
      value: 'append-as-host-block',
      source: 'config',
      note: 'bot section text is rendered by the bot assembly, not by the prompt system config',
    });
  }

  const suppressIdentityBlock = profile.suppressIdentityBlock === true;
  if (suppressIdentityBlock) {
    decisions.push({
      field: 'prompt.suppressIdentityBlock',
      value: 'true',
      source: 'profile',
      note: 'the prompt system opens with its own identity section',
    });
  }

  const disableSections = [...(profile.promptProfile?.disableSections ?? [])];
  const enableSections = [...(profile.promptProfile?.enableSections ?? [])];

  return {
    promptSystem,
    ...(requestedSystem !== undefined ? { requestedSystem } : {}),
    suppressIdentityBlock,
    usesBotAssembly,
    disableSections,
    enableSections,
    decisions,
  };
}
