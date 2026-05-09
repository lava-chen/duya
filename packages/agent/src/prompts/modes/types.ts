/**
 * PromptMode type definitions
 * Base modes + overlays for progressive disclosure of prompt sections
 */

/**
 * Base prompt modes - only 3 to avoid mode explosion
 * - full: Main agent (governance + execution). Includes governance prompts: skills/memory/session guidance
 * - minimal: Execution subagent/worker. Keeps only essential constraints and tool usage, removes governance
 * - bare: Ultra-lean mode (strong constraints, controlled use). Still retains minimal safety and tool boundaries
 */
export type PromptBaseMode = 'full' | 'minimal' | 'bare'

/**
 * Overlay: small adjustments that don't introduce new top-level semantics
 * - coding: Emphasizes code quality/constraints (e.g. keeps taskHandling, outputEfficiency)
 * - chat: Emphasizes conversation experience (e.g. weakens verbose tool instructions, strengthens toneAndStyle)
 */
export type PromptOverlay = 'coding' | 'chat' | 'conductor'

/**
 * Prompt configuration: converges "top-level concepts" into base + overlays
 */
export interface PromptProfile {
  base: PromptBaseMode
  overlays?: PromptOverlay[]
  /**
   * For internal "small overrides" only, not an external concept.
   * Goal is to avoid turning the prompt system into a configuration table platform.
   */
  overrides?: Partial<{
    enableSections: string[]
    disableSections: string[]
  }>
}

/**
 * Section set configuration for a base mode
 */
export interface SectionSetConfig {
  enable: string[]
  disable: string[]
}

/**
 * Overlay patch configuration
 */
export interface OverlayPatchConfig {
  enable?: string[]
  disable?: string[]
}
