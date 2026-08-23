/**
 * Regression tests for Stage1Extractor outcome logging (logExtractResult).
 *
 * The slug lookup used to query `rollout_catalog.rollout_slug`, a column
 * that does not exist on the catalog table. The throw was swallowed by the
 * best-effort catch, so NO extract_* event ever reached the memory system
 * log — phase1 outcomes were invisible. These tests pin the contract:
 * an outcome event is ALWAYS written, even when the slug lookup throws,
 * and the slug is resolved from stage1_outputs when available.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { AIClient } from '@duya/ai';

const mocks = vi.hoisted(() => ({
  writeSystemLog: vi.fn(),
}));

vi.mock('../../memory-state/system_log.js', () => ({
  writeSystemLog: mocks.writeSystemLog,
}));

import { Stage1Extractor } from '../extractor.js';

/** A db stub whose prepare() throws — simulates schema drift / missing table. */
const explodingDb = {
  prepare: () => {
    throw new Error('no such column: rollout_slug');
  },
} as unknown as Database;

/** A db stub that resolves a slug like the real stage1_outputs row would. */
const slugDb = {
  prepare: () => ({
    get: () => ({ rollout_slug: 'my-slug' }),
  }),
} as unknown as Database;

function makeExtractor(memoryDb: Database): Stage1Extractor {
  const llmClient = {
    streamChat: vi.fn(),
    chat: vi.fn(),
  } as unknown as AIClient;
  return new Stage1Extractor(memoryDb, {} as Database, llmClient);
}

describe('Stage1Extractor.logExtractResult', () => {
  beforeEach(() => {
    mocks.writeSystemLog.mockClear();
  });

  it('emits extract_failed with the error code when lookup explodes', () => {
    const ex = makeExtractor(explodingDb);
    (
      ex as unknown as {
        logExtractResult: (id: string, r: Record<string, unknown>) => void;
      }
    ).logExtractResult('r1', {
      status: 'failed',
      contentOutcome: null,
      projectionPath: null,
      stage1RowId: 'r1',
      durationMs: 5,
      errorMessage: 'invalid-json',
    });

    expect(mocks.writeSystemLog).toHaveBeenCalledTimes(1);
    const evt = mocks.writeSystemLog.mock.calls[0][0];
    expect(evt.phase).toBe('phase1');
    expect(evt.eventType).toBe('extract_failed');
    expect(evt.message).toContain('invalid-json');
  });

  it('emits extract_committed with the stage1_outputs slug', () => {
    const ex = makeExtractor(slugDb);
    (
      ex as unknown as {
        logExtractResult: (id: string, r: Record<string, unknown>) => void;
      }
    ).logExtractResult('r2', {
      status: 'committed',
      contentOutcome: 'success',
      projectionPath: '/p',
      stage1RowId: 'r2',
      durationMs: 10,
    });

    expect(mocks.writeSystemLog).toHaveBeenCalledTimes(1);
    const evt = mocks.writeSystemLog.mock.calls[0][0];
    expect(evt.eventType).toBe('extract_committed');
    expect(evt.detail.rollout_slug).toBe('my-slug');
  });

  it('emits extract_skipped for noop outcomes even when lookup explodes', () => {
    const ex = makeExtractor(explodingDb);
    (
      ex as unknown as {
        logExtractResult: (id: string, r: Record<string, unknown>) => void;
      }
    ).logExtractResult('r3', {
      status: 'noop_skipped',
      contentOutcome: null,
      projectionPath: null,
      stage1RowId: 'r3',
      durationMs: 0,
    });

    expect(mocks.writeSystemLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeSystemLog.mock.calls[0][0].eventType).toBe('extract_skipped');
  });
});
