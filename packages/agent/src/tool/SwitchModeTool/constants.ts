export const SWITCH_MODE_TOOL_NAME = 'SwitchMode'

export type AgentMode = 'general' | 'plan' | 'explore' | 'verify' | 'code-review'

export const ALL_MODES: AgentMode[] = ['general', 'plan', 'explore', 'verify', 'code-review']

export const MODEDescriptions: Record<AgentMode, string> = {
  general: 'General purpose mode with full tool access',
  plan: 'Planning mode - read-only exploration and design',
  explore: 'Exploration mode - quick read-only code search',
  verify: 'Verification mode - read-only testing and validation',
  'code-review': 'Code review mode - read-only code inspection',
}