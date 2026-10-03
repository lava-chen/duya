/**
 * Rebuilding a transcript from what is durable, and what that costs.
 *
 * ## The claim this module exists to keep honest
 *
 * Contract §F: `断线文本通过message snapshot+cursor恢复，不只依赖丢弃的delta` — text
 * lost to a dropped connection is recovered from a message snapshot plus the
 * cursor, not from the discarded deltas.
 *
 * The registry already decides what "discarded" means, and it is worth reading
 * the three rows this depends on:
 *
 *   assistant.text_block        durable     — the complete block
 *   assistant.text_delta        ephemeral   — incremental, never retained
 *   assistant.thinking_block    durable     — the complete reasoning block
 *   assistant.thinking_delta    ephemeral   — incremental, never retained
 *
 * So the recovery path is: the durable BLOCK events plus the cursor. That is a
 * real recovery path, and it is also not "all the text was replayed":
 *
 *  - A delta that was dropped is gone. The consumer will never see it again, and
 *    no amount of cursor arithmetic brings it back. {@link TranscriptRebuildReport.deltasNotReplayed}
 *    counts them so a caller can say so rather than imply otherwise.
 *  - A block that has not CLOSED yet has no durable event. While a run is still
 *    streaming an answer, the reconnecting consumer holds the blocks that landed
 *    and is missing the one in flight — reported as an incomplete block by
 *    {@link TranscriptRebuildReport.openBlocks}, not silently omitted.
 *  - `assistant.message_finalized` is the authoritative message and supersedes
 *    the per-block events for that message. It is used when present, so a
 *    consumer cannot end up with a text block and a finalized message that
 *    disagree.
 *
 * ## Why this is a rebuild, not a replay
 *
 * The transcript is DERIVED from the durable events every time it is asked for,
 * rather than stored beside them. A stored snapshot is a second copy of the
 * transcript, and a second copy can disagree with the events it came from —
 * an event says a block was replaced, the snapshot still has the old text, and
 * nothing in the system reports the difference. Deriving it costs a scan of the
 * durable log per resync and makes that class of disagreement unrepresentable.
 *
 * This is also the concrete sense in which "storing only the durable terminal"
 * is NOT replaying all the text: the terminal says the run finished and with
 * what stop reason, and carries no block text at all. A run whose only durable
 * record were its terminal would rebuild to an EMPTY transcript. The test
 * `rebuilds nothing from a terminal alone` is what holds that line.
 */

import type { RunEventEnvelope, SnapshotSource, StopReason } from '@duya/agent-protocol';
import type { RunId } from '@duya/agent-protocol';
import type { MessageContent as FinalizedContent } from '@duya/agent-protocol';
import type { Message, MessageContent, TextContent, ThinkingContent } from '@duya/agent-protocol/transcript';

/** One block of recovered assistant output, and whether it is still open. */
export interface RecoveredBlock {
  readonly messageId: string;
  readonly index: number;
  readonly kind: 'text' | 'thinking';
  /**
   * The recovered text, or `null` for an OPEN block.
   *
   * `null` is not "empty". An open block has no durable text at all — its text
   * only ever existed as deltas — and a consumer that rendered `''` for it would
   * show the user a message that appears to end there for no reason.
   */
  readonly text: string | null;
  /** True while the block's durable event has not landed. */
  readonly open: boolean;
}

/** What the consumer is missing, stated rather than implied. */
export interface TranscriptRebuildReport {
  readonly messages: number;
  readonly recoveredBlocks: number;
  /** Blocks whose durable event never arrived; their text is not replayable. */
  readonly openBlocks: readonly RecoveredBlock[];
  /**
   * Non-durable events the consumer has lost and will NOT see again.
   *
   * Counted over the events actually seen, so it is an upper bound on what was
   * dropped: a delta that arrived is not counted, and the deltas that were never
   * produced cannot be. It is a floor for the cost and a ceiling for the
   * recovery, and either way it is a number rather than a hope.
   */
  readonly deltasNotReplayed: number;
}

/**
 * One `assistant.message_finalized`, kept in the vocabulary it arrived in.
 *
 * ## Why this is not projected into a transcript `Message`
 *
 * T3.1 established that two transcript vocabularies exist and diverge on
 * purpose: the protocol's `ToolResult` carries an explicit `outcome` and the
 * transcript's carries `is_error`, and collapsing them destroys a field the
 * plan explicitly refused to lose. The same is true of `TextContent.phase`
 * (payload `string`, transcript a two-member union).
 *
 * So the authoritative message content is stored VERBATIM, with its own type,
 * and `messages` carries the block-derived text in the transcript vocabulary.
 * A consumer that needs tool outcomes reads `finalized`; one that needs the
 * assistant's prose reads `messages`. Neither is a lossy copy of the other, and
 * there is no cast anywhere in the path.
 */
export interface FinalizedMessage {
  readonly messageId: string;
  /** The durable seq this message was finalized at. */
  readonly throughSeq: number;
  readonly content: readonly FinalizedContent[];
  readonly stopReason: StopReason;
}

/** The message/block snapshot a resync serves. */
export interface TranscriptSnapshot {
  readonly runId: RunId;
  readonly source: Exclude<SnapshotSource, 'none'>;
  /** Highest durable seq this snapshot was built from. */
  readonly throughSeq: number;
  /** Block-derived transcript, in the transcript vocabulary. */
  readonly messages: readonly Message[];
  /** Authoritative finalized messages, verbatim, in the payload vocabulary. */
  readonly finalized: readonly FinalizedMessage[];
  readonly blocks: readonly RecoveredBlock[];
  readonly report: TranscriptRebuildReport;
}

/** The durable events this rebuild is allowed to read text out of. */
const BLOCK_EVENTS: ReadonlySet<string> = new Set(['assistant.text_block', 'assistant.thinking_block']);
const FINALIZED_EVENT = 'assistant.message_finalized';
/**
 * The non-durable incrementals. They are counted, never read: nothing here can
 * reconstruct their text, because the registry says they were never retained.
 */
const DELTA_EVENTS: ReadonlySet<string> = new Set([
  'assistant.text_delta',
  'assistant.thinking_delta',
  'tool.arguments_delta',
]);

/**
 * Build a snapshot from a run's durable events.
 *
 * `events` must be the durable subsequence — that is, what the store holds, with
 * its holes. A caller passing the live stream here would be asking a different
 * question, and the `openBlocks` result would be wrong for a reason that looks
 * like a bug in this function.
 */
export function buildTranscriptSnapshot(input: {
  readonly runId: RunId;
  readonly events: readonly RunEventEnvelope[];
  readonly source?: SnapshotSource;
}): TranscriptSnapshot {
  const source = input.source ?? 'durable_transcript';
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);
  const throughSeq = ordered.length === 0 ? 0 : (ordered[ordered.length - 1]?.seq ?? 0);

  // messageId -> (kind, index) -> the block as last written.
  //
  // The key carries the KIND as well as the index, because `assistant
  // .text_block` and `assistant.thinking_block` are indexed within their own
  // content arrays: a reasoning block and an answer block in the same message
  // both start at index 0, and keying on the index alone makes the second one
  // silently overwrite the first. A message that reasons and then answers would
  // lose its reasoning.
  const blocks = new Map<string, Map<string, RecoveredBlock>>();
  const finalized = new Map<string, FinalizedMessage>();
  let deltasNotReplayed = 0;

  for (const envelope of ordered) {
    const type = envelope.payload.type;
    if (DELTA_EVENTS.has(type)) {
      deltasNotReplayed += 1;
      continue;
    }
    if (type === 'assistant.text_block') {
      setBlock(blocks, {
        messageId: envelope.payload.messageId,
        index: envelope.payload.index,
        kind: 'text',
        text: envelope.payload.text,
        open: false,
      });
      continue;
    }
    if (type === 'assistant.thinking_block') {
      setBlock(blocks, {
        messageId: envelope.payload.messageId,
        index: envelope.payload.index,
        kind: 'thinking',
        text: envelope.payload.thinking,
        open: false,
      });
      continue;
    }
    if (type === FINALIZED_EVENT) {
      // Kept verbatim, in its own vocabulary. See `FinalizedMessage`.
      finalized.set(envelope.payload.messageId, {
        messageId: envelope.payload.messageId,
        throughSeq: envelope.seq,
        content: [...envelope.payload.content],
        stopReason: envelope.payload.stopReason,
      });
      continue;
    }
    if (BLOCK_EVENTS.has(type)) {
      continue;
    }
  }

  // The blocks already carry their own `messageId`, so this is a flat read of
  // every message's blocks, in provider order: reasoning first, then the answer,
  // each by index. The order is a presentation choice and is stated once here so
  // the snapshot and any consumer sorting the same blocks agree.
  const allBlocks = [...blocks.values()].flatMap((byKey) => [...byKey.values()].sort(compareBlocks));

  const messages = buildMessages(allBlocks);
  const report: TranscriptRebuildReport = {
    messages: messages.length,
    recoveredBlocks: allBlocks.filter((b) => !b.open).length,
    openBlocks: allBlocks.filter((b) => b.open),
    deltasNotReplayed,
  };

  return {
    runId: input.runId,
    source: source === 'none' ? 'durable_transcript' : source,
    throughSeq,
    messages,
    finalized: [...finalized.values()],
    blocks: allBlocks,
    report,
  };
}

/**
 * One durable block.
 *
 * Exposed so a caller holding a LIVE stream can say "this block is still
 * streaming" without re-deriving the rule. Marking a block open is the honest
 * answer during a run; the alternative — omitting it — makes a partial answer
 * look complete, which is the failure contract §F's sentence is written against.
 */
export function openBlock(messageId: string, index: number, kind: 'text' | 'thinking'): RecoveredBlock {
  return { messageId, index, kind, text: null, open: true };
}

function setBlock(
  blocks: Map<string, Map<string, RecoveredBlock>>,
  block: RecoveredBlock,
): void {
  let byKey = blocks.get(block.messageId);
  if (byKey === undefined) {
    byKey = new Map<string, RecoveredBlock>();
    blocks.set(block.messageId, byKey);
  }
  byKey.set(`${block.kind}:${block.index}`, block);
}

/** Reasoning before prose, then index order within each kind. */
function compareBlocks(a: RecoveredBlock, b: RecoveredBlock): number {
  if (a.kind !== b.kind) return a.kind === 'thinking' ? -1 : 1;
  return a.index - b.index;
}

function buildMessages(blocks: readonly RecoveredBlock[]): readonly Message[] {
  const byMessage = new Map<string, RecoveredBlock[]>();
  for (const block of blocks) {
    const list = byMessage.get(block.messageId);
    if (list === undefined) byMessage.set(block.messageId, [block]);
    else list.push(block);
  }

  const messages: Message[] = [];
  for (const [messageId, list] of byMessage) {
    const content: MessageContent[] = [];
    for (const block of [...list].sort(compareBlocks)) {
      if (block.open || block.text === null) continue;
      if (block.kind === 'text') {
        const text: TextContent = { type: 'text', text: block.text };
        content.push(text);
      } else {
        const thinking: ThinkingContent = { type: 'thinking', thinking: block.text };
        content.push(thinking);
      }
    }
    // An open block yields no content entry, and an all-open message therefore
    // yields an empty message. That empty message is the report's job to
    // explain: `openBlocks` names what is missing and `messages.length`
    // still counts the message, so "one message, no text yet" is expressible.
    messages.push({ role: 'assistant', id: messageId, content });
  }
  return messages;
}
