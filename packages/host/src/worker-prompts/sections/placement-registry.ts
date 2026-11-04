/**
 * Plan 624 D1 — the single source of truth for a section's delivery channel.
 *
 * Before this file, `placement` was declared independently by each config
 * (`general.ts`, `code.ts`, `research.ts`, `bot.ts`, `project.ts`). Nothing
 * prevented the same section from riding the system channel in one config and
 * the context channel in another, which would change which bytes are stable
 * per profile — a silent prompt-cache regression that no test would see.
 *
 * The registry now owns the decision:
 *   - a registered section always uses the registered placement;
 *   - a config that declares the other placement fails loudly instead of
 *     drifting;
 *   - an unregistered section keeps its declaration, so adding a section does
 *     not require touching this table first (the test suite reports the gap).
 */
import type { PromptPlacement } from '../types.js';

export interface SectionPlacementRule {
  readonly placement: PromptPlacement;
  /** Why this channel — one line, so the next reader does not have to guess. */
  readonly reason: string;
}

const stable = (reason: string): SectionPlacementRule => ({ placement: 'system', reason });
const volatile = (reason: string): SectionPlacementRule => ({ placement: 'context', reason });

export const SECTION_PLACEMENTS: Readonly<Record<string, SectionPlacementRule>> = {
  // ---- system half: must stay byte-identical across turns ----
  identity: stable('authored identity; never changes mid-session'),
  system: stable('core operating guidance'),
  destructiveActions: stable('safety policy'),
  configProtection: stable('safety policy'),
  tools: stable('tool-usage guidance; tool NAMES change through the catalog channel, not this text'),
  tasks: stable('task-tracking guidance'),
  skillUsage: stable('skill invocation guidance'),
  duyaDesktopContext: stable('desktop capability description'),
  finalAnswer: stable('output contract'),
  platform: stable('per-platform guidance, fixed for the session'),
  scratchpad: stable('scratchpad location guidance'),

  identityCoding: stable('coding identity'),
  systemCoding: stable('coding guidance'),
  duyaDesktopContextCode: stable('desktop capability description for coding sessions'),
  projectContinuity: stable('project continuity guidance'),
  personality: stable('tone'),
  workingWithTheUser: stable('collaboration rules'),
  rules: stable('hard rules'),
  researchProfile: stable('research identity'),
  taskIntent: stable('intent classification guidance'),
  evidencePolicy: stable('evidence standard'),
  memoryWriteProposal: stable('memory proposal format'),
  toneAndStyle: stable('tone'),

  // Coordinator composition (plan 624 scope=coordinator). Identity is stable
  // because `suppressIdentityBlock` relies on the prompt's own opening section
  // taking that role.
  projectIdentity: stable('coordinator identity; opens the prompt'),
  projectOperation: stable('coordinator tool-usage guidance'),
  projectDelegation: stable('delegation rules'),
  projectReporting: stable('reporting contract'),

  // ---- context half: re-rendered per build and delivered as a message ----
  environment: volatile('cwd / branch / date can change every turn'),
  mcp: volatile('MCP servers connect and disconnect mid-session'),
  skills: volatile('skill catalog changes when skills are installed'),
  memory: volatile('memory projection is rewritten by the background worker'),
  sessionGuidance: volatile('depends on live session history'),
  vision: volatile('depends on whether the current turn carries images'),
  outputFormat: volatile('depends on the research intent resolved for the request'),

  // Host blocks that ride the same channel (ids from worker-context).
  mcp_catalog: volatile('catalog follows the live MCP registry'),
  apps: volatile('app connections change mid-session'),
};

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
