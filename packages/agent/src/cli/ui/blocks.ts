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
  status: 'running' | 'ok' | 'error';
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

/** Read `data` as a record, or `{}` when it is not one. */
function payloadOf(frame: LegacyFrame): Record<string, unknown> {
  return typeof frame.data === 'object' && frame.data !== null && !Array.isArray(frame.data)
    ? (frame.data as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Arguments worth previewing, per tool.
 *
 * The SAME table the plain REPL uses (`buildToolPreview` in `cli/index.ts`).
 * Duplicated rather than imported because that one is module-private to a
 * 1000-line entry point, and a second account of "which argument summarises
 * this tool" is exactly the kind of drift this file is trying to avoid. If it
 * changes there, it changes here — they are meant to read as one fact.
 */
const PRIMARY_ARGUMENT_KEYS: Readonly<Record<string, string>> = {
  terminal: 'command',
  web_search: 'query',
  web_extract: 'urls',
  read_file: 'path',
  write_file: 'path',
  patch: 'path',
  search_files: 'pattern',
  browser_navigate: 'url',
  browser_click: 'ref',
  browser_type: 'text',
  image_generate: 'prompt',
  text_to_speech: 'text',
  vision_analyze: 'question',
  skill_view: 'name',
  skills_list: 'category',
  execute_code: 'code',
  delegate_task: 'goal',
  clarify: 'question',
  todo: 'todos',
  memory: 'action',
  session_search: 'query',
};

/** Longest preview before it is elided. */
const PREVIEW_MAX = 40;

/** Clip a preview to one line's worth of a tool call. */
function clip(value: string): string {
  return value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX - 3)}...` : value;
}

/** A one-line summary of a tool call's most telling argument. */
export function buildToolPreview(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  const key = PRIMARY_ARGUMENT_KEYS[name];
  if (key !== undefined) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return clip(value);
    if (Array.isArray(value)) return clip(value.map((v) => String(v)).join(', '));
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.length > 0) return clip(value);
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

export class TranscriptModel {
  private readonly items: Block[] = [];
  private readonly toolsByCallId = new Map<string, ToolBlock>();
  private assistant: AssistantBlock | null = null;
  private thinking: ThinkingBlock | null = null;

  /** The blocks, in order. */
  get blocks(): readonly Block[] {
    return this.items;
  }

  /** Add a block the user typed. */
  addUser(text: string): UserBlock {
    const block: UserBlock = { kind: 'user', id: nextId('user'), text };
    this.items.push(block);
    // A new prompt starts a new answer; the previous one is closed.
    this.assistant = null;
    this.thinking = null;
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
   * Append a streamed text fragment to the live assistant block.
   *
   * Creates the block on first use. The SAME object is returned every time so
   * the caller can address one line rather than rebuilding it.
   */
  appendTextDelta(text: string): AssistantBlock | null {
    if (text.length === 0) return this.assistant;
    if (this.assistant === null) {
      this.assistant = { kind: 'assistant', id: nextId('assistant'), text: '', finalized: false };
      this.items.push(this.assistant);
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
  finalizeText(content: string): AssistantBlock | null {
    if (this.assistant === null) {
      if (content.length === 0) return null;
      this.assistant = { kind: 'assistant', id: nextId('assistant'), text: '', finalized: false };
      this.items.push(this.assistant);
    }
    this.assistant.text = content;
    this.assistant.finalized = true;
    return this.assistant;
  }

  /** Append a streamed thinking fragment to the live thinking block. */
  appendThinkingDelta(text: string): ThinkingBlock | null {
    if (text.length === 0) return this.thinking;
    if (this.thinking === null) {
      this.thinking = { kind: 'thinking', id: nextId('thinking'), text: '', finalized: false };
      this.items.push(this.thinking);
    }
    this.thinking.text += text;
    return this.thinking;
  }

  /** Apply authoritative thinking content and mark the block final. */
  finalizeThinking(content: string): ThinkingBlock | null {
    if (this.thinking === null) {
      if (content.length === 0) return null;
      this.thinking = { kind: 'thinking', id: nextId('thinking'), text: '', finalized: false };
      this.items.push(this.thinking);
    }
    this.thinking.text = content;
    this.thinking.finalized = true;
    return this.thinking;
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
      return existing;
    }
    const block: ToolBlock = {
      kind: 'tool',
      id: nextId('tool'),
      callId,
      name: name === '' ? 'tool' : name,
      preview: buildToolPreview(name, input),
      status: 'running',
    };
    this.toolsByCallId.set(callId, block);
    this.items.push(block);
    return block;
  }

  /** Finish a tool block in place, with its result. */
  completeTool(callId: string, result: string, failed: boolean): ToolBlock | null {
    const block = this.toolsByCallId.get(callId);
    if (block === undefined) return null;
    block.result = result;
    block.status = failed ? 'error' : 'ok';
    return block;
  }

  /** Look a tool block up by its correlation id. */
  toolByCallId(callId: string): ToolBlock | null {
    return this.toolsByCallId.get(callId) ?? null;
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
        const block = this.appendTextDelta(readFrameContent(frame));
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }
      case 'text': {
        const block = this.finalizeText(readFrameContent(frame));
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }
      case 'thinking_delta': {
        const block = this.appendThinkingDelta(readFrameContent(frame));
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }
      case 'thinking': {
        const block = this.finalizeThinking(readFrameContent(frame));
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
        const block = this.completeTool(callId, asString(payload['result']), payload['error'] === true);
        return block === null ? { kind: 'none' } : { kind: 'mutate', block };
      }

      case 'permission': {
        const requestId = asString(payload['requestId']);
        if (requestId === '') return { kind: 'none' };
        return {
          kind: 'permission',
          request: {
            requestId,
            toolName: asString(payload['toolName']),
            toolInput: payload['toolInput'],
            reason: asString(payload['reason']),
            blockedPath: asString(payload['blockedPath']) || undefined,
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
        const message = asString(payload['message']);
        if (message === '') return { kind: 'none' };
        return { kind: 'append', block: this.addNotice(message) };
      }

      case 'token_usage': {
        const total = payload['total_tokens'];
        if (typeof total !== 'number') return { kind: 'none' };
        return { kind: 'append', block: this.addNotice(`tokens: ${total}`) };
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
      case 'retry':
      case 'mode_changed':
      case 'goal_updated':
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
    this.assistant = null;
    this.thinking = null;
  }
}
