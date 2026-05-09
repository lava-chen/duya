/**
 * Session commands for CLI
 *
 * Implements session list, continue, delete, and export functionality
 */

import { Colors, color } from './colors.js'
import { selectFromNumberedList, printSuccess, printError, printHeader } from './interactive.js'

// Session interfaces (should match the actual DB schema)
export interface SessionInfo {
  id: string
  createdAt: number
  lastActiveAt: number
  messageCount: number
  workspace: string
  model: string
  title?: string
}

/**
 * List recent sessions
 */
export async function listSessions(sessions: SessionInfo[]): Promise<void> {
  if (sessions.length === 0) {
    console.log(color('  No sessions found', Colors.DIM))
    return
  }

  printHeader('Recent Sessions')

  sessions.forEach((session, index) => {
    const date = new Date(session.createdAt * 1000)
    const dateStr = date.toISOString().slice(0, 10)
    const title = session.title || 'Untitled'
    const marker = index === 0 ? '❯' : ' '
    const num = String(index + 1).padStart(2, ' ')

    console.log(color(`  ${marker} ${num}.`, Colors.WHITE) +
      color(` [${dateStr}]`, Colors.DIM) +
      color(` "${title}"`, Colors.BRIGHT_CYAN) +
      color(` - ${session.messageCount} messages`, Colors.DIM) +
      color(` - ${session.model.split('/').pop()}`, Colors.DIM))
  })
  console.log('')
}

/**
 * Select and continue a session
 */
export async function selectSession(
  sessions: SessionInfo[],
  defaultIndex = 0
): Promise<SessionInfo | null> {
  if (sessions.length === 0) {
    printError('No sessions to continue')
    return null
  }

  // If only one session, auto-select it
  if (sessions.length === 1) {
    return sessions[0]
  }

  const result = await selectFromNumberedList(
    sessions,
    (session, index) => {
      const date = new Date(session.createdAt * 1000)
      const dateStr = date.toISOString().slice(0, 10)
      const title = session.title || 'Untitled'
      const defaultMarker = index === defaultIndex ? ' (default)' : ''
      return `[${dateStr}] "${title}" - ${session.messageCount} msgs${defaultMarker}`
    },
    defaultIndex
  )

  return result?.selected ?? null
}

/**
 * Format session for display
 */
export function formatSession(session: SessionInfo): string {
  const date = new Date(session.createdAt * 1000)
  const dateStr = date.toISOString().slice(0, 10)
  const timeStr = date.toISOString().slice(11, 19)
  const title = session.title || 'Untitled'
  const model = session.model.split('/').pop() || session.model

  return `${dateStr} ${timeStr} | "${title}" | ${session.messageCount} msgs | ${model}`
}

export default {
  listSessions,
  selectSession,
  formatSession,
}