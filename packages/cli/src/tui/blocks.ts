/**
 * The transcript block model, and the frame vocabulary it is built against.
 *
 * ## The vocabulary is measured, not assumed
 *
 * The CLI consumes `HeadlessRun.frames()` — an `AsyncGenerator` of
 * `LegacySseFrame` (`{ type: string, data?: unknown }`). The set of `type`
 * values that can actually arrive is the runtime projector's switch arms
 * (`packages/agent-runtime/src/project/legacy-sse-projector.ts`), because
 * `frames()` IS that projector applied to the run's events. The list below is
 * transcribed from those arms, not from the wider `LEGACY_SSE_TYPES` union —
 * the two differ, and building against the wider one would render frames this
 * path never produces while missing ones it does.
 *
 * ## The double-count trap
 *
 * This is the single most important thing to know about the frame stream, and
 * it is why the union below separates `text_delta` from `text`.
 *
 * The engine publishes BOTH, with overlapping content:
 *
 * - inside the model stream loop, every text fragment is published as
 *   `assistant.text_delta` (`engine/run-engine.ts:1266`), which projects to a
 *   `text_delta` frame;
 * - after the loop, the accumulated message is walked and each block is
 *   republished whole as `assistant.text_block` (`run-engine.ts:1355`), which
 *   projects to a `text` frame.
 *
 * So a `text` frame's content IS the concatenation of the `text_delta` frames
 * that preceded it. A model that appends both prints every answer twice. The
 * reducer below treats `text` as an AUTHORITATIVE replacement that also
 * finalises the block — never as an append. `appendTextDelta` and `finalizeText`
 * are separate methods for exactly this reason.
 *
 * The same holds for `thinking` / `thinking_delta`.
 *
 * ## Why running and finalized are the same object
 *
 * A tool line that is rebuilt from scratch on every update is a full-block
 * rewrite per update. Mutating one object means the renderer can address the
 * block it needs, and the tests can assert identity rather than equality.
 */

import { isTodoTool, parseTodoItems, type TuiTodoItem } from './todo.js';
import { shellCommandOf } from './tool-render.js';
import {
  readSubagentSpec,
  type SubagentCard,
} from './subagent.js';
import {
  parseToolFileDiff,
  type ToolFileDiff,
} from '@duya/agent-protocol/tool-file-diff';

/** A frame as the CLI receives it. Structurally `LegacySseFrame`. */
export interface LegacyFrame {
  readonly type: string;
  readonly data?: unknown;
  readonly id?: number;
}

/**
 * Every frame type `run.frames()` can yield, transcribed from the projector's
 * arms. `tool_timeout` is deliberately absent: the projector has no arm for
 * `tool.timed_out` (it returns `null`), so the pre-existing CLI arm for it
 * in `index.ts` is dead code.
 */
export const FRAME_TYPES = [
  'text',
  'text_delta',
  'thinking',
  'thinking_delta',
  'tool_use_started',
  'tool_use_delta',
  'tool_output',
  'tool_use',
  'tool_result',
  'tool_progress',
  'tool_group_progress',
  'permission',
  'turn_start',
  'token_usage',
  'status',
  'retry',
  'mode_changed',
  'goal_updated',
  'compact:start',
  'compact:done',
  'compact:error',
  'compact:step',
  'compact:over_threshold',
  'agent_progress',
  'done',
  'error',
] as const;

export type FrameType = (typeof FRAME_TYPES)[number];

/**
 * How much of a running command's output the model retains.
 *
 * A live row draws the last few lines, so this is a ceiling on memory, not a
 * render budget: it has to clear the render window by enough that the tail
 * survives a coalesced burst, and stay small enough that a transcript of many
 * running commands is not a buffer of build logs.
 */
export const OUTPUT_TAIL_MAX_CHARS = 8_192;

export type BlockKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'error' | 'notice';

export interface UserBlock {
  readonly kind: 'user';
  readonly id: string;
  text: string;
}

export interface AssistantBlock {
  readonly kind: 'assistant';
  readonly id: string;
  text: string;
  finalized: boolean;
}

export interface ThinkingBlock {
  readonly kind: 'thinking';
  readonly id: string;
  text: string;
  finalized: boolean;
  /**
   * Clock reading taken when the block was created.
   *
   * Only used to derive `durationMs` at seal time, and only for blocks this
   * process watched stream. A thinking block reconstructed from a reloaded
   * message arrives already complete and carries neither field, which is why
   * the header still says `Thought` rather than claiming a duration it never
   * measured.
   */
  startedAt?: number;
  /** How long the block streamed, frozen the first time it was sealed. */
  durationMs?: number;
}

/**
 * A tool call. `callId` is the run's own correlation id and is what makes
 * the running-to-finalized transition an identity mutation rather than a
 * replacement.
 */
export interface ToolBlock {
  readonly kind: 'tool';
  readonly id: string;
  readonly callId: string;
  name: string;
  preview: string;
  result?: string;
  status: 'running' | 'ok' | 'error' | 'unknown';
  /**
   * How long the call took, in the producer's own milliseconds.
   *
   * Kept as a number rather than read back out of `result`: the duration rides
   * the wire twice, once inside the model-facing envelope and once as this
   * field, and the renderer uses the field so the row can show it without the
   * envelope ever reaching the screen.
   */
  durationMs?: number;
  /**
   * The UNCLIPPED command of a shell tool.
   *
   * Kept beside `preview` because `preview` is clipped to one line and the
   * body's evidence line must show what actually ran. Full JSON payloads are
   * deliberately not retained: one string is what the body needs, and caching
   * every tool input would grow the model for no reader-visible gain.
   */
  command?: string;
  /**
   * The call blew its deadline (`tool.timed_out`).
   *
   * Separate from `status` because the two facts differ and both are true: a
   * timeout is what the volatile notice said, while a later durable completion
   * carrying `outcome: 'timeout'` sets `status: 'error'` with a result. Reading
   * either one as the other loses information the protocol deliberately keeps
   * apart. Set by the T11 view adapter, which is the only producer.
   */
  timedOut?: boolean;
  /**
   * The todo list this call wrote, when the call WAS a todo write.
   *
   * Present only for the `todo` tool and only once its result arrived, which
   * is why it is separate from `result`: the result is the raw JSON the tool
   * returned, this is the list the transcript draws.
   */
  todos?: readonly TuiTodoItem[];
  /**
   * The structured change set of a file-mutating call, once its result
   * arrived.
   *
   * The producer computed it while it still held the file's pre-image and
   * post-image, so the rows carry their own line numbers. Rendering from
   * here means the transcript never has to re-derive a diff from prose, and
   * every client shows the same numbers.
   */
  diff?: readonly ToolFileDiff[];
  /**
   * Per-operation failures of a partially applied change, verbatim from the
   * producer. A multi-file patch that landed three files and failed one
   * reports the failed one here; the diff carries the three that landed.
   */
  failures?: readonly string[];
  /**
   * The tool call's arguments as raw JSON, accumulated while they are still
   * arriving.
   *
   * The model streams a tool call's arguments (`tool.arguments_delta`), so for
   * a file write the text of the file exists in this buffer before the call
   * completes. It is not parsed into fields here: the preview reads what it
   * needs leniently at render time, the authoritative arguments replace it
   * when the call starts, and an expanded tool row uses it to show the full
   * invocation. This is separate from `command`, the unclipped shell command.
   */
  argumentText?: string;
  /**
   * The running command's OWN output, accumulated while it is still running.
   *
   * Beside `argumentText`, and the two must not be conflated: that buffer is
   * the model composing the call and stops growing at dispatch, this one starts
   * there and is what the process printed. A live shell row draws this; the
   * finished row draws `result`, which is the authoritative text and supersedes
   * it — so a renderer that preferred this after completion would keep showing
   * the tail the poller sampled rather than what the tool actually returned.
   *
   * Ephemeral by contract (`tool.output_delta` is `durability: 'ephemeral'`): a
   * reloaded transcript has no deltas to replay, so a restored row is rendered
   * from `result` alone and this stays absent.
   */
  outputText?: string;
  /**
   * The subagent this call spawned, when the call WAS a subagent spawn.
   *
   * Present only for the `task` tool (and its legacy `Agent` name). It is the
   * whole identity of the child — name, role, model, effort, brief — read from
   * the call's own arguments, then refined by `subagent.started` /
   * `subagent.completed` as those frames arrive. Kept beside `preview` for the
   * same reason `todos` is: the row is no longer "a tool called with an
   * argument", it is a child agent with a lifecycle, and the renderer needs the
   * fields rather than a string.
   */
  subagent?: SubagentCard;
}

export interface ErrorBlock {
  readonly kind: 'error';
  readonly id: string;
  message: string;
}

export interface NoticeBlock {
  readonly kind: 'notice';
  readonly id: string;
  text: string;
}

export type Block =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | ErrorBlock
  | NoticeBlock;

/** A permission request, routed to the overlay rather than the transcript. */
export interface PermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly reason: string;
  readonly blockedPath?: string;
  /**
   * The interactive situation, as classified by the runtime (never inferred
   * here — protocol G-2). `ask_user_question` picks the questionnaire overlay
   * instead of the allow/deny picker.
   */
  readonly mode?: 'generic' | 'ask_user_question' | 'exit_plan_mode';
}

/** What applying a frame did, so the caller knows whether to schedule a render. */
export type ApplyResult =
  | { readonly kind: 'none' }
  /** An existing block was mutated in place. Nothing was appended. */
  | { readonly kind: 'mutate'; readonly block: Block }
  /** A block was added to the transcript. */
  | { readonly kind: 'append'; readonly block: Block }
  /** The frame drives the overlay, not the transcript. */
  | { readonly kind: 'permission'; readonly request: PermissionRequest };

/** Read `data.content`, tolerating both shapes the wire uses. */
export function readFrameContent(frame: LegacyFrame): string {
  const { data } = frame;
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null) {
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

/**
 * Read a frame payload as a record, or `{}` when it is not one.
 *
 * Exported because the activity tracker and the app both need it: two copies of
 * "is this payload an object" is how one of them ends up accepting an array and
 * reading `data[0]` as a field name.
 */
export function frameRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A string field of a payload, or `''` — never `undefined` leaking into a template. */
export function frameString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** Read `data` as a record, or `{}` when it is not one. */
function payloadOf(frame: LegacyFrame): Record<string, unknown> {
  return frameRecord(frame.data);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A finite number, or 0. A non-number is a missing number here, not a NaN one. */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Arguments worth previewing, per tool, in presentation order.
 *
 * REAL tool names. The previous table listed the pre-capabilities vocabulary
 * (`read_file`, `search_files`, `terminal`) and every entry was dead: `glob`
 * and `grep` fell through to the generic "first string value" branch, which
 * summarised a grep call by its pattern only by accident and a glob call by
 * nothing useful at all. Legacy names are kept alongside the real ones so an
 * older transcript still reads correctly.
 */
const TOOL_PREVIEW_KEYS: Readonly<Record<string, readonly string[]>> = {
  grep: ['pattern', 'path'],
  glob: ['pattern', 'path'],
  read: ['path'],
  edit: ['path'],
  write: ['path'],
  apply_patch: ['path'],
  bash: ['command'],
  powershell: ['command'],
  // A command the user ran themselves.
  local_shell: ['command'],
  // Legacy aliases, same shapes.
  read_file: ['path'],
  write_file: ['path'],
  patch: ['path'],
  search_files: ['pattern', 'path'],
  terminal: ['command'],
  // Other families where a named argument still beats a bare value.
  web_search: ['query'],
  web_fetch: ['url'],
  web_extract: ['urls'],
  task: ['description'],
  todo: ['todos'],
  memory: ['action'],
  session_search: ['query'],
  image_generate: ['prompt'],
  image_edit: ['prompt'],
  vision: ['question'],
  skill_view: ['name'],
};

/** Longest preview before it is elided. */
const PREVIEW_MAX = 56;

/** Longest a single argument value may be before it is elided. */
const PREVIEW_VALUE_MAX = 32;

/** Clip one argument's value inside an argument list. */
function clipValue(value: string): string {
  return value.length > PREVIEW_VALUE_MAX ? `${value.slice(0, PREVIEW_VALUE_MAX - 3)}...` : value;
}

/** Clip a whole preview to one line's worth of a tool call. */
function clip(value: string): string {
  return value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX - 3)}...` : value;
}

/** Read one argument as displayable text, or `null` when it is not. */
function readArgument(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value) && value.length > 0) return value.map((entry) => String(entry)).join(', ');
  return null;
}

/**
 * A one-line summary of a tool call.
 *
 * A named tool with MORE than one telling argument renders as an argument list
 * — `grep(pattern: useStreaming, path: src/)` — because on a desktop terminal
 * in a monospace font that reads better than a bare value: the reader learns
 * WHICH argument they are looking at without opening the call. A single
 * argument stays bare (`read(src/main.ts)`), since `path:` would spend five
 * columns saying nothing.
 */
export function buildToolPreview(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  const keys = TOOL_PREVIEW_KEYS[name];
  if (keys !== undefined) {
    // The decision is the number of arguments actually PRESENT, not the width
    // of the table: a glob call that only passed a pattern is a single
    // argument and reads better bare, even though a path could have joined it.
    const present: Array<{ key: string; value: string }> = [];
    for (const key of keys) {
      const value = readArgument(record[key]);
      if (value !== null) present.push({ key, value });
    }
    if (present.length === 1) return clip(present[0]?.value ?? '');
    if (present.length > 1) {
      return clip(present.map(({ key, value }) => `${key}: ${clipValue(value)}`).join(', '));
    }
    // A named tool whose expected arguments are absent falls through to the
    // generic first-string fallback rather than rendering an empty head.
  }
  for (const value of Object.values(record)) {
    const text = readArgument(value);
    if (text !== null) return clip(text);
  }
  return '';
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** Test seam: make generated block ids deterministic across runs. */
export function resetBlockIds(): void {
  sequence = 0;
}

/**
 * The identity of one content block within an assistant message.
 *
 * `assistant.text_block` / `thinking_block` and their delta siblings carry
 * `messageId` + `index`, so two blocks of the same turn never collide and the
 * same block never splits. Keying on this — rather than on arrival order — is
 * what lets the transcript hold `text / tool / text` as THREE blocks in the
 * order they arrived.
 */
export function blockKey(messageId: string, index: number): string {
  return `${messageId}#${index}`;
}

/** Read the block key off a frame payload, or `null` when it carries none. */
export function readBlockKey(payload: Record<string, unknown>): string | null {
  const messageId = asString(payload['messageId']);
  if (messageId === '') return null;
  const index = payload['index'];
  return blockKey(messageId, typeof index === 'number' && Number.isFinite(index) ? index : 0);
}

/**
 * Freeze a thinking block's measured duration the first time it is sealed.
 *
 * First seal wins. A tool call seals the block, and the whole-block frame that
 * arrives after it must not restart the clock from that later timestamp —
 * otherwise the header would report the gap between the two frames instead of
 * the time the model actually spent thinking.
 */
function sealThinkingDuration(block: ThinkingBlock, at: number): void {
  if (block.durationMs !== undefined || block.startedAt === undefined) return;
  block.durationMs = Math.max(0, at - block.startedAt);
}

/**
 * One line saying how a permission question ended.
 *
 * The verb is derived from the protocol action, never from whether the user was
 * the one who answered: a host denial and a timeout denial reach the reader
 * through the same line, and the difference is in the audit chain, not the
 * prompt.
 */
function permissionResolutionLine(action: string, toolName: string, reason: string): string {
  const verb = action === 'deny' ? 'denied' : action === 'defer' ? 'deferred' : action;
  const suffix = reason === '' ? '' : ` (${reason})`;
  return `Permission ${verb}${toolName === '' ? '' : ` for ${toolName}`}${suffix}`;
}

export class TranscriptModel {
  private readonly items: Block[] = [];
  private readonly toolsByCallId = new Map<string, ToolBlock>();
  private readonly assistantsByKey = new Map<string, AssistantBlock>();
  private readonly thinkingByKey = new Map<string, ThinkingBlock>();
  private assistant: AssistantBlock | null = null;
  private thinking: ThinkingBlock | null = null;
  /** Characters in the transcript a model request would carry. See `contextChars`. */
  private contextCharCount = 0;

  /**
   * Content revisions, one entry per block id.
   *
   * Every mutator below bumps the revision of the block it touched, and the
   * render cache keys on `id + revision` instead of re-deriving a content
   * hash each frame — hashing every block's full text per frame was
   * O(document chars) and what made long-session streaming lag. Sound because
   * every block is created and mutated here and nowhere else, and ids never
   * repeat within a process (`nextId` is module-monotonic).
   */
  private readonly revisions = new Map<string, number>();

  /** The blocks, in order. */
  get blocks(): readonly Block[] {
    return this.items;
  }

  /** Content revision of a block — cheap, monotone cache-key material. */
  revisionOf(block: Block): number {
    return this.revisions.get(block.id) ?? 0;
  }

  /** Record that a block's rendered form is about to change. */
  private bump(block: Block): void {
    this.revisions.set(block.id, (this.revisions.get(block.id) ?? 0) + 1);
  }

  /** Mark a content block final — a rendering fact, so it counts as a mutation. */
  private seal(block: AssistantBlock | ThinkingBlock): void {
    block.finalized = true;
    this.bump(block);
  }

  /** Add a block the user typed. */
  addUser(text: string): UserBlock {
    this.closeOpenContent();
    const block: UserBlock = { kind: 'user', id: nextId('user'), text };
    this.items.push(block);
    this.contextCharCount += text.length;
    return block;
  }

  /**
   * Characters currently in the transcript that a model request would carry.
   *
   * This is the raw material for a CONTEXT estimate: the provider's usage says
   * how many tokens the last request cost, and this says how much has been
   * added since. It counts what actually goes back to the model — the user's
   * words, the assistant's answers, the reasoning, and the tool calls with
   * their results — because those are the parts that occupy the window.
   *
   * Maintained incrementally rather than recomputed: the footer asks for it on
   * every frame, and walking ten thousand blocks per frame is the kind of cost
   * the transcript cache exists to avoid.
   */
  get contextChars(): number {
    return this.contextCharCount;
  }

  /** Chars of a tool input, as the request would carry them. */
  private static inputLength(input: unknown): number {
    if (typeof input === 'string') return input.length;
    if (typeof input !== 'object' || input === null) return 0;
    try {
      return JSON.stringify(input)?.length ?? 0;
    } catch {
      return 0;
    }
  }

  /** The assistant block currently receiving deltas, if any. */
  get activeAssistant(): AssistantBlock | null {
    return this.assistant;
  }

  get activeThinking(): ThinkingBlock | null {
    return this.thinking;
  }

  /**
   * Append a streamed text fragment to its block.
   *
   * With a `key`, the fragment lands on the block that key already owns, so
   * deltas belonging to different content blocks cannot merge. Without one
   * (the plain REPL, older fixtures) it lands on the live block, which is the
   * pre-identity behaviour and stays correct for a single-block message.
   */
  appendTextDelta(text: string, key: string | null = null): AssistantBlock | null {
    if (text.length === 0) return this.assistant;
    if (key !== null) {
      const existing = this.assistantsByKey.get(key);
      if (existing !== undefined) {
        existing.text += text;
        this.bump(existing);
        this.contextCharCount += text.length;
        return existing;
      }
    }
    if (this.assistant === null || key !== null) {
      if (this.assistant !== null) this.seal(this.assistant);
      this.assistant = { kind: 'assistant', id: nextId('assistant'), text: '', finalized: false };
      this.items.push(this.assistant);
      if (key !== null) this.assistantsByKey.set(key, this.assistant);
    }
    this.assistant.text += text;
    this.bump(this.assistant);
    this.contextCharCount += text.length;
    return this.assistant;
  }

  /**
   * Apply the authoritative whole-block text and mark the block final.
   *
   * REPLACES rather than appends: the block frame repeats content already
   * delivered as deltas. See the module comment.
   */
  finalizeText(content: string, key: string | null = null): AssistantBlock | null {
    const block = key === null ? this.assistant : this.assistantsByKey.get(key) ?? null;
    if (block === null) {
      if (content.length === 0) return null;
      if (this.assistant !== null) this.seal(this.assistant);
      this.assistant = { kind: 'assistant', id: nextId('assistant'), text: '', finalized: false };
      this.items.push(this.assistant);
      if (key !== null) this.assistantsByKey.set(key, this.assistant);
    }
    const target = block ?? this.assistant;
    if (target === null) return null;
    // The whole-block frame REPLACES the deltas already counted, so the
    // counter follows the replacement instead of adding to it.
    this.contextCharCount += content.length - target.text.length;
    target.text = content;
    this.seal(target);
    return target;
  }

  /** Append a streamed thinking fragment to its block. Keyed as above. */
  appendThinkingDelta(text: string, key: string | null = null, at = Date.now()): ThinkingBlock | null {
    if (text.length === 0) return this.thinking;
    if (key !== null) {
      const existing = this.thinkingByKey.get(key);
      if (existing !== undefined) {
        existing.text += text;
        this.bump(existing);
        this.contextCharCount += text.length;
        return existing;
      }
    }
    if (this.thinking === null || key !== null) {
      if (this.thinking !== null) {
        this.seal(this.thinking);
        sealThinkingDuration(this.thinking, at);
      }
      this.thinking = {
        kind: 'thinking',
        id: nextId('thinking'),
        text: '',
        finalized: false,
        startedAt: at,
      };
      this.items.push(this.thinking);
      if (key !== null) this.thinkingByKey.set(key, this.thinking);
    }
    this.thinking.text += text;
    this.bump(this.thinking);
    this.contextCharCount += text.length;
    return this.thinking;
  }

  /** Apply authoritative thinking content and mark the block final. Keyed as above. */
  finalizeThinking(content: string, key: string | null = null, at = Date.now()): ThinkingBlock | null {
    const block = key === null ? this.thinking : this.thinkingByKey.get(key) ?? null;
    if (block === null) {
      if (content.length === 0) return null;
      if (this.thinking !== null) {
        this.seal(this.thinking);
        sealThinkingDuration(this.thinking, at);
      }
      this.thinking = {
        kind: 'thinking',
        id: nextId('thinking'),
        text: '',
        finalized: false,
        startedAt: at,
      };
      this.items.push(this.thinking);
      if (key !== null) this.thinkingByKey.set(key, this.thinking);
    }
    const target = block ?? this.thinking;
    if (target === null) return null;
    // The whole-block frame replaces the deltas already counted.
    this.contextCharCount += content.length - target.text.length;
    target.text = content;
    this.seal(target);
    sealThinkingDuration(target, at);
    return target;
  }

  /**
   * Seal whatever is still open because a tool call started.
   *
   * A tool call ENDS the content block that preceded it: no more deltas will
   * ever arrive for that text. Leaving the pointer live is what made every
   * later sentence of the turn append into a block sitting ABOVE the tool
   * line. Marking it final is also what tells the renderer the block will stop
   * growing, so it may be laid out in full.
   */
  closeOpenContent(at = Date.now()): void {
    if (this.assistant !== null) this.seal(this.assistant);
    if (this.thinking !== null) {
      this.seal(this.thinking);
      sealThinkingDuration(this.thinking, at);
    }
    this.assistant = null;
    this.thinking = null;
  }

  /** A stopped stream cannot prove the outcome of an unfinished tool. */
  finishRun(): boolean {
    this.closeOpenContent();
    let changed = false;
    for (const block of this.toolsByCallId.values()) {
      if (block.status !== 'running') continue;
      block.status = 'unknown';
      this.bump(block);
      if (block.result === undefined) {
        block.result = 'Run ended before a tool result was received.';
        this.contextCharCount += block.result.length;
      }
      changed = true;
    }
    return changed;
  }

  /**
   * Create or update the tool block for `callId`.
   *
   * Both `tool_use_started` (the announcement) and `tool_use` (the
   * authoritative call) land on the same object, and so does `tool_result`.
   */
  upsertTool(callId: string, name: string, input: unknown, at = Date.now()): ToolBlock {
    const existing = this.toolsByCallId.get(callId);
    if (existing !== undefined) {
      if (name !== '') existing.name = name;
      const argumentText = serializeToolArguments(input);
      if (argumentText !== undefined) existing.argumentText = argumentText;
      const preview = buildToolPreview(existing.name, input);
      if (preview !== '') existing.preview = preview;
      const command = shellCommandOf(input);
      if (command !== undefined) existing.command = command;
      // A re-announced call restates the same arguments; the card is only
      // filled when the first frame carried none (a preview frame may omit
      // them). Overwriting would reset a lifecycle the second frame arrived
      // after.
      const spec = existing.subagent === undefined ? readSubagentSpec(existing.name, input) : null;
      if (spec !== null) existing.subagent = { spec, startedAtMs: at };
      this.bump(existing);
      return existing;
    }
    // Announcing a tool is what ENDS the content block before it. Only a NEW
    // call closes anything: `tool_use` landing on an already-open block is the
    // authoritative restatement of the same call, and closing there would split
    // one piece of text in two.
    this.closeOpenContent();
    const command = shellCommandOf(input);
    const spec = readSubagentSpec(name, input);
    const argumentText = serializeToolArguments(input);
    const block: ToolBlock = {
      kind: 'tool',
      id: nextId('tool'),
      callId,
      name: name === '' ? 'tool' : name,
      preview: buildToolPreview(name, input),
      status: 'running',
      ...(command === undefined ? {} : { command }),
      ...(argumentText === undefined ? {} : { argumentText }),
      ...(spec === null ? {} : { subagent: { spec, startedAtMs: at } }),
    };
    this.toolsByCallId.set(callId, block);
    this.items.push(block);
    // The call's arguments go back to the model with the next request, so
    // they occupy the window too. Counted once, when the block is created:
    // the announcement and the authoritative call carry the same input.
    this.contextCharCount += TranscriptModel.inputLength(input);
    return block;
  }

  /** Finish a tool block in place, with its result. */
  completeTool(
    callId: string,
    result: string,
    failed: boolean,
    indeterminate = false,
    metadata?: unknown,
    durationMs?: number,
  ): ToolBlock | null {
    const block = this.toolsByCallId.get(callId);
    if (block === undefined) return null;
    block.result = result;
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      block.durationMs = durationMs;
    }
    // The live tail is superseded, not supplemented: it is what a poller
    // happened to sample, and keeping it would leave an 8 KiB build-log buffer
    // alive for the rest of the session on a block that no longer reads it.
    block.outputText = undefined;
    // The result goes back to the model with the next request as well.
    this.contextCharCount += result.length;
    block.status = failed ? 'error' : indeterminate ? 'unknown' : 'ok';
    this.applyToolMetadata(block, metadata);
    this.bump(block);
    // A todo write returns the WHOLE list (the tool is merge-semantic), so the
    // result the transcript was about to print as JSON becomes the list it
    // draws instead. A failed write keeps its error and shows no list.
    if (!failed && isTodoTool(block.name)) {
      const items = parseTodoItems(result);
      if (items !== null) block.todos = items;
    }
    return block;
  }

  /**
   * Read the producer's structured metadata off a finished tool call.
   *
   * The metadata is the producer's own payload, so it is narrowed here rather
   * than trusted: a diff that is not fully understood is dropped whole, because
   * a half-rendered change set reads as a file with unexplained gaps.
   */
  private applyToolMetadata(block: ToolBlock, metadata: unknown): void {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return;
    const record = metadata as Record<string, unknown>;

    const diff = parseToolFileDiff(record['diff']);
    if (diff !== null) block.diff = diff;

    const failures = record['failures'];
    if (Array.isArray(failures)) {
      const texts = failures.filter((entry): entry is string => typeof entry === 'string');
      if (texts.length > 0) block.failures = texts;
    }
  }

  /** Look a tool block up by its correlation id. */
  toolByCallId(callId: string): ToolBlock | null {
    return this.toolsByCallId.get(callId) ?? null;
  }

  /**
   * Record that a call timed out, without inventing a result for it.
   *
   * A timeout is NOT a completion: the call may still finish, and the durable
   * `tool.call_completed` that says so is a separate event. So this only sets
   * the flag and leaves `result` alone — a block that reads `timedOut` with an
   * empty result is the honest state of a call that has not come back yet.
   */
  markToolTimedOut(callId: string): ToolBlock | null {
    const block = this.toolsByCallId.get(callId);
    if (block === undefined) return null;
    block.timedOut = true;
    this.bump(block);
    return block;
  }

  /** Append a single-line notice. */
  addNotice(text: string): NoticeBlock {
    const block: NoticeBlock = { kind: 'notice', id: nextId('notice'), text };
    this.items.push(block);
    return block;
  }

  /**
   * Every subagent card in the transcript, in the order the calls were made.
   *
   * The transcript is the authoritative list of subagents this session SPAWNED:
   * a spawn is a tool call, so it is in the transcript even when the lifecycle
   * event that would have updated a task list never arrived. The task view
   * reads the card for the facts a frame can lose (name, role, brief) and the
   * frame for the ones only it knows (outcome, duration) — see
   * `TUIApp.watchPanelLines`.
   */
  subagentCards(): Array<{ readonly block: ToolBlock; readonly card: SubagentCard }> {
    const cards: Array<{ block: ToolBlock; card: SubagentCard }> = [];
    for (const block of this.items) {
      if (block.kind !== 'tool' || block.subagent === undefined) continue;
      cards.push({ block, card: block.subagent });
    }
    return cards;
  }

  /**
   * Fold one subagent lifecycle frame into the card of the call that spawned it.
   *
   * ## Why the linkage is `parentToolCallId`
   *
   * `subagent_started` names the parent call; `subagent_completed` names only
   * the child. So the id is learned at start and remembered on the card, which
   * is what lets a completion find its row without a second lookup table that
   * could disagree with the transcript.
   *
   * ## Why a missing parent call is not an error
   *
   * A subagent started by a call this process never saw — a replayed segment, a
   * Desktop-started run this terminal is only watching — has no row to update.
   * The frame is then simply not transcript content, which is the same answer
   * every other progress frame gets.
   */
  private applySubagentProgress(payload: Record<string, unknown>): ApplyResult {
    const eventType = asString(payload['agentEventType']);
    const subagentId = asString(payload['subagentId']);

    if (eventType === 'subagent_started') {
      // The canonical protocol calls this `parentToolCallId`, while the legacy
      // SSE projector exposes the same value as `toolCallId`. The TUI consumes
      // projected frames, so accept both spellings at this boundary.
      const parentCallId = asString(payload['parentToolCallId']) || asString(payload['toolCallId']);
      if (parentCallId === '' || subagentId === '') return { kind: 'none' };
      const block = this.toolsByCallId.get(parentCallId);
      if (block === undefined) return { kind: 'none' };
      if (block.subagent === undefined) {
        // The call's own arguments are the primary source; this is the fallback
        // for a call whose input never arrived (a preview-only stream).
        const name = asString(payload['agentName']);
        const agentType = asString(payload['agentType']);
        const description = asString(payload['agentDescription']);
        block.subagent = {
          spec: {
            name,
            agentType: agentType === '' ? 'general-purpose' : agentType,
            model: '',
            effort: '',
            brief: description,
          },
          startedAtMs: Date.now(),
        };
      }
      if (block.subagent.subagentId === subagentId) return { kind: 'none' };
      block.subagent.subagentId = subagentId;
      this.bump(block);
      return { kind: 'mutate', block };
    }

    if (eventType === 'subagent_completed') {
      if (subagentId === '') return { kind: 'none' };
      const block = this.findSubagentBlock(subagentId);
      if (block === null) return { kind: 'none' };
      const card = block.subagent;
      if (card === undefined) return { kind: 'none' };
      const raw = asString(payload['status']);
      const outcome = raw === 'failed' ? 'failed' : raw === 'cancelled' ? 'cancelled' : 'completed';
      const duration = payload['durationMs'];
      const summary = asString(payload['summary']);
      card.outcome = outcome;
      if (typeof duration === 'number' && Number.isFinite(duration)) {
        card.durationMs = Math.max(0, duration);
      }
      if (summary !== '') card.summary = summary;
      this.bump(block);
      return { kind: 'mutate', block };
    }

    return { kind: 'none' };
  }

  /** The tool block whose card carries `subagentId`, or `null`. */
  private findSubagentBlock(subagentId: string): ToolBlock | null {
    for (const block of this.toolsByCallId.values()) {
      if (block.subagent?.subagentId === subagentId) return block;
    }
    return null;
  }

  /** Append an error. Errors are never collapsed, so no status field. */
  addError(message: string): ErrorBlock {
    const block: ErrorBlock = { kind: 'error', id: nextId('error'), message };
    this.items.push(block);
    return block;
  }

  /**
   * Apply one frame.
   *
   * Returns what changed so the caller can decide whether a render is worth
   * scheduling. Frames that carry nothing visible — progress ticks, turn
   * markers — report `none`, which is what keeps a firehose of them from
   * costing a render each.
   */
  apply(frame: LegacyFrame): ApplyResult {
    const payload = payloadOf(frame);

    switch (frame.type) {
      case 'text_delta': {
        const block = this.appendTextDelta(readFrameContent(frame), readBlockKey(payload));
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }
      case 'text': {
        const block = this.finalizeText(readFrameContent(frame), readBlockKey(payload));
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }
      case 'thinking_delta': {
        const block = this.appendThinkingDelta(readFrameContent(frame), readBlockKey(payload));
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }
      case 'thinking': {
        const block = this.finalizeThinking(readFrameContent(frame), readBlockKey(payload));
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }

      case 'tool_use_started':
      case 'tool_use': {
        const callId = asString(payload['id']);
        if (callId === '') return { kind: 'none' };
        const existed = this.toolsByCallId.has(callId);
        const block = this.upsertTool(callId, asString(payload['name']), payload['input']);
        return existed ? { kind: 'mutate', block } : { kind: 'append', block };
      }

      case 'tool_use_delta': {
        // Argument fragments. The call was announced first, so the block
        // exists and can show the arguments as they arrive — which is the
        // whole point for a file write: the text of the file is in these
        // fragments, and the reader can watch it being written.
        //
        // The fragments are raw JSON slices, not parsed fields, so they are
        // accumulated as text and read leniently at render time. The
        // authoritative arguments arrive with `tool_use` and replace them.
        const callId = asString(payload['id']);
        if (callId === '') return { kind: 'none' };
        const block = this.toolsByCallId.get(callId);
        if (block === undefined) return { kind: 'none' };
        const delta = asString(payload['delta']);
        if (delta === '') return { kind: 'none' };
        block.argumentText = (block.argumentText ?? '') + delta;
        this.bump(block);
        return { kind: 'mutate', block };
      }

      case 'tool_output': {
        // The running command printed another slice. Unlike `tool_use` there is
        // no block to create: output only exists for a call that already
        // announced itself, and inventing a block here would draw a tool row
        // whose command nobody stated.
        const callId = asString(payload['toolUseId']) || asString(payload['id']);
        if (callId === '') return { kind: 'none' };
        const block = this.toolsByCallId.get(callId);
        if (block === undefined) return { kind: 'none' };
        const delta = asString(payload['data']) || asString(payload['delta']);
        if (delta === '') return { kind: 'none' };
        // Bounded at the tail. A verbose build emits megabytes and the live row
        // draws a handful of lines, so the head is what a cap must discard —
        // keeping it would leave the row showing the first lines of a command
        // that has long since moved past them.
        const joined = (block.outputText ?? '') + delta;
        block.outputText = joined.length > OUTPUT_TAIL_MAX_CHARS
          ? joined.slice(joined.length - OUTPUT_TAIL_MAX_CHARS)
          : joined;
        this.bump(block);
        return { kind: 'mutate', block };
      }

      case 'tool_result': {
        const callId = asString(payload['id']);
        if (callId === '') return { kind: 'none' };
        // A result for a call never announced itself still gets a block, so
        // the result is never silently dropped.
        if (!this.toolsByCallId.has(callId)) {
          this.upsertTool(callId, asString(payload['name']), undefined);
        }
        const rawDuration = payload['durationMs'];
        const block = this.completeTool(
          callId,
          asString(payload['result']),
          payload['error'] === true,
          payload['indeterminate'] === true,
          payload['metadata'],
          typeof rawDuration === 'number' ? rawDuration : undefined,
        );
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }

      case 'tool_timed_out': {
        const callId = asString(payload['id']);
        if (callId === '') return { kind: 'none' };
        // A timeout for a call never announced itself still gets a block, on
        // the same reasoning as `tool_result`: the event must not be dropped
        // just because the announcement was lost.
        if (!this.toolsByCallId.has(callId)) {
          this.upsertTool(callId, asString(payload['name']), undefined);
        }
        const block = this.markToolTimedOut(callId);
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }

      case 'permission_resolved': {
        // The durable answer to a question the user was asked. A notice, not a
        // `status` frame: `status` is chrome the reader scrolls past, and an
        // answer that vanishes with the activity row is the same loss as never
        // receiving it at all.
        const action = asString(payload['action']);
        if (action === '') return { kind: 'none' };
        const toolName = asString(payload['toolName']);
        return {
          kind: 'append',
          block: this.addNotice(permissionResolutionLine(action, toolName, asString(payload['reason']))),
        };
      }

      case 'permission': {
        const requestId = asString(payload['requestId']);
        if (requestId === '') return { kind: 'none' };
        const rawMode = asString(payload['mode']);
        const mode = rawMode === 'ask_user_question' || rawMode === 'exit_plan_mode'
          ? rawMode
          : 'generic';
        return {
          kind: 'permission',
          request: {
            requestId,
            toolName: asString(payload['toolName']),
            toolInput: payload['toolInput'],
            reason: asString(payload['reason']),
            blockedPath: asString(payload['blockedPath']) || undefined,
            mode,
          },
        };
      }

      case 'error': {
        // `run.failed` projects to `{ message, code }`. Read the field rather
        // than interpolating the object, which would print `[object Object]`.
        const message = asString(payload['message']) || readFrameContent(frame);
        if (message === '') return { kind: 'none' };
        return { kind: 'append', block: this.addError(message) };
      }

      case 'status': {
        // CHROME, never content. A turn counter and a "preparing" placeholder
        // say what the agent is doing RIGHT NOW; appended as a notice they
        // become permanent transcript rows the reader scrolls past forever, and
        // `@i18n:` keys that only the desktop renderer knows how to resolve
        // reach the screen as their own raw names. `TUIApp.updateActivity`
        // consumes this frame for the activity row, which is where it belongs.
        return { kind: 'none' };
      }

      case 'token_usage': {
        // Display, not transcript content: `TUIApp` intercepts this frame and
        // shows it in the status bar (and the Ctrl+P usage window). A notice
        // line per turn was noise the reader had to scroll past, and the
        // per-call totals it printed were never a context budget.
        return { kind: 'none' };
      }

      case 'retry': {
        // A retry is the answer to "why did it take that long", and the status
        // line that carries it is overwritten by the next turn. Owner decision
        // (plan 610): this one gets a durable row.
        const reason = asString(payload['reason']);
        const attempt = asNumber(payload['attempt']);
        // `attempt` is a required field and 1-based, so a frame without one is
        // not a retry. Without this the empty frame renders `attempt 0`, which
        // is a fact the run never stated.
        if (attempt < 1) return { kind: 'none' };
        const maxAttempts = asNumber(payload['maxAttempts']);
        const attemptText = maxAttempts === 0 ? `attempt ${attempt}` : `attempt ${attempt}/${maxAttempts}`;
        return { kind: 'append', block: this.addNotice(`Retrying (${attemptText})${reason === '' ? '' : ` — ${reason}`}`) };
      }

      case 'mode_changed': {
        // Same reasoning: the mode a run is in is what explains its behaviour
        // afterwards, and the composer border is the only other place it shows.
        const mode = asString(payload['mode']);
        if (mode === '') return { kind: 'none' };
        const source = asString(payload['source']);
        return { kind: 'append', block: this.addNotice(`Mode: ${mode}${source === '' ? '' : ` (${source})`}`) };
      }

      case 'goal_updated': {
        const state = asString(payload['state']);
        const phase = asString(payload['phase']);
        const objective = asString(payload['objective']);
        const headline = [state, phase].filter((part) => part !== '').join(' · ');
        if (headline === '') return { kind: 'none' };
        // The objective is a sentence the agent wrote; clipped so a long one
        // cannot push the rest of the transcript out of an 80-column window.
        const clipped = objective.length > 80 ? `${objective.slice(0, 79)}…` : objective;
        return { kind: 'append', block: this.addNotice(`Goal ${headline}${clipped === '' ? '' : ` — ${clipped}`}`) };
      }

      case 'compact:start':
        return { kind: 'append', block: this.addNotice('compacting context…') };
      case 'compact:done':
        return { kind: 'append', block: this.addNotice('compaction complete') };
      case 'compact:error': {
        const message = asString(payload['message']);
        return { kind: 'append', block: this.addError(message === '' ? 'compaction failed' : message) };
      }

      // Progress ticks and turn markers: real, but not transcript content.
      // Rendering them would cost a frame per tick during exactly the firehose
      // the pacing exists to survive.
      case 'tool_progress':
      case 'tool_group_progress':
      case 'turn_start':
      case 'compact:step':
      case 'compact:over_threshold':
      case 'done':
        return { kind: 'none' };

      case 'agent_progress':
        // The one progress frame that DOES touch the transcript: a subagent's
        // lifecycle belongs to the `task` call that spawned it, so it mutates
        // that call's card instead of appending a row. Every other subagent
        // event (`heartbeat`, a child's own text/tool frames) stays invisible
        // here — see `applySubagentProgress`.
        return this.applySubagentProgress(payload);

      default:
        // Unreachable while `FRAME_TYPES` and this switch agree; a new
        // projector arm should land in both.
        return { kind: 'none' };
    }
  }

  /** Drop everything, for `/clear`. */
  clear(): void {
    this.items.length = 0;
    this.toolsByCallId.clear();
    this.assistantsByKey.clear();
    this.thinkingByKey.clear();
    this.assistant = null;
    this.thinking = null;
    this.contextCharCount = 0;
    // Safe to reset: ids never repeat, and the only blocks that survive a
    // clear (`replayRunSegment`'s kept user prefix) are never mutated after
    // creation, so their revision of 0 still matches their content.
    this.revisions.clear();
  }

  /**
   * Replace everything the RUN contributed, keeping the local input blocks.
   *
   * ## Why this splices instead of replacing
   *
   * User blocks come from local input and never travel on a run event stream,
   * so they are absent from a `RunSessionSnapshot` and no projection of shared
   * state can rebuild them. A render source that swapped the whole transcript
   * would delete the user's own prompts on every snapshot — which is why the
   * switch this enables is a splice and not a wholesale `clear()`.
   *
   * The user prefix is taken as everything up to and including the LAST user
   * block: input is always appended after the output it provoked, so the last
   * user block is the boundary. Anything after it was run-derived.
   *
   * The frames replay through the ordinary `apply` path, so block ids keep
   * advancing and no projection of block shapes is duplicated here.
   */
  replayRunSegment(frames: readonly LegacyFrame[]): void {
    let lastUserIndex = -1;
    for (let index = 0; index < this.items.length; index += 1) {
      if (this.items[index]!.kind === 'user') lastUserIndex = index;
    }
    const userBlocks = this.items.slice(0, lastUserIndex + 1);
    // The kept user blocks still occupy the window, so their characters are
    // counted again after the clear that follows.
    const keptChars = userBlocks.reduce(
      (total, block) => total + (block.kind === 'user' ? block.text.length : 0),
      0,
    );
    this.clear();
    for (const block of userBlocks) this.items.push(block);
    this.contextCharCount = keptChars;
    for (const frame of frames) this.apply(frame);
  }
}

/** Keep the complete invocation available to the disclosure renderer. */
function serializeToolArguments(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    const serialized = JSON.stringify(input, null, 2);
    // A streaming call is announced with an empty object before its argument
    // deltas arrive. Keeping that placeholder would prefix the raw JSON
    // fragments and make the live invocation impossible to parse.
    return serialized === '{}' ? undefined : serialized;
  } catch {
    return undefined;
  }
}
