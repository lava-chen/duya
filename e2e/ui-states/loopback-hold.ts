/**
 * ui-states/loopback-hold.ts — a loopback Anthropic Messages endpoint whose
 * response this spec can hold open.
 *
 * ## Why this is a local copy rather than `e2e/turn/loopback-anthropic.ts`
 *
 * The shared fixture answers and ends each request immediately. That is right
 * for its spec, which asserts the settled outcome of a turn. This spec has to
 * assert a run **while it is in flight** — `runs.status='running'` with
 * `runs.terminal IS NULL` — and a fixture that ends the moment it is asked
 * turns that assertion into a race against a millisecond-scale response. A
 * fixture that can be held open makes "pending" an observation rather than a
 * hope, which is the difference between asserting the state and hoping to
 * catch it.
 *
 * `e2e/turn/loopback-anthropic.ts` belongs to the E4.4 bullet-1 slice, and this
 * slice does not modify another slice's fixture. The wire protocol below is
 * deliberately the same one, because the point is that the production
 * `Anthropic` client inside `@duya/ai` parses real SSE from a real socket.
 *
 * ## What this is NOT
 *
 * A PROVIDER, not an agent. It has one input (a request body) and one output
 * (SSE bytes). It cannot open a run, settle a run, append a `RunEvent` or emit
 * a `chat:*` frame, and it names no tools. The executor decides what the turn
 * does; this decides the bytes for one HTTP request, and how long it keeps the
 * socket open. No packet leaves the machine and no provider credential is
 * used: `apiKey` here is a loopback token, not a secret.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HeldLoopbackOptions {
  /** The assistant text to stream, split across two deltas so the client's own
   *  accumulation is exercised rather than one whole-string frame. */
  readonly text: string;
  /** Echoed back in `message_start`; the client reports the model it asked for. */
  readonly model: string;
  /** How long the response stays open before the terminal frames are written.
   *  This is the window in which the run is genuinely still running. */
  readonly holdMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface HeldLoopback {
  readonly baseUrl: string;
  /** Every `POST /v1/messages` the real client made, in order. */
  readonly requests: ReadonlyArray<{ readonly model: unknown; readonly toolNames: readonly string[] }>;
  /** Every `x-api-key` header seen, which proves the client used the endpoint
   *  it was given rather than some configured provider. */
  readonly authHeadersSeen: readonly string[];
  close(): Promise<void>;
}

function sseFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Stream one assistant message: a text block, then the terminal frames. */
function writeTurn(res: ServerResponse, opts: HeldLoopbackOptions): void {
  sseFrame(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_loopback_held_e2e',
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

  sseFrame(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  const half = Math.max(1, Math.ceil(opts.text.length / 2));
  for (const piece of [opts.text.slice(0, half), opts.text.slice(half)]) {
    if (piece.length === 0) continue;
    sseFrame(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: piece },
    });
  }
  sseFrame(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseFrame(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: opts.outputTokens ?? 8 },
  });
  sseFrame(res, 'message_stop', { type: 'message_stop' });
}

/** Start the held endpoint on an ephemeral port. */
export async function startHeldLoopbackAnthropic(
  opts: HeldLoopbackOptions,
): Promise<HeldLoopback> {
  const requests: Array<{ model: unknown; toolNames: string[] }> = [];
  const authHeadersSeen: string[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!req.url?.endsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found', message: 'held loopback e2e provider' } }));
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

      authHeadersSeen.push(String(req.headers['x-api-key'] ?? req.headers.authorization ?? ''));
      requests.push({ model: parsed.model, toolNames: tools.map((t) => String(t.name ?? '')) });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      // Send only the opening frames, then hold the socket open. The run is
      // live and un-settled for the whole of this window, which is exactly the
      // state this spec needs to observe.
      sseFrame(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_loopback_held_e2e',
          type: 'message',
          role: 'assistant',
          model: opts.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: opts.inputTokens ?? 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
      sseFrame(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      sseFrame(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: opts.text },
      });

      await sleep(opts.holdMs);

      sseFrame(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sseFrame(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: opts.outputTokens ?? 8 },
      });
      sseFrame(res, 'message_stop', { type: 'message_stop' });
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
