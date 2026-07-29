/**
 * MemoryRecallTool - Recall durable memories from the v2 memory store.
 *
 * Plan 306 Phase D: reads `memory_entries` from the memory-state SQLite
 * DB and records a `memory_usage_events` row per returned entry so the
 * Phase B consolidator can score memories by real-world usefulness.
 *
 * The tool is safe to call when the DB is missing or empty — it returns
 * an empty `<memory-context>` envelope instead of throwing.
 */

import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../../types.js';
import type BetterSqlite3 from 'better-sqlite3';
import { recordRetrieval } from '../../memory-state/usageEvents.js';

const TOOL_NAME = 'memory_recall';

const MEMORY_RECALL_DESCRIPTION = `Recall durable memories from the v2 memory store.

Use this tool when you need to check what the system already knows about:
- User preferences (language, tooling, formatting)
- Project facts (OS, stack, conventions)
- Reusable procedures (commit format, test commands)
- External references (URLs, doc paths)

Returns up to N entries ranked by keyword match + scope. Each entry includes
a memory_id (cite via <memory-citation memory_id="..."/>) and evidence pointers.`;

const MemoryRecallInputSchema = z.object({
  query: z.string().describe('Keywords or natural-language query'),
  scope: z.enum(['global', 'project', 'all']).default('all'),
  kind: z
    .enum(['preference', 'fact', 'reference', 'procedure'])
    .optional()
    .describe('Filter by memory kind'),
  limit: z.number().int().min(1).max(20).default(5),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryEntryRow {
  memory_id: string;
  scope: string;
  project_id: string | null;
  kind: 'preference' | 'fact' | 'reference' | 'procedure';
  canonical_key: string;
  content: string;
  version: number;
  status: string;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// better-sqlite3 constructor resolution + DB path
// ---------------------------------------------------------------------------

let BetterSqlite3Ctor: (new (filename: string) => BetterSqlite3.Database) | null = null;

function getBetterSqlite3Ctor(): new (filename: string) => BetterSqlite3.Database {
  if (BetterSqlite3Ctor) return BetterSqlite3Ctor;
  const require = createRequire(import.meta.url);

  // Prefer the explicit path passed by the parent process. In monorepo /
  // Electron setups the workspace-local copy may be compiled for a different
  // Node ABI, so default module resolution can load the wrong native binary.
  const explicitPath = process.env.DUYA_BETTER_SQLITE3_PATH;
  if (explicitPath) {
    try {
      BetterSqlite3Ctor = require(explicitPath) as new (
        filename: string
      ) => BetterSqlite3.Database;
      return BetterSqlite3Ctor;
    } catch {
      // Fall through to module resolution.
    }
  }

  BetterSqlite3Ctor = require('better-sqlite3') as new (
    filename: string
  ) => BetterSqlite3.Database;
  return BetterSqlite3Ctor;
}

function getUserDataPath(): string {
  if (process.platform === 'win32') {
    return (
      process.env.APPDATA ||
      path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming')
    );
  } else if (process.platform === 'darwin') {
    return path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support');
  } else {
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}

/**
 * Resolve the memory-state.db path. The DB sits next to `duya-main.db`
 * in the boot.json database directory. We mirror `session/db.ts`:
 * `DUYA_DB_DIR` (passed by the main process) takes priority, then the
 * platform-default `<userData>/DUYA/` location.
 */
function resolveMemoryStateDbPath(): string {
  if (process.env.DUYA_DB_DIR) {
    return path.join(process.env.DUYA_DB_DIR, 'memory-state.db');
  }
  return path.join(getUserDataPath(), 'DUYA', 'memory-state.db');
}

// Singleton DB handle — opened lazily on the first recall call.
let _db: BetterSqlite3.Database | null = null;

function getDb(): BetterSqlite3.Database | null {
  if (_db) return _db;

  const dbPath = resolveMemoryStateDbPath();
  // The DB is created by the Electron main process. If it does not exist
  // yet (memory v2 not bootstrapped), return null so the tool yields an
  // empty result instead of creating a stale empty DB.
  if (!fs.existsSync(dbPath)) return null;

  try {
    const Ctor = getBetterSqlite3Ctor();
    const db = new Ctor(dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    _db = db;
    return _db;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path normalization (agent-side copy of the key rules from
// electron/memory-state/pathUtils.ts — packages/agent MUST NOT import
// from electron/).
// ---------------------------------------------------------------------------

function normalizePathForLookup(input: string): string {
  const resolved = path.resolve(input);
  const forward = resolved.replace(/\\/g, '/');
  const normalized = path.posix.normalize(forward);
  if (process.platform === 'win32') {
    // Lowercase drive letter (e.g. C:/foo → c:/foo).
    const m = normalized.match(/^\/?([A-Za-z]):(\/.*)$/);
    if (m) {
      const prefix = normalized.startsWith('/') ? '/' : '';
      return `${prefix}${m[1].toLowerCase()}:${m[2]}`;
    }
  }
  return normalized;
}

/**
 * Resolve the project_id for a working directory by looking it up in
 * the `project_path_aliases` table. Returns null when the path is not
 * registered yet (Phase B consolidator hasn't seen this project) or
 * when the table doesn't exist.
 */
function resolveProjectId(
  db: BetterSqlite3.Database,
  workingDirectory: string | undefined
): string | null {
  if (!workingDirectory) return null;
  const normalized = normalizePathForLookup(workingDirectory);
  try {
    const row = db
      .prepare(
        'SELECT project_id FROM project_path_aliases WHERE absolute_normalized_path = ?'
      )
      .get(normalized) as { project_id: string } | undefined;
    return row?.project_id ?? null;
  } catch {
    // Table missing or query error — degrade gracefully.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/** Map a memory kind to a human-readable section heading. */
function sectionForKind(kind: MemoryEntryRow['kind']): string {
  switch (kind) {
    case 'preference':
      return 'User preferences';
    case 'fact':
    case 'reference':
      return 'Reusable knowledge';
    case 'procedure':
      return 'Failures and how to do differently';
    default:
      return 'Reusable knowledge';
  }
}

const SECTION_ORDER = [
  'User preferences',
  'Reusable knowledge',
  'Failures and how to do differently',
] as const;

interface RenderedSection {
  heading: string;
  lines: string[];
}

function renderMemoryContext(
  entries: MemoryEntryRow[],
  retrievalId: string,
  retrievedAt: number
): string {
  const iso = new Date(retrievedAt).toISOString();
  const lines: string[] = [
    `<memory-context retrieval-id="${retrievalId}" retrieved-at="${iso}">`,
  ];

  if (entries.length === 0) {
    lines.push('No memories found.', '');
    lines.push('</memory-context>');
    return lines.join('\n');
  }

  // Group entries by section.
  const sections = new Map<string, string[]>();
  for (const entry of entries) {
    const heading = sectionForKind(entry.kind);
    if (!sections.has(heading)) sections.set(heading, []);
    const block: string[] = [];
    block.push(
      `- **[${entry.kind}]** ${entry.canonical_key} — \`${entry.memory_id}\``
    );
    block.push(`  ${entry.content.replace(/\n/g, '\n  ')}`);
    sections.get(heading)!.push(...block);
  }

  for (const heading of SECTION_ORDER) {
    const sectionLines = sections.get(heading);
    if (!sectionLines || sectionLines.length === 0) continue;
    lines.push(`## ${heading}`);
    lines.push(...sectionLines);
    lines.push('');
  }

  lines.push('Cite memories you use via: <memory-citation memory_id="..."/>');
  lines.push('</memory-context>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class MemoryRecallTool extends BaseTool {
  readonly name = TOOL_NAME;
  readonly description = MEMORY_RECALL_DESCRIPTION;
  readonly input_schema = MemoryRecallInputSchema;

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext
  ): Promise<ToolResult> {
    const parsed = MemoryRecallInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${parsed.error.message}`,
        error: true,
      };
    }

    const { query, scope, kind, limit } = parsed.data;
    const retrievalId = crypto.randomUUID();
    const now = Date.now();
    const sessionId =
      context?.options?.sessionId ?? process.env.SESSION_ID ?? 'unknown';

    const db = getDb();
    if (!db) {
      // DB not bootstrapped — return an empty envelope (not an error).
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: renderMemoryContext([], retrievalId, now),
      };
    }

    try {
      const entries = this.queryEntries(db, {
        query,
        scope,
        kind,
        limit,
        workingDirectory,
      });

      // Record a usage event for each retrieved memory so the Phase B
      // consolidator can score memories by real-world usefulness.
      for (const entry of entries) {
        try {
          recordRetrieval(db, {
            memoryId: entry.memory_id,
            sessionId,
            retrievalId,
            now,
          });
        } catch {
          // Usage event recording is best-effort — never block the recall
          // result on a telemetry write failure.
        }
      }

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: renderMemoryContext(entries, retrievalId, now),
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `memory_recall failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
        error: true,
      };
    }
  }

  /**
   * Query `memory_entries` with scope / kind / keyword filters. Returns
   * active entries ordered by `updated_at DESC`, capped at `limit`.
   */
  private queryEntries(
    db: BetterSqlite3.Database,
    opts: {
      query: string;
      scope: 'global' | 'project' | 'all';
      kind?: 'preference' | 'fact' | 'reference' | 'procedure';
      limit: number;
      workingDirectory?: string;
    }
  ): MemoryEntryRow[] {
    const where: string[] = ["status = 'active'"];
    const params: (string | number)[] = [];

    // Scope filter.
    if (opts.scope === 'global') {
      where.push("scope = 'global'");
    } else if (opts.scope === 'project') {
      const projectId = resolveProjectId(db, opts.workingDirectory);
      if (!projectId) {
        // Project not registered — no project-scoped memories can match.
        return [];
      }
      where.push("scope = 'project' AND project_id = ?");
      params.push(projectId);
    }
    // 'all' → no scope filter.

    // Kind filter.
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }

    // Keyword filter: LIKE on content OR canonical_key.
    const trimmed = opts.query.trim();
    if (trimmed) {
      where.push('(content LIKE ? OR canonical_key LIKE ?)');
      const pattern = `%${trimmed}%`;
      params.push(pattern, pattern);
    }

    params.push(opts.limit);

    const sql = `SELECT memory_id, scope, project_id, kind, canonical_key,
                        content, version, status, updated_at
                 FROM memory_entries
                 WHERE ${where.join(' AND ')}
                 ORDER BY updated_at DESC
                 LIMIT ?`;

    try {
      return db.prepare(sql).all(...params) as MemoryEntryRow[];
    } catch {
      // Table missing or schema drift — degrade to empty result.
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: MemoryRecallTool | null = null;

export function getMemoryRecallTool(): MemoryRecallTool {
  if (!_instance) {
    _instance = new MemoryRecallTool();
  }
  return _instance;
}
