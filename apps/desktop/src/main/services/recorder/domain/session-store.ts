/**
 * session-store.ts — Recorder session persistence (plan 556 Phase 0 §4.5).
 *
 * One session = one directory under `~/.duya/recorder/sessions/<id>/`
 * containing exactly two files:
 *
 *   - session.json  : metadata only (startedAt / endedAt / eventCount /
 *                     appSummary). NEVER holds captured text.
 *   - events.jsonl  : newline-delimited JSON, one RecorderEvent per
 *                     line, written via appendFile in arrival order.
 *
 * Concurrency: the store serializes appends through an internal
 * promise chain so two concurrent `append` calls produce lines in
 * the order they were issued (the aggregator always calls append
 * after it has produced the event, so this is a one-writer scenario
 * in practice, but we belt-and-brace against future parallel
 * emitters).
 *
 * Crash recovery: the reader (`loadSession`) discards any line that
 * fails `safeParseRecorderEvent`. The most common reason is a
 * truncated final line from a `kill -9` mid-append; the secondary
 * schema-violation case is treated identically so a future schema
 * change does not brick old sessions.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { safeParseRecorderEvent, type RecorderEvent, type AppRef } from './events.js';
import { redactRecorderEvent } from './privacy.js';

/** Subdirectory under the recorder root that holds every session. */
const SESSIONS_SUBDIR = 'sessions';

/** Default recorder root: `~/.duya/recorder`. */
export function getDefaultRecorderRootDir(): string {
  return path.join(os.homedir(), '.duya', 'recorder');
}

/** Per-session JSON metadata. Persisted to session.json. */
export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  /** Epoch ms; undefined until `end()` is called. */
  endedAt?: number;
  /** Number of lines successfully appended to events.jsonl. */
  eventCount: number;
  /** Apps touched in arrival order, with rough hit count. No titles. */
  apps: { processName: string; name: string; hits: number }[];
}

interface PersistedSessionFile extends SessionSummary {}

/** What `loadSession` returns — metadata + parsed events. */
export interface LoadedSession {
  summary: SessionSummary;
  events: RecorderEvent[];
  /** Lines that were skipped during read, with the per-line reason. */
  dropped: { line: number; reason: string; preview: string }[];
}

export class SessionStore {
  private readonly dir: string;
  private readonly sessionFile: string;
  private readonly eventsFile: string;
  private writeChain: Promise<void> = Promise.resolve();
  private summary: PersistedSessionFile;
  private closed = false;

  constructor(rootDir: string, sessionId: string, startedAt: number = Date.now()) {
    if (!sessionId || sessionId.length === 0) {
      throw new Error('SessionStore: sessionId must be non-empty');
    }
    this.dir = path.join(rootDir, SESSIONS_SUBDIR, sessionId);
    this.sessionFile = path.join(this.dir, 'session.json');
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    this.summary = {
      sessionId,
      startedAt,
      eventCount: 0,
      apps: [],
    };
  }

  /** Idempotent. Creates the session directory and writes session.json. */
  async start(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.persistSummary();
  }

  /** Append one event. Redacts password fields before serializing. */
  append(event: RecorderEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`SessionStore(${this.summary.sessionId}) is closed`));
    }
    const redacted = redactRecorderEvent(event);
    const line = JSON.stringify(redacted) + '\n';
    this.summary = this.advanceSummary(this.summary, redacted);
    this.writeChain = this.writeChain.then(() => fs.appendFile(this.eventsFile, line, 'utf8'));
    // Decrement eventCount when the append itself fails so the metadata
    // never claims more events than the file actually holds.
    this.writeChain = this.writeChain.catch(async (err) => {
      this.summary = { ...this.summary, eventCount: Math.max(0, this.summary.eventCount - 1) };
      await this.persistSummary().catch(() => {
        // best-effort; the real failure surfaces below
      });
      throw err;
    });
    return this.writeChain;
  }

  /** Close the store: write endedAt + final eventCount. */
  async end(): Promise<SessionSummary> {
    if (this.closed) {
      return this.summary;
    }
    this.closed = true;
    // Flush the pending chain before stamping the final summary so the
    // metadata can never claim a higher count than the file.
    await this.writeChain;
    this.summary = { ...this.summary, endedAt: Date.now() };
    await this.persistSummary();
    return this.summary;
  }

  /** Read-only view of the current summary (live, not yet flushed). */
  get currentSummary(): SessionSummary {
    return this.summary;
  }

  private advanceSummary(prev: PersistedSessionFile, event: RecorderEvent): PersistedSessionFile {
    const next: PersistedSessionFile = { ...prev, eventCount: prev.eventCount + 1 };
    const processName = event.app.processName;
    const name = event.app.name;
    const existing = next.apps.find((a) => a.processName === processName);
    if (existing) {
      existing.hits += 1;
    } else {
      next.apps.push({ processName, name, hits: 1 });
    }
    return next;
  }

  private async persistSummary(): Promise<void> {
    await fs.writeFile(this.sessionFile, JSON.stringify(this.summary, null, 2), 'utf8');
  }
}

/**
 * List every session under `rootDir`, newest first.
 *
 * Tolerates orphan directories (no session.json) by returning whatever
 * summary can be reconstructed from the directory name. The reader
 * always treats the on-disk metadata as authoritative.
 */
export async function listSessions(rootDir: string): Promise<SessionSummary[]> {
  const parent = path.join(rootDir, SESSIONS_SUBDIR);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(parent);
  } catch (err) {
    if (isNotFound(err)) {
      return [];
    }
    throw err;
  }
  const summaries: SessionSummary[] = [];
  for (const sessionId of entries) {
    const sessionFile = path.join(parent, sessionId, 'session.json');
    try {
      const raw = await fs.readFile(sessionFile, 'utf8');
      const parsed = JSON.parse(raw) as SessionSummary;
      summaries.push(parsed);
    } catch {
      // Orphan: directory exists but session.json is unreadable. Skip
      // rather than throwing so a single corrupt session doesn't
      // hide the rest.
    }
  }
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries;
}

/**
 * Read a session back from disk, returning metadata + parsed events.
 *
 * Lines that fail `safeParseRecorderEvent` are dropped and surfaced
 * in `dropped` so the UI can flag sessions that lost events to a
 * crash. The returned `events` array is in file order, which matches
 * arrival order because writes are serialized.
 */
export async function loadSession(
  rootDir: string,
  sessionId: string,
): Promise<LoadedSession> {
  const dir = path.join(rootDir, SESSIONS_SUBDIR, sessionId);
  const sessionFile = path.join(dir, 'session.json');
  const eventsFile = path.join(dir, 'events.jsonl');

  const summaryRaw = await fs.readFile(sessionFile, 'utf8');
  const summary = JSON.parse(summaryRaw) as SessionSummary;

  let raw: string;
  try {
    raw = await fs.readFile(eventsFile, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      return { summary, events: [], dropped: [] };
    }
    throw err;
  }

  const events: RecorderEvent[] = [];
  const dropped: LoadedSession['dropped'] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) {
      continue;
    }
    const parsed = safeParseRecorderEvent(line);
    if (parsed.ok) {
      events.push(parsed.event);
    } else {
      dropped.push({ line: i + 1, reason: parsed.reason, preview: line.slice(0, 80) });
    }
  }
  return { summary, events, dropped };
}

/** Permanently remove a session directory. */
export async function deleteSession(rootDir: string, sessionId: string): Promise<void> {
  const dir = path.join(rootDir, SESSIONS_SUBDIR, sessionId);
  await fs.rm(dir, { recursive: true, force: true });
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

// Re-export the small surface that downstream consumers (UI, IPC) need.
// Internal-only types stay private so the public API stays narrow.
export type { AppRef, RecorderEvent } from './events.js';