/**
 * Mapper for the system-coding module — Plan 551.
 *
 * The code profile's system section appends capability bullets when any
 * enabled tool name matches a capability's patterns (regex pass over the
 * tool set). The mapper owns the pattern matching and emits precomputed
 * booleans; the bullet text lives in the template.
 */

import type { PromptContext } from '../../types.js'

const CAPABILITY_PATTERNS = {
  settings: [/^settings/i, /^duya:config/i, /^duya:settings/i, /^duya_config/i],
  hooks: [/^hooks/i, /^hook_/i, /duya:hook/i, /^Hook/i],
  permission: [/^permission/i, /^permission_mode/i, /^permissionMode/i],
  compact: [/^compact/i, /^compact_context/i, /^compactContext/i],
} as const

function matchesAny(enabled: Set<string>, patterns: readonly RegExp[]): boolean {
  if (enabled.size === 0) return false
  for (const tool of enabled) {
    for (const re of patterns) {
      if (re.test(tool)) return true
    }
  }
  return false
}

export function mapSystemCodingSlots(ctx: PromptContext): Record<string, unknown> {
  const enabled = ctx.enabledTools ?? new Set<string>()
  return {
    system_capability_settings: matchesAny(enabled, CAPABILITY_PATTERNS.settings),
    system_capability_hooks: matchesAny(enabled, CAPABILITY_PATTERNS.hooks),
    system_capability_permission: matchesAny(enabled, CAPABILITY_PATTERNS.permission),
    system_capability_compact: matchesAny(enabled, CAPABILITY_PATTERNS.compact),
  }
}
