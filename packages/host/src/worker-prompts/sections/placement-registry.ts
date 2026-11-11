/**
 * Plan 624 D1 / v2 G2 — the section registry.
 *
 * ONE table answers three questions about every prompt section:
 *   1. which delivery channel it rides (`system` / `context`);
 *   2. why, in one line, so a later change cannot silently move bytes across
 *      the prompt-cache boundary;
 *   3. which prompt-system configs (or which bot assembly) declare it.
 *
 * Before D1, `placement` was declared independently by each config. D1 made
 * this table authoritative but still let configs repeat the declaration. v2
 * removes that repetition: configs no longer name a channel at all, and the
 * composition layer derives a config's section list from `configs` here.
 *
 * The bot rows are the ONLY bot section directory. There is deliberately no
 * `bot` PromptSystem config: bot prompt text is rendered by
 * `BotPromptAssembly` from `BOT_SECTION_CATALOG`, and a second declarative
 * config that nobody instantiated used to make that look like two tracks.
 */
import type { PromptPlacement } from '../types.js';

export type SectionKind = 'module' | 'dynamic' | 'host-block' | 'bot-assembly';

export interface SectionPlacementRule {
  readonly placement: PromptPlacement;
  /** Why this channel — one line, so the next reader does not have to guess. */
  readonly reason: string;
  /** Where the text is produced. */
  readonly kind: SectionKind;
  /** Prompt-system config names that declare this section (bot assembly uses `bot`). */
  readonly configs: readonly string[];
}

const stable = (
  reason: string,
  kind: SectionKind = 'module',
  configs: readonly string[] = [],
): SectionPlacementRule => ({ placement: 'system', reason, kind, configs });
const volatile = (
  reason: string,
  kind: SectionKind = 'dynamic',
  configs: readonly string[] = [],
): SectionPlacementRule => ({ placement: 'context', reason, kind, configs });

const GENERAL = 'general';
const CODE = 'code';
const RESEARCH = 'research';
const PROJECT = 'project';

export const SECTION_PLACEMENTS: Readonly<Record<string, SectionPlacementRule>> = {
  // ---- system half: must stay byte-identical across turns ----
  identity: stable('authored identity; never changes mid-session', 'module', [GENERAL, CODE]),
  system: stable('core operating guidance', 'module', [GENERAL, CODE]),
  destructiveActions: stable('safety policy', 'module', [GENERAL]),
  configProtection: stable('safety policy', 'module', [GENERAL, CODE, RESEARCH]),
  tools: stable('tool-usage guidance; tool NAMES change through the catalog channel, not this text', 'module', [GENERAL]),
  tasks: stable('task-tracking guidance', 'module', [GENERAL]),
  skillUsage: stable('skill invocation guidance', 'module', [GENERAL]),
  duyaDesktopContext: stable('desktop capability description', 'module', [GENERAL, CODE]),
  finalAnswer: stable('output contract', 'module', [GENERAL, PROJECT]),
  platform: stable('per-platform guidance, fixed for the session', 'dynamic', [GENERAL, CODE]),
  scratchpad: stable('scratchpad location guidance', 'dynamic', [GENERAL, CODE]),

  // Module ids used by the code composition (the rendered `name` is the row
  // above). Kept registered so a config that switches to a module ref cannot
  // acquire an unregistered id.
  identityCoding: stable('coding identity', 'module', [CODE]),
  systemCoding: stable('coding guidance', 'module', [CODE]),
  duyaDesktopContextCode: stable('desktop capability description for coding sessions', 'module', [CODE]),
  projectContinuity: stable('project continuity guidance', 'module', [CODE, RESEARCH]),
  personality: stable('tone', 'module', [CODE]),
  workingWithTheUser: stable('collaboration rules', 'module', [CODE]),
  rules: stable('hard rules', 'module', [CODE]),
  researchProfile: stable('research identity', 'module', [RESEARCH]),
  taskIntent: stable('intent classification guidance', 'module', [RESEARCH]),
  evidencePolicy: stable('evidence standard', 'module', [RESEARCH]),
  memoryWriteProposal: stable('memory proposal format', 'module', [RESEARCH]),
  toneAndStyle: stable('tone', 'module', [RESEARCH]),

  // Coordinator composition (plan 624 scope=coordinator). Identity is stable
  // because `suppressIdentityBlock` relies on the prompt's own opening section
  // taking that role.
  projectIdentity: stable('coordinator identity; opens the prompt', 'module', [PROJECT]),
  projectOperation: stable('coordinator tool-usage guidance', 'module', [PROJECT]),
  projectDelegation: stable('delegation rules', 'module', [PROJECT]),
  projectReporting: stable('reporting contract', 'module', [PROJECT]),
  projectContextPolicy: stable('context authority and recovery', 'module', [PROJECT]),
  project_snapshot: volatile('Session-bound project facts refreshed for each model request', 'host-block'),

  // ---- context half: re-rendered per build and delivered as a message ----
  environment: volatile('cwd / branch / date can change every turn', 'dynamic', [GENERAL, CODE]),
  mcp: volatile('MCP servers connect and disconnect mid-session', 'dynamic', [GENERAL, CODE]),
  skills: volatile('skill catalog changes when skills are installed', 'dynamic', [GENERAL, CODE]),
  memory: volatile('memory projection is rewritten by the background worker', 'dynamic', [GENERAL, CODE]),
  sessionGuidance: volatile('depends on live session history', 'dynamic', [GENERAL, CODE]),
  vision: volatile('depends on whether the current turn carries images', 'dynamic', [GENERAL, CODE, RESEARCH]),
  outputFormat: volatile('depends on the research intent resolved for the request', 'dynamic', [RESEARCH]),

  // Host blocks that ride the same channel (ids from worker-context).
  mcp_catalog: volatile('catalog follows the live MCP registry', 'host-block'),
  apps: volatile('app connections change mid-session', 'host-block'),

  // ---- bot assembly sections (BotPromptAssembly / BOT_SECTION_CATALOG) ----
  // These are joined into ONE host block, so they all ride the system half.
  // They are registered here so the composition layer can name the bot's
  // section plan without importing the render-heavy catalog module.
  botIdentity: stable('bot persona; rendered by the bot assembly', 'bot-assembly', ['bot']),
  botCommsRules: stable('messaging rules; rendered by the bot assembly', 'bot-assembly', ['bot']),
  memoryUsage: stable('memory usage guidance; rendered by the bot assembly', 'bot-assembly', ['bot']),
  memoryOwn: stable('own-tier memory; rendered by the bot assembly', 'bot-assembly', ['bot']),
  memoryUser: stable('user-tier memory; rendered by the bot assembly', 'bot-assembly', ['bot']),
  memoryProject: stable('project-tier memory; rendered by the bot assembly', 'bot-assembly', ['bot']),
  botAutomations: stable('routines bound to this bot; rendered by the bot assembly', 'bot-assembly', ['bot']),
  botChannels: stable('connected channels; rendered by the bot assembly', 'bot-assembly', ['bot']),
  botRoster: stable('inter-agent roster; rendered by the bot assembly', 'bot-assembly', ['bot']),
  botTaskDelegation: stable('delegation contract; rendered by the bot assembly', 'bot-assembly', ['bot']),
};

/** Canonical order of the bot assembly's sections (mirrors BOT_SECTION_CATALOG). */
export const BOT_ASSEMBLY_SECTION_IDS: readonly string[] = Object.freeze([
  'botIdentity',
  'botCommsRules',
  'memoryUsage',
  'memoryOwn',
  'memoryUser',
  'memoryProject',
  'botAutomations',
  'botChannels',
  'botRoster',
  'botTaskDelegation',
]);

/** All section ids declared by one prompt-system config, in registry order. */
export function sectionsForConfig(configName: string): readonly string[] {
  return Object.entries(SECTION_PLACEMENTS)
    .filter(([, rule]) => rule.configs.includes(configName))
    .map(([sectionId]) => sectionId);
}

/**
 * Assert a config declares only registered sections.
 *
 * Called by the architecture test rather than at runtime: `PromptsRegistry`
 * also hosts throwaway test configs, and failing those at registration time
 * would turn a diagnostic into a behaviour change.
 */
export function unregisteredSections(
  configName: string,
  sectionIds: readonly string[],
): readonly string[] {
  return sectionIds.filter((sectionId) => SECTION_PLACEMENTS[sectionId] === undefined);
}

/**
 * Resolve the channel for one section.
 *
 * @throws when the config declares the opposite of the registered placement —
 * that is the drift this registry exists to stop.
 */
export function resolveSectionPlacement(
  sectionName: string,
  declared: PromptPlacement | undefined,
  configName: string,
): PromptPlacement {
  const rule = SECTION_PLACEMENTS[sectionName];
  if (!rule) return declared ?? 'system';

  if (declared !== undefined && declared !== rule.placement) {
    throw new Error(
      `PromptSystem '${configName}': section '${sectionName}' declares placement '${declared}' ` +
        `but the placement registry says '${rule.placement}' (${rule.reason}). ` +
        `Fix the config, or change the registry if the channel really moved.`,
    );
  }

  return rule.placement;
}
