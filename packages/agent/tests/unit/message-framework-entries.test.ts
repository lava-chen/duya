import { describe, expect, it } from 'vitest';
import {
  MessageTimeline,
  buildAgentContext,
  type AgentMessage,
  type BranchEntry,
  type CustomStateEntry,
  type MessageEntry,
  type ModelChangeEntry,
  type ModeChangeEntry,
} from '../../src/message/message-framework.js';

const createdAt = 1_700_000_000_000;

function user(id: string, content: string): AgentMessage {
  return {
    kind: 'user',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    content,
  };
}

function messageEntry(
  id: string,
  message: AgentMessage,
  parentId: string | null = null,
): MessageEntry {
  return { type: 'message', id, parentId, createdAt, message };
}

function modelChangeEntry(id: string, overrides: Partial<ModelChangeEntry> = {}): ModelChangeEntry {
  return {
    type: 'model_change',
    id,
    parentId: null,
    createdAt,
    fromModel: 'claude-3-5-sonnet',
    toModel: 'claude-3-7-sonnet',
    fromProvider: 'anthropic',
    toProvider: 'anthropic',
    reason: 'user switched',
    ...overrides,
  };
}

function modeChangeEntry(id: string, overrides: Partial<ModeChangeEntry> = {}): ModeChangeEntry {
  return {
    type: 'mode_change',
    id,
    parentId: null,
    createdAt,
    fromMode: 'general',
    toMode: 'plan',
    reason: 'enter plan mode',
    source: 'user',
    ...overrides,
  };
}

function branchEntry(id: string, overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    type: 'branch',
    id,
    parentId: null,
    createdAt,
    branchId: 'branch-1',
    fromEntryId: 'entry-u1',
    label: 'investigate',
    ...overrides,
  };
}

function customStateEntry(id: string, overrides: Partial<CustomStateEntry> = {}): CustomStateEntry {
  return {
    type: 'custom_state',
    id,
    parentId: null,
    createdAt,
    stateKind: 'checkpoint',
    payload: { completed: true },
    ...overrides,
  };
}

describe('MessageTimeline new entry types', () => {
  it('appends model_change entries and keeps them in snapshot order', () => {
    const timeline = new MessageTimeline();
    timeline.appendModelChange(modelChangeEntry('mc-1'));
    timeline.appendModelChange(modelChangeEntry('mc-2'));

    expect(timeline.snapshot().map((entry) => entry.id)).toEqual(['mc-1', 'mc-2']);
    expect(timeline.snapshot()[0]).toMatchObject({
      type: 'model_change',
      fromModel: 'claude-3-5-sonnet',
      toModel: 'claude-3-7-sonnet',
    });
  });

  it('appends mode_change entries and keeps them in snapshot order', () => {
    const timeline = new MessageTimeline();
    timeline.appendModeChange(modeChangeEntry('mode-1'));
    timeline.appendModeChange(modeChangeEntry('mode-2'));

    expect(timeline.snapshot().map((entry) => entry.id)).toEqual(['mode-1', 'mode-2']);
    expect(timeline.snapshot()[0]).toMatchObject({
      type: 'mode_change',
      fromMode: 'general',
      toMode: 'plan',
      source: 'user',
    });
  });

  it('appends branch entries and keeps them in snapshot order', () => {
    const timeline = new MessageTimeline();
    timeline.appendBranch(branchEntry('br-1'));
    timeline.appendBranch(branchEntry('br-2'));

    expect(timeline.snapshot().map((entry) => entry.id)).toEqual(['br-1', 'br-2']);
    expect(timeline.snapshot()[0]).toMatchObject({
      type: 'branch',
      branchId: 'branch-1',
      fromEntryId: 'entry-u1',
      label: 'investigate',
    });
  });

  it('appends custom_state entries and keeps them in snapshot order', () => {
    const timeline = new MessageTimeline();
    timeline.appendCustomState(customStateEntry('cs-1'));
    timeline.appendCustomState(customStateEntry('cs-2'));

    expect(timeline.snapshot().map((entry) => entry.id)).toEqual(['cs-1', 'cs-2']);
    expect(timeline.snapshot()[0]).toMatchObject({
      type: 'custom_state',
      stateKind: 'checkpoint',
      payload: { completed: true },
    });
  });

  it('snapshot returns the full ordered list across all entry types', () => {
    const timeline = new MessageTimeline();
    timeline.appendMessage(messageEntry('e-u1', user('u1', 'hello')));
    timeline.appendModelChange(modelChangeEntry('mc-1'));
    timeline.appendModeChange(modeChangeEntry('mode-1'));
    timeline.appendBranch(branchEntry('br-1'));
    timeline.appendCustomState(customStateEntry('cs-1'));

    const snapshot = timeline.snapshot();
    expect(snapshot.map((entry) => entry.type)).toEqual([
      'message',
      'model_change',
      'mode_change',
      'branch',
      'custom_state',
    ]);
  });

  it('rejects duplicate entry ids across all entry types', () => {
    const timeline = new MessageTimeline();
    timeline.appendModelChange(modelChangeEntry('shared-id'));

    expect(() => {
      timeline.appendModeChange(modeChangeEntry('shared-id'));
    }).toThrow('Duplicate timeline entry id');
  });

  it('rejects duplicate ids even when appended via different methods', () => {
    const timeline = new MessageTimeline();
    timeline.appendBranch(branchEntry('dup'));

    expect(() => {
      timeline.appendCustomState(customStateEntry('dup'));
    }).toThrow('Duplicate timeline entry id');
  });
});

describe('new entry type field completeness', () => {
  it('model_change records all optional fields', () => {
    const entry = modelChangeEntry('mc-1', {
      fromProvider: 'anthropic',
      toProvider: 'openai',
      reason: 'cost',
    });
    expect(entry.type).toBe('model_change');
    expect(entry.fromModel).toBe('claude-3-5-sonnet');
    expect(entry.toModel).toBe('claude-3-7-sonnet');
    expect(entry.fromProvider).toBe('anthropic');
    expect(entry.toProvider).toBe('openai');
    expect(entry.reason).toBe('cost');
    expect(entry.parentId).toBeNull();
    expect(entry.createdAt).toBe(createdAt);
  });

  it('mode_change records source and reason', () => {
    const entry = modeChangeEntry('mode-1', {
      source: 'agent',
      reason: 'auto-switch',
    });
    expect(entry.type).toBe('mode_change');
    expect(entry.fromMode).toBe('general');
    expect(entry.toMode).toBe('plan');
    expect(entry.source).toBe('agent');
    expect(entry.reason).toBe('auto-switch');
  });

  it('branch records branchId, fromEntryId and label', () => {
    const entry = branchEntry('br-1', {
      branchId: 'branch-9',
      fromEntryId: 'e-u2',
      label: 'alternate',
    });
    expect(entry.type).toBe('branch');
    expect(entry.branchId).toBe('branch-9');
    expect(entry.fromEntryId).toBe('e-u2');
    expect(entry.label).toBe('alternate');
  });

  it('custom_state records stateKind and payload', () => {
    const entry = customStateEntry('cs-1', {
      stateKind: 'memory',
      payload: { note: 'x' },
    });
    expect(entry.type).toBe('custom_state');
    expect(entry.stateKind).toBe('memory');
    expect(entry.payload).toEqual({ note: 'x' });
  });
});

describe('buildAgentContext with new entry types', () => {
  it('ignores model_change/mode_change/branch/custom_state as non-message entries', () => {
    const timeline = new MessageTimeline();
    timeline.appendMessage(messageEntry('e-u1', user('u1', 'hello')));
    timeline.appendModelChange(modelChangeEntry('mc-1'));
    timeline.appendModeChange(modeChangeEntry('mode-1'));
    timeline.appendBranch(branchEntry('br-1'));
    timeline.appendCustomState(customStateEntry('cs-1'));

    const projection = buildAgentContext(timeline.snapshot());

    // Only the real message is projected; the new entry types are ignored.
    expect(projection.messages.map((message) => message.id)).toEqual(['u1']);
    expect(projection.warnings).toEqual([]);
  });

  it('does not treat new entry types as compaction checkpoints', () => {
    const timeline = new MessageTimeline();
    timeline.appendMessage(messageEntry('e-u1', user('u1', 'hello')));
    timeline.appendModelChange(modelChangeEntry('mc-1'));
    timeline.appendBranch(branchEntry('br-1'));

    const projection = buildAgentContext(timeline.snapshot());

    expect(projection.compaction).toBeUndefined();
    expect(projection.warnings).toEqual([]);
  });
});