/**
 * Regression: `projectMessageTranscript` round-trips every row through
 * `ingestMessages` -> `projectTranscriptMessages`, whose `LEGACY_KNOWN_KEYS`
 * whitelist (packages/agent-protocol/src/message-ingest.ts) dropped
 * `sequenceDomain` and `runId`. Both are renderer-side cursor provenance:
 * `MessageList`'s `sortMessagesForConversation` reads them to segment the
 * transcript, so once stripped, the live RunSession rows (run-event cursor)
 * fell back to `'message-log'` and were sorted against the durable rows
 * (message-log cursor) as ONE sequence space — exactly the interleaving the
 * segmentation exists to prevent.
 *
 * Exercise the production path: `projectMessageTranscript` -> `MessageList`.
 */

/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import type { Message } from '@/types/message';
import { projectMessageTranscript } from './project-message-transcript';

function row(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { timestamp: 1, ...overrides };
}

describe('projectMessageTranscript — cursor provenance survives the round-trip', () => {
  it('keeps sequenceDomain and runId, and leaves the two cursor domains un-interleaved', () => {
    // Durable rows first (the merge order in App.tsx), then the live run rows.
    // The run rows arrive OUT of seq order (which the sort must fix WITHIN the
    // run-event domain) and their seq values overlap the durable row's.
    const messages: Message[] = [
      row({ id: 'log-10', role: 'assistant', content: 'durable reply', seqIndex: 10 }),
      row({
        id: 'run:run-1:b',
        role: 'assistant',
        content: 'live later',
        seqIndex: 2,
        sequenceDomain: 'run-event',
        runId: 'run-1',
      }),
      row({
        id: 'run:run-1:c',
        role: 'assistant',
        content: 'live earlier',
        seqIndex: 1,
        sequenceDomain: 'run-event',
        runId: 'run-1',
      }),
    ];

    const { messages: projected } = projectMessageTranscript(messages);

    // 1. The fields themselves survive.
    expect(projected.map((m) => m.id)).toEqual(['log-10', 'run:run-1:b', 'run:run-1:c']);
    expect(projected[0]?.sequenceDomain).toBeUndefined();
    expect(projected[0]?.runId).toBeUndefined();
    expect(projected[1]?.sequenceDomain).toBe('run-event');
    expect(projected[1]?.runId).toBe('run-1');
    expect(projected[2]?.sequenceDomain).toBe('run-event');
    expect(projected[2]?.runId).toBe('run-1');

  });

  it('re-attaches a row that arrived without an id, under the id it goes back out with', () => {
    // `toRendererMessage` sets `id: msg.id ?? ''`, so a row that lost its id on
    // the way IN comes back as ''. The provenance must still land on it — the
    // lookup key is the ingested id, not the input id.
    const messages: Message[] = [
      row({ id: '', role: 'assistant', content: 'live text', seqIndex: 3, sequenceDomain: 'run-event', runId: 'run-9' }),
    ];

    const { messages: projected } = projectMessageTranscript(messages);

    expect(projected).toHaveLength(1);
    expect(projected[0]?.id).toBe('');
    expect(projected[0]?.sequenceDomain).toBe('run-event');
    expect(projected[0]?.runId).toBe('run-9');
  });

  it('re-attaches a row whose id ingest had to synthesise', () => {
    // A role that goes through `baseFields` gets `legacy-message-<index>` when
    // it has no id, so "match by input id" would miss this row entirely.
    const messages: Message[] = [
      row({ id: '', role: 'system', content: 'preamble', seqIndex: 4, sequenceDomain: 'run-event', runId: 'run-7' }),
    ];

    const { messages: projected } = projectMessageTranscript(messages);

    expect(projected).toHaveLength(1);
    expect(projected[0]?.id).toBe('legacy-message-0');
    expect(projected[0]?.sequenceDomain).toBe('run-event');
    expect(projected[0]?.runId).toBe('run-7');
  });

  it('does not mis-attach one row runId to another when rows share a key across a hidden row', () => {
    // Two id-less provenance rows (same key '') with different run identities,
    // and a hidden mailbox row between them that the projector drops. Each
    // visible row must take its OWN entry: a one-slot-per-key map would stamp
    // both rows with the last runId, and index pairing on the INPUT array would
    // slide by the dropped row.
    const messages: Message[] = [
      row({ id: '', role: 'assistant', content: 'first run text', seqIndex: 1, sequenceDomain: 'run-event', runId: 'run-a' }),
      row({
        id: 'hidden-ctx', role: 'user', content: 'attachment context', msgType: 'attachment',
        metadata: { runtimeContext: true },
      }),
      row({ id: '', role: 'assistant', content: 'second run text', seqIndex: 2, sequenceDomain: 'run-event', runId: 'run-b' }),
    ];

    const { messages: projected } = projectMessageTranscript(messages);

    expect(projected.map((m) => m.content)).toEqual(['first run text', 'second run text']);
    expect(projected.map((m) => m.runId)).toEqual(['run-a', 'run-b']);
  });

  it('invents no provenance on rows that carry none', () => {
    // `sequenceDomain ?? 'message-log'` in the sort already handles the durable
    // side; stamping a default here would be a claim the row never made.
    const messages: Message[] = [
      row({ id: 'log-1', role: 'user', content: 'question', seqIndex: 1 }),
      row({ id: 'log-2', role: 'assistant', content: 'answer', seqIndex: 2 }),
    ];

    const { messages: projected } = projectMessageTranscript(messages);

    expect(projected.every((m) => !('runId' in m) && !('sequenceDomain' in m))).toBe(true);
  });
});
