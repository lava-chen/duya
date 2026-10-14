/**
 * Mapper for the duya-desktop-context-code module — Plan 551.
 *
 * The Automations subsection appears only when the duya_cli control-plane
 * tool is enabled (same heuristic the legacy code-profile section uses).
 */

import type { PromptContext } from '../../types.js'

export function mapDuyaDesktopContextCodeSlots(ctx: PromptContext): Record<string, unknown> {
  return {
    code_desktop_automations: ctx.enabledTools.has('duya_cli'),
  }
}
