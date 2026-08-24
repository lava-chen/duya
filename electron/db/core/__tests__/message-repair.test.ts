/**
 * Tests for the read-side repair helper. These do not touch sqlite so they
 * run even when the Electron-ABI sqlite binary is held by a running DUYA.
 */

import { describe, expect, it } from 'vitest';
import { repairInterruptedToolCalls } from '../message-repair';
import type { TimelineEntryRow } from '../message-log';
import type { MessageEntry } from '@duya/agent/message';

// ─── Builders ───

function toolUseMsg(id: string, callId: string, createdAt: number): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      role: 'assistant',
      id,
      content: [{ type: 'tool_use', id: callId, name: 'Bash', input: {} }],
      timestamp: createdAt,
      msg_type: 'tool_use',
      tool_call_id: callId,
      visibility: 'visible',
    },
  };
}

function toolResultMsg(id: string, callId: string, createdAt: number): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      role: 'tool',
      id,
      content: 'tool output',
      timestamp: createdAt,
      tool_call_id: callId,
      visibility: 'visible',
    },
  };
}

function textMsg(id: string, text: string, createdAt: number): MessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      role: 'user',
      id,
      content: text,
      timestamp: createdAt,
      visibility: 'visible',
    },
  };
}

function row(entry: MessageEntry, seq: number): TimelineEntryRow {
  return { entry, seq };
}

// ─── Tests ───

describe('repairInterruptedToolCalls', () => {
  it('returns the input unchanged when every tool_use has a matching tool_result', () => {
    const rows: TimelineEntryRow[] = [
      row(textMsg('u-1', 'hello', 1), 1),
      row(toolUseMsg('a-1', 'call-1', 2), 2),
      row(toolResultMsg('t-1', 'call-1', 3), 3),
    ];
    const out = repairInterruptedToolCalls(rows);
    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'a-1', 't-1']);
  });

  it('synthesizes a tool_result for an unmatched tool_use (crash recovery)', () => {
    const rows: TimelineEntryRow[] = [
      row(textMsg('u-1', 'hello', 1), 1),
      row(toolUseMsg('a-1', 'call-1', 2), 2),
      // No tool_result for call-1. Simulates a hard crash mid-turn.
    ];

    const out = repairInterruptedToolCalls(rows);

    expect(out.map((r) => r.entry.id)).toEqual(['u-1', 'a-1', expect.stringMatching(/^repair:call-1$/)]);
    // The synthesized row is a tool-role message with a placeholder.
    const synthesized = out[2].entry as MessageEntry;
    expect(synthesized.message.role).toBe('tool');
    expect(synthesized.message.tool_call_id).toBe('call-1');
    expect(synthesized.message.content).toBe('[interrupted by crash]');
  });

  it('drops orphan tool_results (no matching tool_use anywhere)', () => {
    const rows: TimelineEntryRow[] = [
      row(toolResultMsg('t-1', 'orphan-call', 1), 1),
      row(textMsg('u-1', 'hi', 2), 2),
    ];

    const out = repairInterruptedToolCalls(rows);

    expect(out.map((r) => r.entry.id)).toEqual(['u-1']);
  });

  it('handles multiple unmatched tool_uses in one history', () => {
    const rows: TimelineEntryRow[] = [
      row(toolUseMsg('a-1', 'call-A', 1), 1),
      row(toolResultMsg('t-A', 'call-A', 2), 2),
      row(toolUseMsg('a-2', 'call-B', 3), 3), // unmatched
      row(toolUseMsg('a-3', 'call-C', 4), 4), // unmatched
    ];

    const out = repairInterruptedToolCalls(rows);

    expect(out.map((r) => r.entry.id)).toEqual([
      'a-1',
      't-A',
      'a-2',
      'a-3',
      'repair:call-B',
      'repair:call-C',
    ]);
  });

  it('preserves correct rows when no repair is required', () => {
    const rows: TimelineEntryRow[] = [];
    const out = repairInterruptedToolCalls(rows);
    expect(out).toEqual([]);
  });

  it('synthesized rows are appended at the end with seq > max(input.seq)', () => {
    const rows: TimelineEntryRow[] = [
      row(textMsg('u-1', 'hi', 1), 1),
      row(toolUseMsg('a-1', 'call-1', 2), 2),
      row(toolUseMsg('a-2', 'call-2', 3), 3),
    ];

    const out = repairInterruptedToolCalls(rows);
    const maxInputSeq = 3;
    const synthesizedSeqs = out.filter((r) => r.entry.id.startsWith('repair:')).map((r) => r.seq);
    expect(synthesizedSeqs.length).toBe(2);
    expect(synthesizedSeqs[0]).toBe(maxInputSeq + 1);
    expect(synthesizedSeqs[1]).toBe(maxInputSeq + 2);
  });

  it('handles mixed: orphan tool_result AND unmatched tool_use', () => {
    const rows: TimelineEntryRow[] = [
      row(toolResultMsg('t-orphan', 'orphan-call', 1), 1),
      row(toolUseMsg('a-1', 'real-call', 2), 2), // unmatched (no real result)
    ];

    const out = repairInterruptedToolCalls(rows);

    expect(out.map((r) => r.entry.id)).toEqual(['a-1', 'repair:real-call']);
  });
});