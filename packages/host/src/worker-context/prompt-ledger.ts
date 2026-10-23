/**
 * The prompt ledger — what the model was actually shown, per turn.
 *
 * Plan 619 Phase 4. The question this answers is "what did the model
 * see on this turn", and a digest cannot answer it: the whole point is
 * the text. So the content is recorded.
 *
 * The volume is the catch. A system prompt is tens of kilobytes; a
 * hundred-turn session that wrote it every turn would add megabytes to
 * the rollout file and push a normal session past the 4 MB rotation
 * gate (the file may exceed the gate until the next compaction, so the
 * cost shows up as an unexpected rotation rather than an error).
 *
 * Two controls keep it in check, and neither loses information:
 *
 *   - a block whose bytes did not change since the last record is
 *     recorded by hash and length only, and
 *   - an optional quota caps how many times a full text is written per
 *     session.
 *
 * Neither is a redaction: the text of a turn that CHANGED is always
 * written, and the recorded hash proves which text a later turn had.
 */

import { createHash } from 'node:crypto';

import type {
  PromptSnapshotBlock,
  PromptSnapshotEvent,
  PromptSnapshotPart,
} from '@duya/agent-protocol/rollout-events';

import type { ContextBlock } from './context-rail.js';

/** A block as it was delivered on the message channel. */
export interface RecordedContextBlock {
  readonly id: string;
  readonly source: string;
  readonly role: 'system' | 'user';
  readonly content: string;
}

/** Per-session state of the ledger. */
export interface PromptLedgerState {
  /** Hash of the last system prompt written, or null before the first. */
  lastSystemHash: string | null;
  /** Hash of the last content written for each context block. */
  blockHashes: Map<string, string>;
  /** How many full texts this session has written. */
  fullWrites: number;
}

/**
 * How many full texts one session may write. 0 means no limit.
 *
 * Set `DUYA_PROMPT_LEDGER_MAX_FULL` to bound the rollout growth of very
 * long sessions. A changed system prompt is still recorded by hash
 * either way — only the text is capped.
 */
export function promptLedgerQuota(): number {
  const raw = process.env.DUYA_PROMPT_LEDGER_MAX_FULL;
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Whether the prompt is recorded at all.
 *
 * The snapshot stores the prompt TEXT, which is the same kind of content
 * the rollout already holds (the user's messages, the tool results, the
 * AGENTS.md bodies). It is still a copy of the system prompt, so the
 * switch exists: set `DUYA_PROMPT_LEDGER=off` to record nothing at all.
 */
export function promptLedgerEnabled(): boolean {
  return process.env.DUYA_PROMPT_LEDGER !== 'off';
}

/** Fresh ledger state for a session. */
export function newPromptLedgerState(): PromptLedgerState {
  return { lastSystemHash: null, blockHashes: new Map(), fullWrites: 0 };
}

/**
 * Build the snapshot record for a turn, and advance the ledger state.
 *
 * Returns the event to write, or null when there is nothing to record
 * (the system prompt is empty and there are no context blocks).
 */
export function buildPromptSnapshot(
  state: PromptLedgerState,
  input: {
    turnId: string;
    systemPrompt: string;
    contextBlocks: readonly RecordedContextBlock[];
    overridden?: boolean;
  },
): PromptSnapshotEvent | null {
  if (input.systemPrompt.length === 0 && input.contextBlocks.length === 0) return null;

  const quota = promptLedgerQuota();
  const systemPart = recordPart(
    state,
    'system',
    input.systemPrompt,
    quota,
  );
  const contextBlocks: PromptSnapshotBlock[] = [];
  for (const block of input.contextBlocks) {
    const part = recordPart(state, block.id, block.content, quota);
    contextBlocks.push({
      id: block.id,
      source: block.source,
      role: block.role,
      ...part,
    });
  }

  return {
    type: 'prompt_snapshot',
    id: `prompt_snapshot:${input.turnId}`,
    turnId: input.turnId,
    createdAt: Date.now(),
    systemPrompt: systemPart,
    contextBlocks,
    ...(input.overridden === undefined ? {} : { overridden: input.overridden }),
  };
}

/**
 * Record one piece of text: its hash and length always, its content
 * when it changed (and the quota allows).
 */
function recordPart(
  state: PromptLedgerState,
  slot: string,
  content: string,
  quota: number,
): PromptSnapshotPart {
  const hash = hashOf(content);
  const length = content.length;
  const previous = slot === 'system' ? state.lastSystemHash : state.blockHashes.get(slot);
  if (previous === hash) {
    return { hash, length, omitted: 'unchanged' };
  }
  if (quota > 0 && state.fullWrites >= quota) {
    return { hash, length, omitted: 'quota' };
  }
  state.fullWrites += 1;
  if (slot === 'system') {
    state.lastSystemHash = hash;
  } else {
    state.blockHashes.set(slot, hash);
  }
  return { hash, length, content };
}

/** SHA-256 of a text, hex encoded. */
export function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Convert the rail blocks into the recorded shape. */
export function toRecordedBlocks(
  blocks: readonly ContextBlock[],
): RecordedContextBlock[] {
  return blocks.map((block) => ({
    id: block.id,
    source: block.source,
    role: 'user' as const,
    content: block.content,
  }));
}
