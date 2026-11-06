/**
 * Plan 624 v2 G2 — the section plan.
 *
 * This is the composition layer's answer to "which prompt sections does this
 * agent shape actually have?". It closes the bot double track: a bot used to
 * have a declarative `botConfig` in `PromptsRegistry` (never instantiated)
 * AND a `BotPromptAssembly` that produced the text. Now there is one plan:
 * the PromptSystem sections come from the section registry for the resolved
 * prompt system, and the assembly sections are attached only when the scope
 * is `bot`.
 *
 * Pure by construction: no renderer, no template, no IO. The registry is a
 * static table, so a plan can be asserted for every preset without building
 * a session.
 */
import type { AgentProfile } from '@duya/agent-core';

import {
  BOT_ASSEMBLY_SECTION_IDS,
  sectionsForConfig,
} from '../worker-prompts/sections/placement-registry.js';
import type { CompositionDecision } from './contract.js';
import { resolvePromptSelection } from './prompt-selection.js';
import { resolveCompositionScope } from './scope.js';

export interface SectionPlan {
  /** PromptSystem config name whose registry rows produced `configSections`. */
  readonly promptSystem: string;
  /** Sections rendered by the PromptSystem config, in registry order. */
  readonly configSections: readonly string[];
  /** Sections appended by `BotPromptAssembly`; empty for every other scope. */
  readonly botSections: readonly string[];
  readonly decisions: readonly CompositionDecision[];
}

const EMPTY_BOT_SECTIONS: readonly string[] = Object.freeze([]);

export function resolveSectionPlan(profile?: AgentProfile): SectionPlan {
  const promptSystem = resolvePromptSelection(profile).promptSystem;
  const configSections = Object.freeze(sectionsForConfig(promptSystem));
  const scope = profile ? resolveCompositionScope(profile).scope : 'main-session';
  const isBot = scope === 'bot';
  const botSections = isBot ? BOT_ASSEMBLY_SECTION_IDS : EMPTY_BOT_SECTIONS;

  const decisions: readonly CompositionDecision[] = Object.freeze(
    [
      {
        field: 'sections.config',
        value: `${promptSystem}:${configSections.length}`,
        source: 'config',
        note: configSections.join(','),
      },
      {
        field: 'sections.assembly',
        value: isBot ? `bot:${botSections.length}` : 'none',
        source: isBot ? 'config' : 'host-default',
        note: isBot
          ? 'bot sections come from BotPromptAssembly, never from a PromptSystem config'
          : 'no bot assembly for this scope',
      },
    ].map((entry) => Object.freeze(entry)) as readonly CompositionDecision[],
  );

  return Object.freeze({
    promptSystem,
    configSections,
    botSections,
    decisions: Object.freeze(decisions),
  });
}
