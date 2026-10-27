/**
 * Tier memory file reader (Plan 479 Phase 2, P2.1).
 *
 * Reads the three memory tiers straight from the file manifest — the
 * source of truth per the Plan 479 P1.0 decision. Scan scope mirrors the
 * Plan 481 `tierWriter` shard layout (single-writer directories):
 *
 *   own    → `<duyaRoot>/agents/<agentId>/memory/**`
 *   user   → `<duyaRoot>/memory/{items,entities,global}/**` (legacy
 *            canonical frontmatter via parseCanonicalFile) plus the
 *            per-writer shards `<duyaRoot>/agents/<agentId>/user/**` the
 *            caller authorizes (own + explicit peer grants, framework
 *            plan S5 — a bot never scans every bot's shard)
 *   project→ `<duyaRoot>/projects/<projectId>/agents/<agentId>/**`
 *            (per-writer project shards; populated from Phase 3 on)
 *
 * Shard files carry the tierWriter frontmatter vocabulary
 * (canonical_key/claim_type/scope_id); legacy roots use the canonical
 * one. Project membership comes from
 * `<duyaRoot>/agents/<agentId>/state/projects.json` (the `state/` dir is
 * the Plan 485 reservation for bot state); absent file → not joined.
 *
 * Only `status: active` files are recallable; retired/superseded files
 * are history, not memory. A path tombstoned in the forget ledger is
 * skipped as well: the ledger is written before the file is retired, so a
 * crash in that window must not expose the fact (framework plan S5).
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { parseCanonicalFile } from '@duya/memory/canonical_file'
import { resolveUnlinkedMemoryPath } from '@duya/memory/memory_paths'
import { readForgottenPathsSync } from '@duya/memory/forget_ledger'
import { isSafeBotId, isSafeMemorySegment } from '@duya/bot'
import { normalizeKey } from './render.js'
import type { TierMemoryEntry } from './types.js'

/** Legacy user-tier scan roots, relative to the duya root. */
const USER_SCAN_ROOTS = ['memory/items', 'memory/entities', 'memory/global'] as const

/**
 * Paths tombstoned in the forget ledger (duya-root-relative).
 *
 * The ledger is written before the canonical file is retired, so a crash in
 * that window leaves the file `status: active` on disk. The tombstone is
 * what keeps it invisible in the meantime.
 */
function tombstonedPaths(duyaRoot: string): ReadonlySet<string> {
  return new Set(readForgottenPathsSync(path.join(duyaRoot, 'memory')))
}

interface RawTierFrontmatter {
  tier?: string
  kind?: string
  claim_type?: string
  dedupe_key?: string
  canonical_key?: string
  status?: string
  agent_profile_id?: string
  project_id?: string
  created_at?: string
  updated_at?: string
}

/** Minimal flat frontmatter parser (subset used by tier files). */
function parseTierFrontmatter(content: string): { meta: RawTierFrontmatter; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return null
  const frontmatter = match[1]
  const consumed = match[0]
  if (frontmatter === undefined || consumed === undefined) return null
  const meta: RawTierFrontmatter = {}
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line)
    const key = m?.[1]
    const value = m?.[2]
    if (key !== undefined && value !== undefined) {
      meta[key as keyof RawTierFrontmatter] = value.trim()
    }
  }
  return { meta, body: content.slice(consumed.length).trim() }
}

function walkMdFiles(dir: string, out: string[], duyaRoot: string): void {
  if (!resolveUnlinkedMemoryPath(duyaRoot, path.relative(duyaRoot, dir))) return
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(full)
    } catch {
      continue
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) continue
    if (stat.isDirectory()) walkMdFiles(full, out, duyaRoot)
    else if (stat.isFile() && entry.endsWith('.md')) out.push(full)
  }
}

function toRelPath(absolutePath: string, duyaRoot: string): string {
  return path.relative(duyaRoot, absolutePath).split(path.sep).join('/')
}

function parseTimestamp(raw: string | undefined, mtimeMs: number): number {
  if (raw) {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Math.trunc(mtimeMs)
}

function fileTitle(body: string, filePath: string): string {
  const heading = /^#\s+(.+)$/m.exec(body)
  const headingText = heading?.[1]
  if (headingText !== undefined) return headingText.trim()
  // TierWriter files carry the bare fact with no heading; the filename
  // slug is unreadable and duplicates the body line, so prefer the
  // first body line (formatEntry then renders the fact once).
  const firstLine = body
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? ''
  return firstLine || path.basename(filePath, '.md')
}

/**
 * Entry kind from either frontmatter vocabulary: tierWriter shards use
 * `claim_type` (profile|log|note), the older phase-3 contract used
 * `kind`. Anything else (legacy canonical claim_type like person/fact)
 * is a note.
 */
function tierKind(meta: RawTierFrontmatter): 'profile' | 'log' | 'note' {
  const raw = meta.kind ?? meta.claim_type
  return raw === 'profile' || raw === 'log' ? raw : 'note'
}

/**
 * Read one markdown file in the Phase 3 tier format (own tier and
 * per-writer shared shards). Files without the tier frontmatter are
 * skipped — the Phase 3 writer owns this contract.
 */
function readTierFile(
  filePath: string,
  duyaRoot: string,
  tier: MemoryTierPublic,
  fallbackWriter: string,
  fallbackProjectId: string,
  tombstoned: ReadonlySet<string>,
): TierMemoryEntry | null {
  const relPath = toRelPath(filePath, duyaRoot)
  if (tombstoned.has(relPath)) return null
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const parsed = parseTierFrontmatter(content)
  if (!parsed) return null
  const { meta, body } = parsed
  if (meta.status && meta.status !== 'active') return null
  const dedupeRaw = meta.dedupe_key ?? meta.canonical_key
  if (!dedupeRaw) return null
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return null
  }
  return {
    tier,
    kind: tierKind(meta),
    dedupeKey: normalizeKey(dedupeRaw),
    writerId: meta.agent_profile_id ?? fallbackWriter,
    projectId: meta.project_id ?? fallbackProjectId,
    filePath: relPath,
    title: fileTitle(body, filePath),
    body,
    createdAt: parseTimestamp(meta.created_at, stat.birthtimeMs),
    updatedAt: parseTimestamp(meta.updated_at, stat.mtimeMs),
  }
}

type MemoryTierPublic = TierMemoryEntry['tier']

/**
 * Own tier: the bot's private shard under `agents/<agentId>/memory/`.
 * Empty when the directory does not exist yet (no Phase 3 writes so far).
 */
export function readOwnTierEntries(duyaRoot: string, agentId: string): TierMemoryEntry[] {
  if (!isSafeBotId(agentId)) return []
  const dir = path.join(duyaRoot, 'agents', agentId, 'memory')
  const files: string[] = []
  walkMdFiles(dir, files, duyaRoot)
  const tombstoned = tombstonedPaths(duyaRoot)
  const entries: TierMemoryEntry[] = []
  for (const file of files) {
    const entry = readTierFile(file, duyaRoot, 'agent', agentId, '', tombstoned)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * User tier: the legacy canonical tree (`memory/items`, `entities`,
 * `global`) — canonical frontmatter files index as writerless notes —
 * plus the explicitly authorized per-writer shards
 * `agents/<agentId>/user/**` (tierWriter layout; the shard owner is the
 * writer).
 *
 * Plan S5: `shardIds` is the authorization boundary — the caller passes the
 * bot's own id plus any peer ids from `state/memory-access.json`. The
 * reader never enumerates the agents directory, so an ungranted peer shard
 * is invisible even if it exists on disk.
 */
export function readUserTierEntries(duyaRoot: string, shardIds: readonly string[]): TierMemoryEntry[] {
  const entries: TierMemoryEntry[] = []
  const tombstoned = tombstonedPaths(duyaRoot)
  for (const root of USER_SCAN_ROOTS) {
    const absRoot = path.join(duyaRoot, root)
    const files: string[] = []
    walkMdFiles(absRoot, files, duyaRoot)
    for (const file of files) {
      const relPath = toRelPath(file, duyaRoot)
      if (tombstoned.has(relPath)) continue
      const tierEntry = readTierFile(file, duyaRoot, 'user', '', '', tombstoned)
      if (tierEntry) {
        entries.push(tierEntry)
        continue
      }
      // Legacy canonical format.
      const canonical = parseCanonicalFile(file)
      if (!canonical || canonical.status !== 'active') continue
      let content = ''
      let stat: fs.Stats
      try {
        content = fs.readFileSync(file, 'utf8')
        stat = fs.statSync(file)
      } catch {
        continue
      }
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      entries.push({
        tier: 'user',
        kind: 'note',
        dedupeKey: normalizeKey(canonical.canonical_key),
        writerId: '',
        projectId: canonical.project_id ?? '',
        filePath: relPath,
        title: fileTitle(body, file),
        body,
        createdAt: parseTimestamp(undefined, stat.birthtimeMs),
        updatedAt: parseTimestamp(canonical.updated_at, stat.mtimeMs),
      })
    }
  }
  // Authorized per-writer user shards: agents/<agentId>/user/**.
  const seen = new Set<string>()
  for (const agentId of shardIds) {
    if (!isSafeBotId(agentId) || seen.has(agentId)) continue
    seen.add(agentId)
    const files: string[] = []
    walkMdFiles(path.join(duyaRoot, 'agents', agentId, 'user'), files, duyaRoot)
    for (const file of files) {
      const entry = readTierFile(file, duyaRoot, 'user', agentId, '', tombstoned)
      if (entry) entries.push(entry)
    }
  }
  return entries
}

/**
 * Project tier: per-writer shards `projects/<projectId>/agents/<agentId>/**`
 * for each joined id (Plan 481 tierWriter layout). The shard directory
 * name is the writer; unknown/unjoined ids are skipped by the
 * caller-provided list.
 */
export function readProjectTierEntries(duyaRoot: string, joinedProjectIds: string[]): TierMemoryEntry[] {
  const entries: TierMemoryEntry[] = []
  const tombstoned = tombstonedPaths(duyaRoot)
  for (const projectId of joinedProjectIds) {
    // Membership ids become path segments; drop anything unsafe (S5).
    if (!isSafeMemorySegment(projectId)) continue
    const shardsRoot = path.join(duyaRoot, 'projects', projectId, 'agents')
    let writerIds: string[]
    try {
      writerIds = fs.readdirSync(shardsRoot).filter((name) => {
        if (name.startsWith('.') || !isSafeMemorySegment(name)) return false
        try {
          return fs.statSync(path.join(shardsRoot, name)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      continue
    }
    for (const writerId of writerIds) {
      const files: string[] = []
      walkMdFiles(path.join(shardsRoot, writerId), files, duyaRoot)
      for (const file of files) {
        const entry = readTierFile(file, duyaRoot, 'project', writerId, projectId, tombstoned)
        if (entry) entries.push(entry)
      }
    }
  }
  return entries
}

/**
 * Project membership for a bot: `agents/<agentId>/state/projects.json`
 * (string array). Missing/corrupt file → not joined to anything.
 */
export function readJoinedProjects(duyaRoot: string, agentId: string): string[] {
  if (!isSafeBotId(agentId)) return []
  const file = resolveUnlinkedMemoryPath(duyaRoot, `agents/${agentId}/state/projects.json`)
  if (!file) return []
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => isSafeMemorySegment(x))
  } catch {
    return []
  }
}
