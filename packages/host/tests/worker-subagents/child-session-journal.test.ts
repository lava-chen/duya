/**
 * A child session must persist what it produced.
 *
 * ## What was broken
 *
 * `WorkerSession._commitDurable` writes through `this.journal`, and the
 * journal is the ONLY channel into `messageDb`. The child session built by
 * the sub-agent factory had no journal, so every message it produced stayed
 * in its in-memory timeline and died with the process.
 *
 * The failure it caused was invisible: the child ran fine, reported its
 * result, and its transcript simply was not there. `resume_from` then
 * answered `no_history`, and the resume lookup — which reads `messageDb` by
 * session id — was pointed at an empty table.
 *
 * ## Why the parent's journal is not a substitute
 *
 * `message_index` is keyed by session, and a child is a DIFFERENT session
 * with its own row. The parent's journal writes the parent's rows.
 *
 * ## Why this asserts the JOURNAL and not the transcript
 *
 * The transcript needs a real database, and the host test suite runs against
 * a mocked IPC bridge. What this pins is the thing that decides whether the
 * transcript can exist at all: that the child was HANDED a journal. A
 * behaviour test here would pass on both sides of the defect — a child with
 * no journal still runs, still returns its result, and still fails only
 * later, on a different call.
 */

import { describe, expect, it, vi } from 'vitest';
import { createWorkerSessionFactory } from '../../src/worker-tools/assembly.js';
import { attachChildJournal } from '../../src/worker-journal/child-journal.js';
import type { Journal } from '../../src/worker-journal/Journal.js';
import type { BuiltinRegistryServices } from '../../src/worker-tools/services.js';

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat() {
      return (async function* () { /* no model call happens in this suite */ })();
    },
  };
  return {
    ...actual,
    createAIClient: () => delegating,
    createAIClientWithRetry: () => delegating,
  };
});

const services = {
  duyaCliTool: Object.assign(async () => ({ success: true }), {
    toTool: () => ({ name: 'duya_cli', description: 'test stub', input_schema: { type: 'object' } }),
  }),
} as unknown as BuiltinRegistryServices;

const createSession = createWorkerSessionFactory(services);

const AGENT_OPTIONS = {
  apiKey: 'test-key',
  baseURL: 'https://api.anthropic.com',
  model: 'test-model',
} as const;

describe('a child session is handed the journal its persistence depends on', () => {
  it('gives a child with a session id a journal', () => {
    const parent = createSession({ ...AGENT_OPTIONS, sessionId: 'parent-1' });

    const child = parent.createChildSession({ ...AGENT_OPTIONS, sessionId: 'child-1' });

    expect(child.journal).toBeDefined();
    expect(child.journal).not.toBe(parent.journal);
  });

  it('gives a child with NO session id no journal', () => {
    // There is no key to write under, and a journal pointed at an empty
    // session id would write rows no reader can find — the same empty
    // history, one step further away.
    const parent = createSession({ ...AGENT_OPTIONS, sessionId: 'parent-1' });

    const child = parent.createChildSession({ ...AGENT_OPTIONS });

    expect(child.journal).toBeUndefined();
  });

  it('never replaces a journal the session already carries', () => {
    // The top-level session attaches its own right after construction. A
    // second one would be a second writer for the same rows.
    const carrier: { journal: Journal | undefined } = { journal: undefined };
    const first = attachChildJournal(carrier, 'child-1');
    expect(first.journal).toBeDefined();

    const again = attachChildJournal(first, 'child-1');

    expect(again.journal).toBe(first.journal);
  });
});
