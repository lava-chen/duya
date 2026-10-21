/**
 * DUYA Banner - Modern CLI with Gradient Style
 *
 * ASCII art and visual identity for DUYA Agent
 * Features purple-blue gradient colors inspired by modern CLI tools
 */

import chalk from 'chalk'

// Version info
const VERSION = '0.2.0'
const RELEASE_DATE = '2026-04-13'

/**
 * Check if color output is available
 */
function shouldUseColors(): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.TERM === 'dumb') return false
  if (!process.stdout.isTTY) return false
  return true
}

/**
 * Gradient colors from purple to blue
 */
function gradient(text: string): string {
  if (!shouldUseColors()) return text

  // Purple to Blue gradient using ANSI 256-color
  const colors = [
    '\x1b[38;5;129m',  // purple
    '\x1b[38;5;135m',  // violet
    '\x1b[38;5;141m',  // blue violet
    '\x1b[38;5;75m',   // blue
    '\x1b[38;5;39m',   // cyan blue
    '\x1b[38;5;45m',   // cyan
  ]

  const chars = text.split('')
  const totalChars = chars.length

  let result = ''
  chars.forEach((char, i) => {
    const progress = i / Math.max(totalChars - 1, 1)
    const colorIndex = Math.min(Math.floor(progress * (colors.length - 1)), colors.length - 2)
    const localProgress = (progress * (colors.length - 1)) - colorIndex

    // Blend between two adjacent colors
    result += colors[colorIndex] + char
  })

  return result + '\x1b[0m'
}

/**
 * DUYA ASCII Art Logo - Modern geometric style
 */
const DUYA_LOGO_LINES = [
  ' ░▒▓███████▓▒░░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓██████▓▒░',
  ' ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░',
  ' ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░',
  ' ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░░▒▓██████▓▒░░▒▓████████▓▒░',
  ' ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░  ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░',
  ' ░▒▓█▓▒░░▒▓█▓▒░▒▓█▓▒░░▒▓█▓▒░  ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░',
  ' ░▒▓███████▓▒░ ░▒▓██████▓▒░   ░▒▓█▓▒░   ░▒▓█▓▒░░▒▓█▓▒░'                    
]

/**
 * Format version label
 */
function formatVersionLabel(): string {
  return `v${VERSION} (${RELEASE_DATE})`
}

/**
 * Build info panel
 */
function buildInfoPanel(options: {
  model: string
  workspace: string
  sessionId?: string
}): string {
  const { model, workspace, sessionId } = options

  const modelShort = model.split('/').pop() || model
  const wsShort = workspace.length > 38 ? '...' + workspace.slice(-35) : workspace

  const lines: string[] = []

  // Top border
  lines.push(chalk.dim('  ┌────────────────────────────────────────────────────────┐'))

  // Model line
  const modelContent = `${chalk.cyan('Model:')} ${chalk.white(modelShort)}`
  const modelPadding = Math.max(0, 46 - modelContent.length)
  lines.push(`  │ ${modelContent}${' '.repeat(modelPadding)}${chalk.dim('│')}`)

  // Workspace line
  const wsContent = `${chalk.cyan('Workspace:')} ${chalk.yellow(wsShort)}`
  const wsPadding = Math.max(0, 46 - wsContent.length)
  lines.push(`  │ ${wsContent}${' '.repeat(wsPadding)}${chalk.dim('│')}`)

  // Session line (if provided)
  if (sessionId) {
    const sid = sessionId.slice(0, 8)
    const sessionContent = `${chalk.cyan('Session:')} ${chalk.magenta(sid)}`
    const sessionPadding = Math.max(0, 46 - sessionContent.length)
    lines.push(`  │ ${sessionContent}${' '.repeat(sessionPadding)}${chalk.dim('│')}`)
  }

  // Bottom border
  lines.push(chalk.dim('  └────────────────────────────────────────────────────────┘'))

  return lines.join('\n')
}

/**
 * Print welcome banner to console
 */
export function printWelcomeBanner(options: {
  model: string
  workspace: string
  sessionId?: string
  toolCount: number
  skillCount?: number
  mcpServers?: Array<{ name: string; connected: boolean; toolCount: number }>
}): void {
  const {
    model,
    workspace,
    sessionId,
    toolCount,
    skillCount = 0,
    mcpServers = [],
  } = options

  // Print logo with gradient
  console.log('')
  for (const line of DUYA_LOGO_LINES) {
    console.log(gradient(line))
  }
  console.log('')

  // Version
  console.log(chalk.dim(`  DUYA Agent ${formatVersionLabel()}`))
  console.log('')

  // Info panel
  console.log(buildInfoPanel({ model, workspace, sessionId }))
  console.log('')

  // Summary line
  const summaryParts: string[] = []
  summaryParts.push(`${chalk.white(toolCount)} tools`)
  if (skillCount > 0) summaryParts.push(`${chalk.white(skillCount)} skills`)
  if (mcpServers.length > 0) {
    const connected = mcpServers.filter(s => s.connected).length
    summaryParts.push(`${connected}/${mcpServers.length} MCP`)
  }

  console.log(`  ${summaryParts.join(chalk.dim(' · '))} ${chalk.dim('·')} ${chalk.cyan('/help')} for commands`)
  console.log('')
}

/**
 * Build welcome banner as string (for programmatic use)
 */
export function buildWelcomeBanner(options: {
  model: string
  workspace: string
  sessionId?: string
  toolCount: number
  skillCount?: number
  mcpServers?: Array<{ name: string; connected: boolean; toolCount: number }>
}): string {
  const {
    model,
    workspace,
    sessionId,
    toolCount,
    skillCount = 0,
    mcpServers = [],
  } = options

  const lines: string[] = []

  // Logo
  lines.push('')
  for (const line of DUYA_LOGO_LINES) {
    lines.push(gradient(line))
  }
  lines.push('')

  // Version
  lines.push(chalk.dim(`  DUYA Agent ${formatVersionLabel()}`))
  lines.push('')

  // Info panel
  lines.push(buildInfoPanel({ model, workspace, sessionId }))
  lines.push('')

  // Summary
  const summaryParts: string[] = []
  summaryParts.push(`${chalk.white(toolCount)} tools`)
  if (skillCount > 0) summaryParts.push(`${chalk.white(skillCount)} skills`)
  if (mcpServers.length > 0) {
    const connected = mcpServers.filter(s => s.connected).length
    summaryParts.push(`${connected}/${mcpServers.length} MCP`)
  }

  lines.push(`  ${summaryParts.join(chalk.dim(' · '))} ${chalk.dim('·')} ${chalk.cyan('/help')} for commands`)
  lines.push('')

  return lines.join('\n')
}

export default {
  printWelcomeBanner,
  buildWelcomeBanner,
  gradient,
}