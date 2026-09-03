/**
 * Tier memory file reader (Plan 479 Phase 2, P2.1).
 *
 * Reads the three memory tiers straight from the file manifest — the
 * source of truth per the Plan 479 P1.0 decision. Mirrors the scan
 * scope of the electron-side `rebuildTierIndexFromFiles`:
 *
 *   own    → `<duyaRoot>/agents/<agentId>/memory/**` (Plan 485
 *            reservation; tier/kind/dedupe_key frontmatter, the
 *            Phase 3 `update_state` write format)
 *   user   → `<duyaRoot>/memory/{items,entities,global}/**`
 *            (legacy canonical frontmatter via parseCanonicalFile)
 *   project→ `<duyaRoot>/memory/projects/<projectId>/**`
 *            (populated from Phase 3 on)
 *
 * Project membership comes from
 * `<duyaRoot>/agents/<agentId>/state/projects.json` (the `state/` dir is
 * the Plan 485 reservation for bot state); absent file → not joined.
 *
 * Only `status: active` files are recallable; retired/superseded files
 * are history, not memory.
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { parseCanonicalFile } from '../../../memory-state/canonical_file.js'
import { normalizeKey } from './render.js'
import type { TierMemoryEntry } from './types.js'

/** Legacy user-tier scan roots, relative to the duya root. */
const USER_SCAN_ROOTS = ['memory/items', 'memory/entities', 'memory/global'] as const

interface RawTierFrontmatter {
  tier?: string
  kind?: string
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
  const meta: RawTierFrontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (m) meta[m[1] as keyof RawTierFrontmatter] = m[2].trim()
  }
  return { meta, body: content.slice(match[0].length).trim() }
}

function walkMdFiles(dir: string, out: string[]): void {
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
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) walkMdFiles(full, out)
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
  if (heading) return heading[1].trim()
  return path.basename(filePath, '.md')
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
): TierMemoryEntry | null {
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
    kind: meta.kind === 'profile' || meta.kind === 'log' ? meta.kind : 'note',
    dedupeKey: normalizeKey(dedupeRaw),
    writerId: meta.agent_profile_id ?? fallbackWriter,
    projectId: meta.project_id ?? fallbackProjectId,
    filePath: toRelPath(filePath, duyaRoot),
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
  const dir = path.join(duyaRoot, 'agents', agentId, 'memory')
  const files: string[] = []
  walkMdFiles(dir, files)
  const entries: TierMemoryEntry[] = []
  for (const file of files) {
    const entry = readTierFile(file, duyaRoot, 'agent', agentId, '')
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * User tier: the legacy canonical tree (`memory/items`, `entities`,
 * `global`). Canonical frontmatter files index as writerless notes
 * (dedupeKey = lowercased canonical_key); tier-format files (future
 * per-writer shards under `memory/shared/`) carry their own writer.
 */
export function readUserTierEntries(duyaRoot: string): TierMemoryEntry[] {
  const entries: TierMemoryEntry[] = []
  for (const root of USER_SCAN_ROOTS) {
    const absRoot = path.join(duyaRoot, root)
    const files: string[] = []
    walkMdFiles(absRoot, files)
    for (const file of files) {
      const tierEntry = readTierFile(file, duyaRoot, 'user', '', '')
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
        filePath: toRelPath(file, duyaRoot),
        title: fileTitle(body, file),
        body,
        createdAt: parseTimestamp(undefined, stat.birthtimeMs),
        updatedAt: parseTimestamp(canonical.updated_at, stat.mtimeMs),
      })
    }
  }
  return entries
}

/**
 * Project tier: `memory/projects/<projectId>/**` for each joined id.
 * Unknown/unjoined ids are skipped by the caller-provided list.
 */
export function readProjectTierEntries(duyaRoot: string, joinedProjectIds: string[]): TierMemoryEntry[] {
  const entries: TierMemoryEntry[] = []
  for (const projectId of joinedProjectIds) {
    const dir = path.join(duyaRoot, 'memory', 'projects', projectId)
    const files: string[] = []
    walkMdFiles(dir, files)
    for (const file of files) {
      const entry = readTierFile(file, duyaRoot, 'project', '', projectId)
      if (entry) entries.push(entry)
    }
  }
  return entries
}

/**
 * Project membership for a bot: `agents/<agentId>/state/projects.json`
 * (string array). Missing/corrupt file → not joined to anything.
 */
export function readJoinedProjects(duyaRoot: string, agentId: string): string[] {
  const file = path.join(duyaRoot, 'agents', agentId, 'state', 'projects.json')
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

