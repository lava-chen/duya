/**
 * Code Agent Capability Section
 *
 * Conditionally inject guidance paragraphs based on which capability tools
 * the agent actually has access to. Replaces hardcoded "hooks / permission
 * mode / context compression" prose that previously lived in the system
 * section regardless of whether the tools were enabled.
 */

import type { PromptContext } from '../../../types.js'

interface Capability {
  id: 'settings' | 'hooks' | 'permission' | 'compact'
  label: string
  patterns: RegExp[]
  body: string
}

const CAPABILITIES: Capability[] = [
  {
    id: 'settings',
    label: 'self-managed settings',
    patterns: [/^settings/i, /^duya:config/i, /^duya:settings/i, /^duya_config/i],
    body: 'You can read and manage your own settings — no need to ask the user to open the settings UI. Proactively use these tools when the user asks about configuration.',
  },
  {
    id: 'hooks',
    label: 'hooks',
    patterns: [/^hooks/i, /^hook_/i, /duya:hook/i, /^Hook/i],
    body: "Users may configure 'hooks', shell commands that execute in response to events like tool calls, in settings. Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user. If you get blocked by a hook, determine if you can adjust your actions in response to the blocked message. If not, ask the user to check their hooks configuration.",
  },
  {
    id: 'permission',
    label: 'permission mode',
    patterns: [/^permission/i, /^permission_mode/i, /^permissionMode/i],
    body: "Tools are executed in a user-selected permission mode. When you attempt to call a tool that is not automatically allowed by the user's permission mode or permission settings, the user will be prompted so that they can approve or deny the execution. If the user denies a tool you call, do not re-attempt the exact same tool call. Instead, think about why the user has denied the tool call and adjust your approach.",
  },
  {
    id: 'compact',
    label: 'context compression',
    patterns: [/^compact/i, /^compact_context/i, /^compactContext/i],
    body: 'The system will automatically compress prior messages in your conversation as it approaches context limits. This means your conversation with the user is not limited by the context window.',
  },
]

function hasCapability(enabledTools: Set<string>, capability: Capability): boolean {
  if (enabledTools.size === 0) return false
  for (const tool of enabledTools) {
    for (const re of capability.patterns) {
      if (re.test(tool)) return true
    }
  }
  return false
}

/**
 * Return a list of capability paragraphs that should be included for the
 * current context, based on the actual enabled tool set.
 *
 * Returns an empty array if no capability tools are enabled — callers should
 * treat that case as "no extra guidance needed", not as an error.
 */
export function getCodeCapabilityGuidance(ctx: PromptContext): string[] {
  const enabled = ctx.enabledTools ?? new Set<string>()
  const paragraphs: string[] = []
  for (const cap of CAPABILITIES) {
    if (hasCapability(enabled, cap)) {
      paragraphs.push(cap.body)
    }
  }
  return paragraphs
}

/**
 * Convenience: assemble capability paragraphs into a single string with
 * consistent bullet formatting. Returns `null` when no paragraphs apply,
 * which the caller can use to omit the block entirely.
 */
export function getCodeCapabilityGuidanceBlock(ctx: PromptContext): string | null {
  const items = getCodeCapabilityGuidance(ctx)
  if (items.length === 0) return null
  return items.map(item => ` - ${item}`).join('\n')
}
