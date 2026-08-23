/**
 * Integration tests for the Stage1Extractor budget-degrading retry.
 *
 * On output-shape failures (unparseable JSON / empty text) the extractor
 * re-compacts the transcript with a halved budget and retries once before
 * recording the lease failure. Transport-class failures (refusal, timeout,
 * provider errors) must NOT retry. These tests run against a real
 * memory-state schema (migrations 0001-0008) with a scripted LLM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

// Resolve better-sqlite3 from the agent package so these tests can run
// while a dev Electron instance holds the root copy under a different ABI.
const agentRequire = createRequire(path.resolve(__dirname, '../../../package.json'));
const Database = agentRequire('better-sqlite3') as typeof import('better-sqlite3');
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

import { migration0001 } from '../../../../../electron/memory-state/migrations/0001_init.sql';
import { migration0002 } from '../../../../../electron/memory-state/migrations/0002_lease_stage1.sql';
import { migration0003 } from '../../../../../electron/memory-state/migrations/0003_outbox.sql';
import { migration0005 } from '../../../../../electron/memory-state/migrations/0005_phase2.sql';
import { migration0006 } from '../../../../../electron/memory-state/migrations/0006_people_areas.sql';
import { migration0007 } from '../../../../../electron/memory-state/migrations/0007_lifecycle_scope.sql';
import { migration0008 } from '../../../../../electron/memory-state/migrations/0008_curation_runs.sql';
import { Stage1Extractor, type MessageRowShape } from '../extractor.js';
import type { AIClient } from '@duya/ai';

const ROLLOUT_ID = '11111111-1111-4111-8111-111111111111';
const NO_OUTPUT_ENVELOPE = '{"job_status":"succeeded_no_output","rollout_slug":"noop"}';

interface Fixture {
  db: BetterSqlite3Database;
  rootDir: string;
  cleanup: () => void;
}

function createFixture(): Fixture {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-retry-db-'));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-retry-root-'));
  const db = new Database(path.join(dbDir, 'memory-state.db'));
  db.pragma('journal_mode = WAL');
  for (const m of [migration0001, migration0002, migration0003, migration0005, migration0006, migration0007, migration0008]) {
    db.exec(m.sql);
  }
  db.prepare(
    `INSERT INTO rollout_catalog (
       rollout_id, scope_kind, project_id, agent_type, parent_id, mode,
       working_directory, working_directory_normalized, git_root,
       agent_profile_id, message_count, last_message_id, last_message_at,
       source_status, source_missing_at, source_deleted_at,
       generation, source_fingerprint, last_seen_at, first_seen_at
     ) VALUES (?, 'global', NULL, 'main', NULL, NULL,
       '/tmp/ws', '/tmp/ws', NULL,
       NULL, 6, 'm6', 1000,
       'active', NULL, NULL,
       0, 'fp-test', 1000, 1000)`
  ).run(ROLLOUT_ID);

  return {
    db,
    rootDir,
    cleanup: () => {
      try { db.close(); } catch { /* already closed */ }
      for (const dir of [dbDir, rootDir]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

const FAKE_ROWS: MessageRowShape[] = [
  { id: 'm1', role: 'user', content: 'Please refactor the parser module.', tool_call_id: null, tool_name: null, tool_input: null, msg_type: null, seq_index: 1, created_at: 100, status: null },
  { id: 'm2', role: 'assistant', content: 'Done — extracted the tokenizer and added tests.', tool_call_id: null, tool_name: null, tool_input: null, msg_type: null, seq_index: 2, created_at: 200, status: null },
];

interface ScriptedClient {
  client: AIClient;
  streamChat: ReturnType<typeof vi.fn>;
}

/**
 * Scripted LLM: each `streamChat` call consumes the next event list; an
 * entry of `{ error: '...' }` yields an error event (transport-class
 * failure), strings yield text events.
 */
function scriptedLlm(script: Array<Array<string | { error: string }>>): ScriptedClient {
  let callIndex = 0;
  const streamChat = vi.fn(() => {
    const events = script[Math.min(callIndex++, script.length - 1)] ?? [];
    return (async function* () {
      for (const e of events) {
        if (typeof e === 'string') yield { type: 'text', data: e };
        else yield { type: 'error', data: e.error };
      }
      yield { type: 'done' };
    })();
  });
  return { client: { streamChat } as unknown as AIClient, streamChat };
}

function makeExtractor(f: Fixture, client: AIClient): Stage1Extractor {
  return new Stage1Extractor(f.db, {} as BetterSqlite3Database, client, {
    rootDir: f.rootDir,
    readMessageRows: async () => FAKE_ROWS,
  });
}

describe('Stage1Extractor budget-degrading retry', () => {
  let f: Fixture;

  beforeEach(() => {
    f = createFixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  it('retries once on the halved budget after a parse failure and commits', async () => {
    const { client, streamChat } = scriptedLlm([
      ['this is not json at all {{{'],
      [NO_OUTPUT_ENVELOPE],
    ]);
    const ex = makeExtractor(f, client);

    const result = await ex.extract({ rolloutId: ROLLOUT_ID, claimedBy: 'test' });

    expect(result.status).toBe('succeeded_no_output');
    expect(streamChat).toHaveBeenCalledTimes(2);
    // The lease was consumed by complete().
    expect(f.db.prepare('SELECT COUNT(*) n FROM rollout_leases').get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) n FROM stage1_outputs").get()).toEqual({ n: 1 });
  });

  it('records the lease failure after both attempts fail to parse', async () => {
    const { client, streamChat } = scriptedLlm([
      ['garbage one {{{'],
      ['garbage two }}}'],
    ]);
    const ex = makeExtractor(f, client);

    const result = await ex.extract({ rolloutId: ROLLOUT_ID, claimedBy: 'test' });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('invalid-json');
    expect(streamChat).toHaveBeenCalledTimes(2);
    const lease = f.db.prepare('SELECT job_status FROM rollout_leases WHERE rollout_id = ?').get(ROLLOUT_ID) as { job_status: string };
    expect(lease.job_status).toBe('failed');
  });

  it('retries once when the model returns empty text', async () => {
    const { client, streamChat } = scriptedLlm([
      [''],
      [NO_OUTPUT_ENVELOPE],
    ]);
    const ex = makeExtractor(f, client);

    const result = await ex.extract({ rolloutId: ROLLOUT_ID, claimedBy: 'test' });

    expect(result.status).toBe('succeeded_no_output');
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry transport-class failures (policy refusal)', async () => {
    const { client, streamChat } = scriptedLlm([
      [{ error: 'request rejected by content policy' }],
    ]);
    const ex = makeExtractor(f, client);

    const result = await ex.extract({ rolloutId: ROLLOUT_ID, claimedBy: 'test' });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('llm-refused');
    expect(streamChat).toHaveBeenCalledTimes(1);
  });
});
