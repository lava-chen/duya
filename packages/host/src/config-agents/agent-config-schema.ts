/**
 * agent-config-schema.ts — the `[agents.<id>]` config shape (Host aliases).
 *
 * The shape moved to `@duya/bot` as `BotIdentityEntry` (framework plan S2);
 * this module re-exports it and its sub-shapes under the historical names so
 * every Host and Desktop importer keeps one import path, and keeps the two
 * write-side types that are the Host's own config-agent API surface.
 */

import type { BotIdentityEntry } from '@duya/bot';

export type {
  AgentUpsertInput,
  CustomAgentPromptConfig,
  CustomAgentPromptIdentityConfig,
  CustomAgentPromptSectionsConfig,
  CustomAgentToolsConfig,
} from '@duya/bot';
export type { BotIdentityEntry as CustomAgentConfig } from '@duya/bot';

/** Fields an identity patch may change (name / description only). */
export interface AgentIdentityPatch {
  name?: string | undefined;
  description?: string | undefined;
}

/** Result of a create-semantics agent creation — `id` is the ACTUAL id. */
export interface CreatedConfigAgent {
  id: string;
  config: BotIdentityEntry;
}
