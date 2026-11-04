/** Pure agent-type vocabulary: alias table, strict resolution, catalog text. */

import type { BaseAgentDefinition } from './agent-definition.js';

/**
 * Model-facing spellings normalize onto canonical definition ids. Keys are
 * lowercase; the canonical values match the `agentType` of a definition the
 * host registers. Mirrors the table that used to live inline in
 * worker-subagents/service.ts — this module is the single authority.
 */
export const AGENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  explore: 'Explore',
  explorer: 'Explore',
  plan: 'Plan',
  research: 'Research',
  codereview: 'CodeReview',
  'code-review': 'CodeReview',
  verification: 'verification',
  'general-purpose': 'general-purpose',
  generalpurpose: 'general-purpose',
};

/** The type assumed when the model omits `subagent_type` entirely. */
export const DEFAULT_AGENT_TYPE = 'general-purpose';

export type AgentTypeResolution<T extends Pick<BaseAgentDefinition, 'agentType'>> =
  | { readonly ok: true; readonly definition: T }
  | {
      readonly ok: false;
      /** What the model asked for, whitespace-trimmed. */
      readonly requested: string;
      readonly available: readonly string[];
    };

/**
 * Resolve a model-supplied `subagent_type` against the active definitions.
 *
 * Matching is exact-canonical first (the alias map), then case-insensitive
 * against the definitions themselves — so a model writing `explore` lands on
 * `Explore` through the alias table and one writing `General-Purpose` lands
 * through the case fold. An empty input means the default type.
 */
export function resolveAgentType<T extends Pick<BaseAgentDefinition, 'agentType'>>(
  raw: string | undefined,
  agents: readonly T[],
): AgentTypeResolution<T> {
  const trimmed = (raw ?? '').trim();
  const requested = trimmed === '' ? DEFAULT_AGENT_TYPE : trimmed;
  const lowered = requested.toLowerCase();
  const canonical = AGENT_TYPE_ALIASES[lowered] ?? requested;
  const definition = agents.find(
    (agent) => agent.agentType === canonical || agent.agentType.trim().toLowerCase() === lowered,
  );
  if (definition !== undefined) return { ok: true, definition };
  return { ok: false, requested, available: agents.map((agent) => agent.agentType) };
}

/** The error text `task` returns for an unknown type — names the valid set. */
export function unavailableAgentTypeMessage(
  resolution: Extract<AgentTypeResolution<Pick<BaseAgentDefinition, 'agentType'>>, { ok: false }>,
): string {
  return `Agent type "${resolution.requested}" not found. Available types: ${resolution.available.join(', ')}`;
}

/** Bounded per-entry description so the tool schema stays a fixed cost. */
const WHEN_TO_USE_CHARS = 160;

function firstSentence(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const period = normalized.search(/[.!?。](\s|$)/);
  const sentence = period === -1 ? normalized : normalized.slice(0, period + 1);
  return sentence.length > WHEN_TO_USE_CHARS
    ? `${sentence.slice(0, WHEN_TO_USE_CHARS - 1)}…`
    : sentence;
}

/**
 * The model-facing catalog text for the `task` tool's `subagent_type` field —
 * codex builds the same thing from its agent roles and injects it into the
 * spawn tool description. A description, not a schema `enum`: user/project
 * definitions change per session and the schema is built once per worker, so
 * an enum would go stale exactly when custom agents exist.
 */
export function describeAgentTypes<T extends Pick<BaseAgentDefinition, 'agentType' | 'whenToUse'>>(
  agents: readonly T[],
): string {
  return agents
    .map((agent) => `- ${agent.agentType} — ${firstSentence(agent.whenToUse)}`)
    .join('\n');
}
