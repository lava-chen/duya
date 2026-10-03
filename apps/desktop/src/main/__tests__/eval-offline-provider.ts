/**
 * eval-offline-provider.ts — an OFFLINE PROVIDER, not a fake agent.
 *
 * ## What this is
 *
 * A real HTTP server on 127.0.0.1 that speaks the real Anthropic Messages
 * streaming wire protocol: `POST /v1/messages`, `content-type:
 * text/event-stream`, `event: message_start` / `content_block_start` /
 * `content_block_delta` / `content_block_stop` / `message_delta` /
 * `message_stop`, exactly as `api.anthropic.com` emits them.
 *
 * The production `Anthropic` SDK inside `@duya/ai` opens a real socket to it,
 * parses the real SSE, and the real adapter's own thinking/tool-call/usage
 * assembly runs unmodified. Nothing here is a `vi.mock` of a provider
 * interface, and nothing here decides what the AGENT does.
 *
 * ## Why this is a provider and not a second fake state machine
 *
 * The line this file is careful not to cross: a fake state machine would
 * decide the turn's OUTCOME — which tool runs, whether it succeeds, how many
 * turns happen, what the terminal is. A provider only decides BYTES ON THE
 * WIRE for one HTTP request, and it has no idea a run exists.
 *
 * Concretely, this file:
 *  - knows nothing about runs, sessions, manifests, budgets or terminals;
 *  - has one input (a request body) and one output (SSE bytes);
 *  - cannot emit a `chat:*` frame, append a RunEvent, or settle a run;
 *  - decides NOTHING about tool execution — it names a tool call in the
 *    protocol and the real executor decides whether to run it.
 *
 * If the agent loop were removed and replaced by a script that read the
 * transcript, this server would still behave identically. That is the test of
 * a provider: the executor, not the fixture, is what makes the turn happen.
 *
 * ## Controllability
 *
 * `OfflineProviderScript` is a list of turns; each turn is a list of content
 * blocks. The script advances one entry per `/v1/messages` request and repeats
 * the LAST entry once exhausted, so a multi-turn tool loop converges instead of
 * hanging. That is the whole state this file holds: an index.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One content block the provider will emit inside an assistant message. */
export type OfflineBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly thinking: string; readonly signature?: string }
  | {
      readonly kind: 'tool_use';
      readonly id: string;
      readonly name: string;
      /** Serialised as the real SDK does: incremental `input_json_delta`. */
      readonly input: Record<string, unknown>;
    };

export interface OfflineTurn {
  readonly blocks: readonly OfflineBlock[];
  /** `end_turn` for a finished answer, `tool_use` when a tool was called. */
  readonly stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * Emit `event: error` instead of a message. Models this: a real provider
   * can fail a stream mid-turn, and the executor's error path is only proven
   * if the fixture can produce the failure the real wire produces.
   */
  readonly error?: { readonly type: string; readonly message: string };
}

export interface OfflineProviderScript {
  readonly turns: readonly OfflineTurn[];
  /** Reported in metadata; the run's own outcome is decided by the executor. */
  readonly seed: string;
}

export interface ProviderRequestRecord {
  readonly index: number;
  readonly model: unknown;
  readonly maxTokens: unknown;
  readonly systemBlocks: number;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly messageRoles: readonly string[];
  readonly stopped: boolean;
}

export interface OfflineProvider {
  /** Base URL to hand the real client as `baseURL`. */
  readonly baseUrl: string;
  /** Every request the real adapter made, in order. */
  readonly requests: readonly ProviderRequestRecord[];
  /** The `x-api-key` header values seen, for the redaction assertion. */
  readonly authHeadersSeen: readonly string[];
  close(): Promise<void>;
}

function sseFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Split a serialised object into `input_json_delta` fragments. */
function jsonFragments(value: Record<string, unknown>): string[] {
  const raw = JSON.stringify(value);
  // Two fragments is enough to exercise accumulation without making the
  // fixture's own fragment count a thing a test can depend on.
  const cut = Math.max(1, Math.ceil(raw.length / 2));
  return [raw.slice(0, cut), raw.slice(cut)];
}

function writeTurn(res: ServerResponse, turn: OfflineTurn, turnIndex: number, model: string): void {
  if (turn.error) {
    sseFrame(res, 'error', { type: 'error', error: turn.error });
    return;
  }

  sseFrame(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_offline_${turnIndex}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: turn.inputTokens ?? 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

  let blockIndex = 0;
  for (const block of turn.blocks) {
    if (block.kind === 'text') {
      sseFrame(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
      // Split so the executor's own delta accumulation is exercised.
      const half = Math.max(1, Math.ceil(block.text.length / 2));
      for (const piece of [block.text.slice(0, half), block.text.slice(half)]) {
        if (piece.length === 0) continue;
        sseFrame(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: piece },
        });
      }
      sseFrame(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    } else if (block.kind === 'thinking') {
      sseFrame(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'thinking',
          thinking: '',
          signature: block.signature ?? 'offline-signature',
        },
      });
      sseFrame(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      sseFrame(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    } else {
      sseFrame(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      for (const fragment of jsonFragments(block.input)) {
        sseFrame(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: fragment },
        });
      }
      sseFrame(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }
    blockIndex++;
  }

  sseFrame(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: turn.stopReason ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: turn.outputTokens ?? 16 },
  });
  sseFrame(res, 'message_stop', { type: 'message_stop' });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Start the offline provider. Binds loopback on an ephemeral port, so parallel
 * test files never collide and nothing is reachable off the machine.
 */
export async function startOfflineProvider(script: OfflineProviderScript): Promise<OfflineProvider> {
  const requests: ProviderRequestRecord[] = [];
  const authHeadersSeen: string[] = [];
  let turnIndex = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!req.url?.endsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found', message: 'offline provider' } }));
        return;
      }
      const body = await readBody(req);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const tools = Array.isArray(parsed.tools) ? (parsed.tools as Array<{ name?: unknown }>) : [];
      const messages = Array.isArray(parsed.messages)
        ? (parsed.messages as Array<{ role?: unknown }>)
        : [];
      const system = parsed.system;

      authHeadersSeen.push(String(req.headers['x-api-key'] ?? req.headers.authorization ?? ''));
      requests.push({
        index: requests.length,
        model: parsed.model,
        maxTokens: parsed.max_tokens,
        systemBlocks: Array.isArray(system) ? system.length : system ? 1 : 0,
        toolCount: tools.length,
        toolNames: tools.map((t) => String(t.name ?? '')),
        messageRoles: messages.map((m) => String(m.role ?? '')),
        stopped: false,
      });

      // Repeat the last turn once exhausted, so a tool loop converges.
      const turn = script.turns[Math.min(turnIndex, script.turns.length - 1)];
      if (turn === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'fixture_empty', message: 'no turns configured' } }));
        return;
      }
      turnIndex++;

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      writeTurn(res, turn, requests.length, String(parsed.model ?? 'offline-model'));
      res.end();
    })();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    authHeadersSeen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
