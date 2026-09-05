/**
 * Tier memory file reader (Plan 479 Phase 2, P2.1).
 *
 * Reads the three memory tiers straight from the file manifest — the
 * source of truth per the Plan 479 P1.0 decision. Scan scope mirrors the
 * Plan 481 `tierWriter` shard layout (single-writer directories):
 *
 *   own    → `<duyaRoot>/agents/<agentId>/memory/**`
 *   user   → `<duyaRoot>/memory/{items,entities,global}/**` (legacy
 *            canonical frontmatter via parseCanonicalFile) plus every
 *            per-writer shard `<duyaRoot>/agents/<agentId>/user/**`
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
    kind: tierKind(meta),
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
 * `global`) — canonical frontmatter files index as writerless notes —
 * plus every per-writer shard `agents/<agentId>/user/**` written by the
 * Plan 481 tierWriter (tier-format files only; the shard owner is the
 * writer). Recalling both keeps legacy rows visible while shard writes
 * join the same dedupe/attribution space.
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
  // Per-writer user shards: agents/<agentId>/user/** (tierWriter layout).
  const agentsDir = path.join(duyaRoot, 'agents')
  let agentIds: string[]
  try {
    agentIds = fs.readdirSync(agentsDir).filter((name) => {
      if (name.startsWith('.')) return false
      try {
        return fs.statSync(path.join(agentsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return entries
  }
  for (const agentId of agentIds) {
    const shardDir = path.join(agentsDir, agentId, 'user')
    const files: string[] = []
    walkMdFiles(shardDir, files)
    for (const file of files) {
      const entry = readTierFile(file, duyaRoot, 'user', agentId, '')
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
  for (const projectId of joinedProjectIds) {
    const shardsRoot = path.join(duyaRoot, 'projects', projectId, 'agents')
    let writerIds: string[]
    try {
      writerIds = fs.readdirSync(shardsRoot).filter((name) => {
        if (name.startsWith('.')) return false
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
      walkMdFiles(path.join(shardsRoot, writerId), files)
      for (const file of files) {
        const entry = readTierFile(file, duyaRoot, 'project', writerId, projectId)
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

