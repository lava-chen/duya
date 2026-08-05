import { describe, expect, it } from 'vitest';
import type { FileAttachment } from '../../src/types.js';
import type { MailboxRow } from '../../src/mailbox/types.js';
import { buildTaskNotificationXml } from '../../src/lifecycle/buildTaskNotification.js';
import type { AgentMessage } from '../../src/message/message-framework.js';
import { projectPersistenceMessages } from '../../src/message/message-projectors.js';
import {
  RUNTIME_CONTEXT_METADATA_KEYS,
  adaptAttachmentContext,
  adaptCustomRuntimeContext,
  adaptMailboxHardReplacement,
  adaptMailboxRows,
  adaptTaskNotificationXml,
  dedupeRuntimeContextMessages,
  projectRuntimeContextToProviderMessage,
  type RuntimeContextAdapterOptions,
} from '../../src/message/runtime-context-adapters.js';

const FIXED_NOW = 1_700_000_000_000;

function deterministicIds(prefix: string): { next: () => string; reset: () => void } {
  let n = 0;
  return {
    next: () => `${prefix}-${++n}`,
    reset: () => {
      n = 0;
    },
  };
}

function options(
  idGen: () => string,
  overrides: RuntimeContextAdapterOptions = {},
): RuntimeContextAdapterOptions {
  return { idGenerator: idGen, clock: () => FIXED_NOW, ...overrides };
}

// ─── Mailbox row fixture ─────────────────────────────────────────────────

function makeMailboxRow(overrides: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: 'mb-1',
    session_id: 'sess-1',
    submitted_during_run_id: 'run-1',
    content: 'do the thing',
    kind: 'followup',
    status: 'pending',
    priority: 100,
    constraints_json: null,
    attachments_json: null,
    source: 'user',
    client_msg_id: null,
    created_at: FIXED_NOW,
    claim_token: 'token-1',
    claim_expires_at: null,
    observed_at: null,
    observed_at_checkpoint: null,
    observed_by_run_id: null,
    claim_attempts: 0,
    last_claim_error: null,
    edit_locked_at: null,
    apply_mode: null,
    applied_at: null,
    applied_at_checkpoint: null,
    applied_summary: null,
    resulting_user_msg_id: null,
    failure_reason: null,
    edit_history_json: null,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    id: 'att-1',
    name: 'doc.txt',
    type: 'text/plain',
    url: 'file:///doc.txt',
    size: 100,
    text: 'parsed text content',
    ...overrides,
  };
}

function makeNotificationXml(taskId: string, overrides: {
  status?: 'completed' | 'failed' | 'killed';
  toolUseId?: string;
  agentType?: string;
  finalMessage?: string;
} = {}): string {
  return buildTaskNotificationXml({
    taskId,
    status: overrides.status ?? 'completed',
    agentType: overrides.agentType ?? 'general-purpose',
    outputFilePath: `/tmp/${taskId}.log`,
    toolUseId: overrides.toolUseId,
    finalMessage: overrides.finalMessage ?? 'done',
  });
}

// ─── adaptMailboxRows ────────────────────────────────────────────────────

describe('adaptMailboxRows', () => {
  it('wraps followup/correction/constraint rows in a single runtime_context message', () => {
    const ids = deterministicIds('mb');
    const rows = [
      makeMailboxRow({ id: 'r1', content: 'follow up please', kind: 'followup' }),
      makeMailboxRow({ id: 'r2', content: 'fix the bug', kind: 'correction' }),
      makeMailboxRow({ id: 'r3', content: 'stay under 100 tokens', kind: 'constraint' }),
    ];
    const tokens = ['tok-1', 'tok-2', 'tok-3'];

    const messages = adaptMailboxRows(rows, tokens, options(ids.next));

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.kind).toBe('runtime_context');
    expect(msg.source).toBe('mailbox');
    expect(msg.persistence).toBe('transient');
    expect(msg.visibility).toBe('hidden');
    expect(msg.includeInModel).toBe(true);
    expect(msg.createdAt).toBe(FIXED_NOW);
    expect(msg.content).toContain('<runtime-user-guidance>');
    expect(msg.content).toContain('1. (follow-up) follow up please');
    expect(msg.content).toContain('2. (correction) fix the bug');
    expect(msg.content).toContain('3. (constraint) stay under 100 tokens');
  });

  it('preserves mailbox row IDs, claim tokens, and kinds in metadata', () => {
    const ids = deterministicIds('mb');
    const rows = [
      makeMailboxRow({ id: 'r1', kind: 'followup', source: 'cli' }),
      makeMailboxRow({ id: 'r2', kind: 'correction', source: 'cli' }),
    ];

    const [msg] = adaptMailboxRows(rows, ['tok-1', 'tok-2'], options(ids.next));

    expect(msg.metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds]: ['r1', 'r2'],
      [RUNTIME_CONTEXT_METADATA_KEYS.claimTokens]: ['tok-1', 'tok-2'],
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxKinds]: ['followup', 'correction'],
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxSource]: 'cli',
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxHardReplacement]: false,
    });
  });

  it('skips stop and abort_and_replace rows (control signals, not guidance)', () => {
    const ids = deterministicIds('mb');
    const rows = [
      makeMailboxRow({ id: 'r1', kind: 'followup', content: 'keep going' }),
      makeMailboxRow({ id: 'r2', kind: 'stop', content: 'stop now' }),
      makeMailboxRow({ id: 'r3', kind: 'abort_and_replace', content: 'replace' }),
    ];

    const messages = adaptMailboxRows(rows, ['tok-1', 'tok-2', 'tok-3'], options(ids.next));

    expect(messages).toHaveLength(1);
    expect(messages[0].metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds]: ['r1'],
    });
  });

  it('skips rows without a claim token', () => {
    const ids = deterministicIds('mb');
    const rows = [
      makeMailboxRow({ id: 'r1', kind: 'followup' }),
      makeMailboxRow({ id: 'r2', kind: 'followup' }),
    ];

    const messages = adaptMailboxRows(rows, ['tok-1', ''], options(ids.next));

    expect(messages).toHaveLength(1);
    expect(messages[0].metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds]: ['r1'],
      [RUNTIME_CONTEXT_METADATA_KEYS.claimTokens]: ['tok-1'],
    });
  });

  it('returns an empty array when no usable rows remain', () => {
    const ids = deterministicIds('mb');
    const rows = [makeMailboxRow({ id: 'r1', kind: 'stop' })];

    expect(adaptMailboxRows(rows, ['tok-1'], options(ids.next))).toEqual([]);
  });

  it('does not mutate the input rows array', () => {
    const ids = deterministicIds('mb');
    const rows = [makeMailboxRow({ id: 'r1', kind: 'followup' })];
    const before = structuredClone(rows);

    adaptMailboxRows(rows, ['tok-1'], options(ids.next));

    expect(rows).toEqual(before);
  });
});

// ─── adaptTaskNotificationXml ────────────────────────────────────────────

describe('adaptTaskNotificationXml', () => {
  it('produces a hidden transient runtime_context with source=background_notification', () => {
    const ids = deterministicIds('tn');
    const xml = makeNotificationXml('task-1');

    const msg = adaptTaskNotificationXml(xml, options(ids.next));

    expect(msg.kind).toBe('runtime_context');
    expect(msg.source).toBe('background_notification');
    expect(msg.persistence).toBe('transient');
    expect(msg.visibility).toBe('hidden');
    expect(msg.includeInModel).toBe(true);
    expect(msg.content).toBe(xml);
  });

  it('parses task-id, tool-use-id, and status into metadata', () => {
    const ids = deterministicIds('tn');
    const xml = makeNotificationXml('task-42', {
      toolUseId: 'tu_abc',
      status: 'failed',
    });

    const msg = adaptTaskNotificationXml(xml, options(ids.next));

    expect(msg.metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.taskId]: 'task-42',
      [RUNTIME_CONTEXT_METADATA_KEYS.toolUseId]: 'tu_abc',
      [RUNTIME_CONTEXT_METADATA_KEYS.taskStatus]: 'failed',
    });
  });

  it('omits taskId metadata when the XML has no <task-id> tag', () => {
    const ids = deterministicIds('tn');
    const xml = '<task-notification><status>completed</status></task-notification>';

    const msg = adaptTaskNotificationXml(xml, options(ids.next));

    expect(msg.metadata?.[RUNTIME_CONTEXT_METADATA_KEYS.taskId]).toBeUndefined();
    expect(msg.metadata?.[RUNTIME_CONTEXT_METADATA_KEYS.taskStatus]).toBe('completed');
  });

  it('preserves the raw XML as content for the model and renderer', () => {
    const ids = deterministicIds('tn');
    const xml = makeNotificationXml('task-1', { finalMessage: 'all done' });

    const msg = adaptTaskNotificationXml(xml, options(ids.next));

    expect(msg.content).toBe(xml);
    expect(msg.content).toContain('<task-notification>');
    expect(msg.content).toContain('all done');
  });
});

// ─── Multiple notification ordering ──────────────────────────────────────

describe('multiple notification ordering', () => {
  it('preserves drain order across sequential notifications', () => {
    const ids = deterministicIds('tn');
    const xmls = [
      makeNotificationXml('task-a'),
      makeNotificationXml('task-b'),
      makeNotificationXml('task-c'),
    ];

    const messages = xmls.map((xml) => adaptTaskNotificationXml(xml, options(ids.next)));

    expect(messages.map((m) => m.id)).toEqual(['tn-1', 'tn-2', 'tn-3']);
    expect(messages.map((m) => m.metadata?.[RUNTIME_CONTEXT_METADATA_KEYS.taskId])).toEqual([
      'task-a',
      'task-b',
      'task-c',
    ]);
  });

  it('preserves order when interleaved with mailbox guidance', () => {
    const ids = deterministicIds('mix');
    const mailboxMsg = adaptMailboxRows(
      [makeMailboxRow({ id: 'mb-1', kind: 'followup' })],
      ['tok-1'],
      options(ids.next),
    )[0];
    const notifMsg = adaptTaskNotificationXml(
      makeNotificationXml('task-1'),
      options(ids.next),
    );
    const customMsg = adaptCustomRuntimeContext('env hint', options(ids.next));

    const mixed: AgentMessage[] = [mailboxMsg, notifMsg, customMsg];

    expect(mixed.map((m) => m.id)).toEqual(['mix-1', 'mix-2', 'mix-3']);
    expect(mixed.map((m) => m.kind)).toEqual([
      'runtime_context',
      'runtime_context',
      'runtime_context',
    ]);
    expect(
      mixed.map((m) => (m.kind === 'runtime_context' ? m.source : null)),
    ).toEqual(['mailbox', 'background_notification', 'custom']);
  });
});

// ─── Repeated drain + deduplication ──────────────────────────────────────

describe('dedupeRuntimeContextMessages', () => {
  it('drops a task notification drained twice by task-id', () => {
    const ids = deterministicIds('tn');
    const xml = makeNotificationXml('task-dup');
    const first = adaptTaskNotificationXml(xml, options(ids.next));
    const second = adaptTaskNotificationXml(xml, options(ids.next));

    const result = dedupeRuntimeContextMessages([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tn-1');
  });

  it('keeps distinct task notifications and drops only the duplicate', () => {
    const ids = deterministicIds('tn');
    const a1 = adaptTaskNotificationXml(makeNotificationXml('task-a'), options(ids.next));
    const b1 = adaptTaskNotificationXml(makeNotificationXml('task-b'), options(ids.next));
    const a2 = adaptTaskNotificationXml(makeNotificationXml('task-a'), options(ids.next));
    const c1 = adaptTaskNotificationXml(makeNotificationXml('task-c'), options(ids.next));

    const result = dedupeRuntimeContextMessages([a1, b1, a2, c1]);

    expect(result.map((m) => m.id)).toEqual(['tn-1', 'tn-2', 'tn-4']);
  });

  it('drops a mailbox message when all its row IDs were already seen', () => {
    const ids = deterministicIds('mb');
    const first = adaptMailboxRows(
      [makeMailboxRow({ id: 'r1', kind: 'followup' }), makeMailboxRow({ id: 'r2', kind: 'followup' })],
      ['tok-1', 'tok-2'],
      options(ids.next),
    )[0];
    // Second drain re-includes r1 and r2 — all already seen.
    const second = adaptMailboxRows(
      [makeMailboxRow({ id: 'r1', kind: 'followup' }), makeMailboxRow({ id: 'r2', kind: 'followup' })],
      ['tok-3', 'tok-4'],
      options(ids.next),
    )[0];

    const result = dedupeRuntimeContextMessages([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mb-1');
  });

  it('keeps a mailbox message when partial overlap introduces new row IDs', () => {
    const ids = deterministicIds('mb');
    const first = adaptMailboxRows(
      [makeMailboxRow({ id: 'r1', kind: 'followup' })],
      ['tok-1'],
      options(ids.next),
    )[0];
    // Second drain includes r1 (seen) and r3 (new) — keep because r3 is new.
    const second = adaptMailboxRows(
      [makeMailboxRow({ id: 'r1', kind: 'followup' }), makeMailboxRow({ id: 'r3', kind: 'followup' })],
      ['tok-2', 'tok-3'],
      options(ids.next),
    )[0];

    const result = dedupeRuntimeContextMessages([first, second]);

    expect(result).toHaveLength(2);
    expect(result[1].metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds]: ['r1', 'r3'],
    });
  });

  it('dedupes hard replacement by mailbox row ID', () => {
    const ids = deterministicIds('hr');
    const row = makeMailboxRow({ id: 'replace-1', kind: 'abort_and_replace', content: 'new task' });
    const first = adaptMailboxHardReplacement(row, 'tok-1', options(ids.next));
    const second = adaptMailboxHardReplacement(row, 'tok-2', options(ids.next));

    const result = dedupeRuntimeContextMessages([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('hr-1');
  });

  it('passes through non-runtime-context messages untouched', () => {
    const ids = deterministicIds('tn');
    const notif = adaptTaskNotificationXml(
      makeNotificationXml('task-1'),
      options(ids.next),
    );
    const userMsg: AgentMessage = {
      kind: 'user',
      id: 'u1',
      createdAt: FIXED_NOW,
      persistence: 'durable',
      visibility: 'visible',
      content: 'hello',
    };

    const result = dedupeRuntimeContextMessages<AgentMessage>([userMsg, notif, userMsg]);

    expect(result.map((m) => m.id)).toEqual(['u1', 'tn-1', 'u1']);
  });

  it('does not mutate the input array', () => {
    const ids = deterministicIds('tn');
    const a = adaptTaskNotificationXml(makeNotificationXml('task-a'), options(ids.next));
    const b = adaptTaskNotificationXml(makeNotificationXml('task-a'), options(ids.next));
    const input: AgentMessage[] = [a, b];
    const before = structuredClone(input);

    dedupeRuntimeContextMessages(input);

    expect(input).toEqual(before);
  });
});

// ─── Hard replacement ────────────────────────────────────────────────────

describe('adaptMailboxHardReplacement', () => {
  it('wraps abort_and_replace content in <runtime-user-replacement> with source=mailbox', () => {
    const ids = deterministicIds('hr');
    const row = makeMailboxRow({
      id: 'replace-1',
      kind: 'abort_and_replace',
      content: '  switch to plan B  ',
    });

    const msg = adaptMailboxHardReplacement(row, 'tok-1', options(ids.next));

    expect(msg.kind).toBe('runtime_context');
    expect(msg.source).toBe('mailbox');
    expect(msg.persistence).toBe('transient');
    expect(msg.visibility).toBe('hidden');
    expect(msg.includeInModel).toBe(true);
    expect(msg.content).toContain('<runtime-user-replacement>');
    expect(msg.content).toContain('switch to plan B');
  });

  it('preserves the row ID and claim token in metadata', () => {
    const ids = deterministicIds('hr');
    const row = makeMailboxRow({ id: 'replace-1', kind: 'abort_and_replace', source: 'cli' });

    const msg = adaptMailboxHardReplacement(row, 'tok-xyz', options(ids.next));

    expect(msg.metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds]: ['replace-1'],
      [RUNTIME_CONTEXT_METADATA_KEYS.claimTokens]: ['tok-xyz'],
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxKinds]: ['abort_and_replace'],
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxSource]: 'cli',
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxHardReplacement]: true,
    });
  });

  it('falls back to a default message when content is empty', () => {
    const ids = deterministicIds('hr');
    const row = makeMailboxRow({ id: 'replace-1', kind: 'abort_and_replace', content: '   ' });

    const msg = adaptMailboxHardReplacement(row, null, options(ids.next));

    expect(msg.content).toContain('The user replaced the previous instruction.');
    expect(msg.metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.claimTokens]: [],
    });
  });
});

// ─── Attachment context ──────────────────────────────────────────────────

describe('adaptAttachmentContext', () => {
  it('builds a hidden durable runtime_context from parseable attachments', () => {
    const ids = deterministicIds('att');
    const attachments = [
      makeAttachment({ id: 'a1', name: 'notes.txt', text: 'meeting notes' }),
    ];

    const msg = adaptAttachmentContext(attachments, options(ids.next));

    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe('runtime_context');
    expect(msg!.source).toBe('attachment');
    expect(msg!.persistence).toBe('durable');
    expect(msg!.visibility).toBe('hidden');
    expect(msg!.includeInModel).toBe(true);
    expect(msg!.content).toContain('meeting notes');
    expect(msg!.metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds]: ['a1'],
      [RUNTIME_CONTEXT_METADATA_KEYS.attachmentNames]: ['notes.txt'],
    });
  });

  it('returns null when no attachment yields context', () => {
    const ids = deterministicIds('att');
    const attachments = [
      makeAttachment({ id: 'a1', name: 'empty.bin', type: 'application/octet-stream', text: undefined }),
    ];

    const msg = adaptAttachmentContext(attachments, options(ids.next));

    expect(msg).toBeNull();
  });
});

// ─── Custom runtime context ──────────────────────────────────────────────

describe('adaptCustomRuntimeContext', () => {
  it('produces a visible transient runtime_context with source=custom', () => {
    const ids = deterministicIds('cu');
    const msg = adaptCustomRuntimeContext('environment: production', options(ids.next));

    expect(msg.kind).toBe('runtime_context');
    expect(msg.source).toBe('custom');
    expect(msg.persistence).toBe('transient');
    expect(msg.visibility).toBe('visible');
    expect(msg.includeInModel).toBe(true);
    expect(msg.content).toBe('environment: production');
  });
});

// ─── Transient not persisted ─────────────────────────────────────────────

describe('transient messages are not persisted', () => {
  it('mailbox, notification, replacement, and custom produce persistence=transient; attachment produces persistence=durable', () => {
    const ids = deterministicIds('all');
    const opt = options(ids.next);

    const mailboxMsg = adaptMailboxRows(
      [makeMailboxRow({ id: 'r1', kind: 'followup' })],
      ['tok-1'],
      opt,
    )[0];
    const notifMsg = adaptTaskNotificationXml(makeNotificationXml('task-1'), opt);
    const replaceMsg = adaptMailboxHardReplacement(
      makeMailboxRow({ id: 'r2', kind: 'abort_and_replace' }),
      'tok-2',
      opt,
    );
    const attachmentMsg = adaptAttachmentContext([makeAttachment()], opt);
    const customMsg = adaptCustomRuntimeContext('hint', opt);

    for (const msg of [mailboxMsg, notifMsg, replaceMsg, customMsg]) {
      expect(msg).toMatchObject({ persistence: 'transient' });
    }
    expect(attachmentMsg).toMatchObject({ persistence: 'durable' });
  });

  it('projectPersistenceMessages drops every adapter-produced message', () => {
    const ids = deterministicIds('all');
    const opt = options(ids.next);

    const messages: AgentMessage[] = [
      adaptMailboxRows(
        [makeMailboxRow({ id: 'r1', kind: 'followup' })],
        ['tok-1'],
        opt,
      )[0],
      adaptTaskNotificationXml(makeNotificationXml('task-1'), opt),
      adaptMailboxHardReplacement(
        makeMailboxRow({ id: 'r2', kind: 'abort_and_replace' }),
        'tok-2',
        opt,
      ),
      adaptCustomRuntimeContext('hint', opt),
    ];

    const persisted = projectPersistenceMessages(messages);

    expect(persisted).toEqual([]);
  });
});

// ─── Provider compatibility projection ───────────────────────────────────

describe('projectRuntimeContextToProviderMessage', () => {
  it('projects an includeInModel runtime_context to a user-role Message', () => {
    const ids = deterministicIds('proj');
    const msg = adaptTaskNotificationXml(
      makeNotificationXml('task-1'),
      options(ids.next),
    );

    const projected = projectRuntimeContextToProviderMessage(msg);

    expect(projected).not.toBeNull();
    expect(projected!.id).toBe(msg.id);
    expect(projected!.role).toBe('user');
    expect(projected!.content).toBe(msg.content);
    expect(projected!.timestamp).toBe(msg.createdAt);
    expect(projected!.metadata).toEqual({
      runtimeContext: true,
      source: 'background_notification',
    });
  });

  it('returns null when includeInModel is false', () => {
    const ids = deterministicIds('proj');
    const msg = adaptCustomRuntimeContext(
      'hidden hint',
      options(ids.next, { includeInModel: false }),
    );

    expect(projectRuntimeContextToProviderMessage(msg)).toBeNull();
  });

  it('does not carry internal tracking metadata into the provider message', () => {
    const ids = deterministicIds('proj');
    const msg = adaptMailboxRows(
      [makeMailboxRow({ id: 'r1', kind: 'followup' })],
      ['tok-secret'],
      options(ids.next),
    )[0];

    const projected = projectRuntimeContextToProviderMessage(msg);

    expect(projected!.metadata).not.toHaveProperty(
      RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds,
    );
    expect(projected!.metadata).not.toHaveProperty(
      RUNTIME_CONTEXT_METADATA_KEYS.claimTokens,
    );
    expect(projected!.metadata).toEqual({
      runtimeContext: true,
      source: 'mailbox',
    });
  });

  it('does not mutate the domain message', () => {
    const ids = deterministicIds('proj');
    const msg = adaptTaskNotificationXml(
      makeNotificationXml('task-1'),
      options(ids.next),
    );
    const before = structuredClone(msg);

    projectRuntimeContextToProviderMessage(msg);

    expect(msg).toEqual(before);
  });
});

// ─── Options overrides ───────────────────────────────────────────────────

describe('option overrides', () => {
  it('respects visibility and includeInModel overrides', () => {
    const ids = deterministicIds('ov');
    const msg = adaptMailboxRows(
      [makeMailboxRow({ id: 'r1', kind: 'followup' })],
      ['tok-1'],
      options(ids.next, { visibility: 'visible', includeInModel: false }),
    )[0];

    expect(msg.visibility).toBe('visible');
    expect(msg.includeInModel).toBe(false);
  });

  it('merges caller metadata with adapter metadata', () => {
    const ids = deterministicIds('ov');
    const msg = adaptCustomRuntimeContext(
      'hint',
      options(ids.next, { metadata: { callerKey: 'callerVal' } }),
    );

    expect(msg.metadata).toMatchObject({ callerKey: 'callerVal' });
  });

  it('records seqIndex in metadata', () => {
    const ids = deterministicIds('ov');
    const msg = adaptTaskNotificationXml(
      makeNotificationXml('task-1'),
      options(ids.next, { seqIndex: 42 }),
    );

    expect(msg.metadata).toMatchObject({ seqIndex: 42 });
  });
});
