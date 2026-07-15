import type { ChatSession } from './db.js'
import { listSessionsAsync } from './db.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_SAME_PROJECT_LOOKBACK_MS = 14 * DAY_MS
const DEFAULT_OTHER_PROJECT_LOOKBACK_MS = 7 * DAY_MS

export type SessionDirectoryScope = 'same_project' | 'other_projects' | 'all'

export interface RecentSessionDirectoryEntry {
  sessionId: string
  title: string
  projectName: string
  updatedAt: number
  childCount: number
  agentType: string
}

export interface RecentSessionDirectory {
  sameProject: RecentSessionDirectoryEntry[]
  otherProjects: RecentSessionDirectoryEntry[]
}

export interface RecentSessionDirectoryOptions {
  currentSessionId?: string | null
  workingDirectory: string
  sameProjectLimit?: number
  otherProjectLimit?: number
  sameProjectLookbackMs?: number
  otherProjectLookbackMs?: number
  now?: number
}

interface SessionLineage {
  root: ChatSession
  latest: ChatSession
  updatedAt: number
  childCount: number
}

export function normalizeProjectDirectory(directory: string | null | undefined): string {
  const normalized = (directory ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')

  if (!normalized) return ''

  // Windows drive paths are case-insensitive even when tests run elsewhere.
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function sanitizeSessionMetadata(
  value: string | null | undefined,
  fallback: string,
): string {
  const sanitized = (value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

  return sanitized || fallback
}

function projectNameFromDirectory(directory: string): string {
  const normalized = normalizeProjectDirectory(directory)
  const finalSegment = normalized.split('/').filter(Boolean).at(-1)
  return sanitizeSessionMetadata(finalSegment, 'Unknown project')
}

function getParentId(session: ChatSession): string | null {
  return session.parent_id ?? session.parent_session_id ?? null
}

function timestampMs(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 10_000_000_000 ? value * 1000 : value
}

export function matchesSessionDirectoryScope(
  sessionWorkingDirectory: string | null | undefined,
  currentWorkingDirectory: string | null | undefined,
  scope: SessionDirectoryScope,
): boolean {
  const sessionProject = normalizeProjectDirectory(sessionWorkingDirectory)
  const currentProject = normalizeProjectDirectory(currentWorkingDirectory)

  if (!sessionProject) return false
  if (scope === 'same_project') return Boolean(currentProject) && sessionProject === currentProject
  if (scope === 'other_projects') return sessionProject !== currentProject
  return true
}

function resolveRootId(sessionId: string, sessionsById: Map<string, ChatSession>): string {
  const visited = new Set<string>()
  let currentId = sessionId

  while (!visited.has(currentId)) {
    visited.add(currentId)
    const current = sessionsById.get(currentId)
    if (!current) break
    const parentId = getParentId(current)
    if (!parentId || !sessionsById.has(parentId)) break
    currentId = parentId
  }

  return currentId
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(10, Math.floor(value)))
}

function cutoff(now: number, lookbackMs: number | undefined, fallback: number): number {
  const window = lookbackMs ?? fallback
  return Number.isFinite(window) ? now - Math.max(0, window) : Number.NEGATIVE_INFINITY
}

function toDirectoryEntry(lineage: SessionLineage): RecentSessionDirectoryEntry {
  const workingDirectory = lineage.root.working_directory || lineage.latest.working_directory || ''
  const rootTitle = lineage.root.title && lineage.root.title !== 'New Chat'
    ? lineage.root.title
    : lineage.latest.title

  return {
    sessionId: lineage.root.id,
    title: sanitizeSessionMetadata(rootTitle, 'Untitled'),
    projectName: sanitizeSessionMetadata(
      lineage.root.project_name || lineage.latest.project_name,
      projectNameFromDirectory(workingDirectory),
    ),
    updatedAt: lineage.updatedAt,
    childCount: lineage.childCount,
    agentType: sanitizeSessionMetadata(lineage.root.agent_type, 'main'),
  }
}

export function buildRecentSessionDirectory(
  sessions: ChatSession[],
  options: RecentSessionDirectoryOptions,
): RecentSessionDirectory {
  const visibleSessions = sessions.filter(session => session.is_deleted !== 1 && Boolean(session.id))
  const sessionsById = new Map(visibleSessions.map(session => [session.id, session]))
  const currentRootId = options.currentSessionId
    ? resolveRootId(options.currentSessionId, sessionsById)
    : null
  const lineages = new Map<string, SessionLineage>()

  for (const session of visibleSessions) {
    const rootId = resolveRootId(session.id, sessionsById)
    if (currentRootId && rootId === currentRootId) continue

    const root = sessionsById.get(rootId) ?? session
    const existing = lineages.get(rootId)
    if (!existing) {
      lineages.set(rootId, {
        root,
        latest: session,
        updatedAt: timestampMs(session.updated_at),
        childCount: session.id === rootId ? 0 : 1,
      })
      continue
    }

    const sessionUpdatedAt = timestampMs(session.updated_at)
    if (sessionUpdatedAt > existing.updatedAt) {
      existing.latest = session
      existing.updatedAt = sessionUpdatedAt
    }
    if (session.id !== rootId) existing.childCount += 1
  }

  const now = options.now ?? Date.now()
  const sameProjectCutoff = cutoff(now, options.sameProjectLookbackMs, DEFAULT_SAME_PROJECT_LOOKBACK_MS)
  const otherProjectCutoff = cutoff(now, options.otherProjectLookbackMs, DEFAULT_OTHER_PROJECT_LOOKBACK_MS)
  const sameProject: RecentSessionDirectoryEntry[] = []
  const otherProjects: RecentSessionDirectoryEntry[] = []

  for (const lineage of lineages.values()) {
    const directory = lineage.root.working_directory || lineage.latest.working_directory || ''
    if (!normalizeProjectDirectory(directory)) continue

    const entry = toDirectoryEntry(lineage)
    if (matchesSessionDirectoryScope(directory, options.workingDirectory, 'same_project')) {
      if (entry.updatedAt >= sameProjectCutoff) sameProject.push(entry)
    } else if (entry.updatedAt >= otherProjectCutoff) {
      otherProjects.push(entry)
    }
  }

  sameProject.sort((a, b) => b.updatedAt - a.updatedAt)
  otherProjects.sort((a, b) => b.updatedAt - a.updatedAt)

  return {
    sameProject: sameProject.slice(0, boundedLimit(options.sameProjectLimit, 5)),
    otherProjects: otherProjects.slice(0, boundedLimit(options.otherProjectLimit, 3)),
  }
}

export async function loadRecentSessionDirectory(
  options: RecentSessionDirectoryOptions,
): Promise<RecentSessionDirectory> {
  return buildRecentSessionDirectory(await listSessionsAsync(), options)
}
