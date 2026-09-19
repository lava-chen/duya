/**
 * Prompt module registry — Plan 551.
 *
 * One registry entry per authored content module under
 * `assets/modules/*.hbs`. A module is a profile-independent block of
 * prompt content; profiles assemble them via `PromptSystemConfig.staticModules`
 * instead of maintaining per-profile section trees.
 *
 * Two contracts live side by side in the prompt asset tree (plan 551 D1):
 *  - authored modules (`assets/modules/`): human-written text, rendered with
 *    assembly-time params (e.g. identity variants). The render is a pure
 *    function of PromptContext + params.
 *  - context-fed modules (`assets/dynamic/`): runtime-computed sections that
 *    need preBuildHook plumbing. Those stay registered in configs by their
 *    asset path; a physical directory merge is an optional Phase 4 cleanup
 *    and is intentionally deferred.
 *
 * The registry exists so that:
 *  - config references are type-checked (`ModuleName`), turning a template
 *    rename into a compile error instead of a runtime render throw;
 *  - module params have a typed home (`StaticModuleRef.params`);
 *  - per-module mapper logic has a place to live when a module carries
 *    contract logic (plan 551 D2: TS follows the contract, not the module
 *    count — pure-authored modules get no TS file beyond this registry).
 *
 * @see docs/exec-plans/active/551-prompt-module-flatten.md
 */

import type { PromptContext } from '../types.js'
import { mapProjectInstructionSlots } from './mappers/project.js'
import { mapIdentityCodingSlots } from './mappers/identityCoding.js'
import { mapSystemCodingSlots } from './mappers/systemCoding.js'
import { mapRulesSlots } from './mappers/rules.js'
import { mapDuyaDesktopContextCodeSlots } from './mappers/duyaDesktopContextCode.js'
import { mapGatewayIntroSlots } from './mappers/gatewayIntro.js'
import { mapResearchProfileSlots } from './mappers/researchProfile.js'

export interface PromptModuleDef {
  /** Asset path relative to the prompts assets root. */
  path: string
  /** One-line description of the content block. */
  description: string
  /**
   * Per-render context slots for modules whose content depends on runtime
   * state (tool availability, platform names, AGENTS.md index). The slot
   * provider is the module's mapper home (plan 551 D2): it precomputes
   * template variables so `.hbs` files branch on precomputed booleans and
   * prebuilt strings instead of new Handlebars helpers (plan 551 D3).
   * Pure-authored modules omit this field.
   */
  slots?: (context: PromptContext) => Record<string, unknown>
}

/**
 * Registry of authored content modules.
 *
 * Keys double as the section name used for profile gating
 * (`isSectionEnabled`) and prompt-cache keys, so they intentionally match
 * the legacy `staticSections` names the agent profiles already reference
 * (e.g. `duyaDesktopContext` in agent-profile enable/disable lists).
 */
export const MODULES = {
  identity: {
    path: 'modules/identity.hbs',
    description: 'Agent identity, self-management, and multi-agent network posture',
  },
  system: {
    path: 'modules/system.hbs',
    description: 'System-surface rules (output visibility, permissions, untrusted data)',
  },
  destructiveActions: {
    path: 'modules/destructive-actions.hbs',
    description: 'Guardrails for destructive commands and API calls',
  },
  configProtection: {
    path: 'modules/config-protection.hbs',
    description: 'Protection of ~/.duya/config.toml and secrets.json',
  },
  communication: {
    path: 'modules/communication.hbs',
    description: 'Output efficiency, writing, and technical communication style',
  },
  tools: {
    path: 'modules/tools.hbs',
    description: 'Tool-usage guidance (REPL-aware, todo-tool aware)',
  },
  tasks: {
    path: 'modules/tasks.hbs',
    description: 'Doing-tasks guidance (read before editing, background work)',
  },
  skillUsage: {
    path: 'modules/skill-usage.hbs',
    description: 'How to discover and load skills',
  },
  duyaDesktopContext: {
    path: 'modules/duya-desktop-context.hbs',
    description: 'Desktop-app-only capabilities (media, widgets, automations)',
  },
  finalAnswer: {
    path: 'modules/final-answer.hbs',
    description: 'Final-answer formatting, version-control links, visualizations',
  },
  projectContinuity: {
    path: 'modules/project-continuity.hbs',
    description: 'Long-horizon project continuity guidance',
  },
  projectInstructions: {
    path: 'modules/project-instructions.hbs',
    description: 'AGENTS.md instruction-file index (user-layer context)',
    slots: mapProjectInstructionSlots,
  },
  project: {
    path: 'modules/project.hbs',
    description: 'Composite: continuity + AGENTS.md index (gateway assembly)',
    slots: mapProjectInstructionSlots,
  },
  identityCoding: {
    path: 'modules/identity-coding.hbs',
    description: 'Code-profile identity paragraph with inline output-style clause',
    slots: mapIdentityCodingSlots,
  },
  systemCoding: {
    path: 'modules/system-coding.hbs',
    description: 'Code-profile operating rules with capability bullets (regex pass)',
    slots: mapSystemCodingSlots,
  },
  personality: {
    path: 'modules/personality.hbs',
    description: 'Code-profile voice and rhythm (gated by keepCodingInstructions)',
  },
  workingWithTheUser: {
    path: 'modules/working-with-the-user.hbs',
    description: 'Code-profile multi-channel output and final-answer contract',
  },
  rules: {
    path: 'modules/rules.hbs',
    description: 'Code-profile operating rules (todo-tool and search-tool aware)',
    slots: mapRulesSlots,
  },
  duyaDesktopContextCode: {
    path: 'modules/duya-desktop-context-code.hbs',
    description: 'Code-profile desktop context (legacy hard-wrapped wording)',
    slots: mapDuyaDesktopContextCodeSlots,
  },
  intro: {
    path: 'modules/intro.hbs',
    description: 'Gateway channel identity opener (platform-name aware)',
    slots: mapGatewayIntroSlots,
  },
  gatewayRole: {
    path: 'modules/gateway-role.hbs',
    description: 'Gateway channel-agent behavioural constraints',
  },
  toneAndStyle: {
    path: 'modules/tone-and-style.hbs',
    description: 'Tone and style; gateway adds the never-analysis paragraph via params',
  },
  researchProfile: {
    path: 'modules/research-profile.hbs',
    description: 'Research agent identity and evidence discipline (language-aware)',
    slots: mapResearchProfileSlots,
  },
  taskIntent: {
    path: 'modules/task-intent.hbs',
    description: 'Research task-intent routing policy',
  },
  evidencePolicy: {
    path: 'modules/evidence-policy.hbs',
    description: 'Research evidence policy and fabrication ban',
  },
  memoryWriteProposal: {
    path: 'modules/memory-write-proposal.hbs',
    description: 'Research memory write policy (hypothesis auto-update procedure)',
  },
} as const satisfies Record<string, PromptModuleDef>

/** Registry key of an authored content module. */
export type ModuleName = keyof typeof MODULES

/**
 * A static-module assembly reference in a `PromptSystemConfig`.
 *
 * Normalizes onto the legacy `SectionDef` machinery (profile gating,
 * prompt-cache keying, empty-collapse) with the module's .hbs render as the
 * content source, so switching a config from `staticSections` to
 * `staticModules` preserves cache-invalidation and agent-profile gating
 * semantics exactly.
 */
export interface StaticModuleRef {
  /** Registry key of the module to render. */
  module: ModuleName
  /**
   * Section name used for profile gating and prompt-cache keys.
   * Defaults to the module name; set it explicitly only when a config
   * needs a legacy gating name that differs from the module key.
   */
  name?: string
  /**
   * Extra template variables merged over the base mapper output.
   * Variant params live here (e.g. `{ variant: 'compact' }`); templates
   * branch on precomputed booleans supplied by mapper/params, not on new
   * Handlebars helpers (plan 551 D3).
   */
  params?: Record<string, unknown>
  /**
   * Optional config-side content gate evaluated per render, before the
   * module renders. Returning false collapses the section to null (same
   * as a legacy `compute` returning null), e.g. the gateway skill-usage
   * section only renders when the SKILL tool is enabled. Profile-level
   * gating (`isSectionEnabled`) stays separate and keeps working.
   */
  enabledWhen?: (context: PromptContext) => boolean
  /** Skip isSectionEnabled filtering (same semantics as SectionDef). */
  bypassProfile?: boolean
}
