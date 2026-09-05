/**
 * botRemoteBox — execution environment section for the bot prompt
 * (mirrors grok-bot's `remoteBoxSection`; Plan 474 P2.7).
 *
 * Grok-bot describes "ONE persistent Linux machine shared by all of this user's
 * agents — same filesystem and machine state" with Read/Shell/Browser/Computer
 * tools and CopyToBox/CopyFromBox for cross-machine file transfer.
 *
 * Duya's execution model is DIFFERENT:
 * - The agent runs as a child subprocess of the Electron main process
 * - Each bot has its own workspace directory (configurable, default ~/.duya/workspace)
 * - Files in the workspace persist across turns within the same session
 * - BashTool (shell access) and ReadTool are available
 * - No persistent shared "box" VM shared by all agents
 * - No CopyToBox/CopyFromBox cross-machine file transfer
 * - No Computer use (desktop automation)
 * - No Browser use (page-level automation)
 * - The user's files are accessible via absolute Windows paths
 *
 * This section describes duya's actual environment truthfully, without
 * claiming capabilities that don't exist.
 */

import type { BotPromptContext } from './framework.js'

const BUDGET_CHARS = 800

/**
 * Render the bot execution environment section.
 *
 * Returns null when ctx.workspace is absent (non-bot session or no workspace).
 */
export function renderBotRemoteBox(ctx: BotPromptContext): string | null {
  const workspace = ctx.workspace
  if (!workspace) return null

  const lines: string[] = []

  lines.push('## Execution environment')
  lines.push('')

  // Workspace description
  lines.push(
    [
      `You run as an agent subprocess in a desktop session. Your workspace is a`,
      `persistent working directory where files you write remain between turns:`,
    ].join(' '),
  )
  lines.push(`- **Workspace**: \`${truncatePath(workspace)}\``)
  lines.push(
    'Files you write here persist across this conversation. Read existing files to continue interrupted work.',
  )
  lines.push('')

  // Available tools
  lines.push('**Available tools**: BashTool (shell commands), Read (file reads), plus the other tools in your tool list.')
  lines.push('')

  // What is NOT available (important to mention for honesty)
  lines.push(
    '**Not available in this build**:',
  )
  lines.push(
    '  - No persistent shared machine shared by all agents (each agent has its own workspace)',
  )
  lines.push('  - No Computer use (pixel-level desktop automation)')
  lines.push('  - No Browser use (page-level automation)')
  lines.push('  - No CopyToBox / CopyFromBox cross-machine file transfer')
  lines.push(
    '  - No sandboxed "box" environment — you run in the desktop app\'s agent subprocess',
  )
  lines.push('')

  // User file access
  lines.push(
    '**User files**: The user\'s files are accessible via absolute Windows paths (e.g. `E:\\Projects\\...`). Use Read or BashTool to access them.',
  )

  return lines.join('\n')
}

function truncatePath(p: string, maxLen = 60): string {
  if (p.length <= maxLen) return p
  const sep = p.includes('\\') ? '\\' : '/'
  const parts = p.split(sep)
  if (parts.length <= 2) return '…' + p.slice(-(maxLen - 1))
  // Show first + last part
  return parts[0] + sep + '…' + sep + parts[parts.length - 1]
}
