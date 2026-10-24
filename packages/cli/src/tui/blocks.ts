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

export type Block = UserBlock | AssistantBlock | ThinkingBlock | ToolBlock | ErrorBlock | NoticeBlock;

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

  /** The blocks, in order. */
  get blocks(): readonly Block[] {
    return this.items;
  }

  /** Add a block the user typed. */
  addUser(text: string): UserBlock {
    this.closeOpenContent();
    const block: UserBlock = { kind: 'user', id: nextId('user'), text };
    this.items.push(block);
    return block;
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
        return existing;
      }
    }
    if (this.assistant === null || key !== null) {
      if (this.assistant !== null) this.assistant.finalized = true;
      this.assistant = { kind: 'assistant', id: nextId('assistant'), text: '', finalized: false };
      this.items.push(this.assistant);
      if (key !== null) this.assistantsByKey.set(key, this.assistant);
    }
    this.assistant.text += text;
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
      if (this.assistant !== null) this.assistant.finalized = true;
      this.assistant = { kind: 'assistant', id: nextId('assistant'), text: '', finalized: false };
      this.items.push(this.assistant);
      if (key !== null) this.assistantsByKey.set(key, this.assistant);
    }
    const target = block ?? this.assistant;
    if (target === null) return null;
    target.text = content;
    target.finalized = true;
    return target;
  }

  /** Append a streamed thinking fragment to its block. Keyed as above. */
  appendThinkingDelta(text: string, key: string | null = null, at = Date.now()): ThinkingBlock | null {
    if (text.length === 0) return this.thinking;
    if (key !== null) {
      const existing = this.thinkingByKey.get(key);
      if (existing !== undefined) {
        existing.text += text;
        return existing;
      }
    }
    if (this.thinking === null || key !== null) {
      if (this.thinking !== null) {
        this.thinking.finalized = true;
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
    return this.thinking;
  }

  /** Apply authoritative thinking content and mark the block final. Keyed as above. */
  finalizeThinking(content: string, key: string | null = null, at = Date.now()): ThinkingBlock | null {
    const block = key === null ? this.thinking : this.thinkingByKey.get(key) ?? null;
    if (block === null) {
      if (content.length === 0) return null;
      if (this.thinking !== null) {
        this.thinking.finalized = true;
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
    target.text = content;
    target.finalized = true;
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
    if (this.assistant !== null) this.assistant.finalized = true;
    if (this.thinking !== null) {
      this.thinking.finalized = true;
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
      block.result ??= 'Run ended before a tool result was received.';
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
  upsertTool(callId: string, name: string, input: unknown): ToolBlock {
    const existing = this.toolsByCallId.get(callId);
    if (existing !== undefined) {
      if (name !== '') existing.name = name;
      const preview = buildToolPreview(existing.name, input);
      if (preview !== '') existing.preview = preview;
      const command = shellCommandOf(input);
      if (command !== undefined) existing.command = command;
      return existing;
    }
    // Announcing a tool is what ENDS the content block before it. Only a NEW
    // call closes anything: `tool_use` landing on an already-open block is the
    // authoritative restatement of the same call, and closing there would split
    // one piece of text in two.
    this.closeOpenContent();
    const command = shellCommandOf(input);
    const block: ToolBlock = {
      kind: 'tool',
      id: nextId('tool'),
      callId,
      name: name === '' ? 'tool' : name,
      preview: buildToolPreview(name, input),
      status: 'running',
      ...(command === undefined ? {} : { command }),
    };
    this.toolsByCallId.set(callId, block);
    this.items.push(block);
    return block;
  }

  /** Finish a tool block in place, with its result. */
  completeTool(
    callId: string,
    result: string,
    failed: boolean,
    indeterminate = false,
  ): ToolBlock | null {
    const block = this.toolsByCallId.get(callId);
    if (block === undefined) return null;
    block.result = result;
    block.status = failed ? 'error' : indeterminate ? 'unknown' : 'ok';
    // A todo write returns the WHOLE list (the tool is merge-semantic), so the
    // result the transcript was about to print as JSON becomes the list it
    // draws instead. A failed write keeps its error and shows no list.
    if (!failed && isTodoTool(block.name)) {
      const items = parseTodoItems(result);
      if (items !== null) block.todos = items;
    }
    return block;
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
    return block;
  }

  /** Append a single-line notice. */
  addNotice(text: string): NoticeBlock {
    const block: NoticeBlock = { kind: 'notice', id: nextId('notice'), text };
    this.items.push(block);
    return block;
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

      case 'tool_use_delta':
        // Argument fragments. The announcement already named the tool and the
        // authoritative arguments arrive on `tool_use`, so there is nothing to
        // show until then — rendering raw JSON fragments is noise.
        return { kind: 'none' };

      case 'tool_result': {
        const callId = asString(payload['id']);
        if (callId === '') return { kind: 'none' };
        // A result for a call never announced itself still gets a block, so
        // the result is never silently dropped.
        if (!this.toolsByCallId.has(callId)) {
          this.upsertTool(callId, asString(payload['name']), undefined);
        }
        const block = this.completeTool(
          callId,
          asString(payload['result']),
          payload['error'] === true,
          payload['indeterminate'] === true,
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
      case 'agent_progress':
      case 'done':
        return { kind: 'none' };

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
    this.clear();
    for (const block of userBlocks) this.items.push(block);
    for (const frame of frames) this.apply(frame);
  }
}
