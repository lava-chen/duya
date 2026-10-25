/**
 * turn/loopback-anthropic.ts — a loopback Anthropic Messages endpoint for the
 * E2E turn spec.
 *
 * ## What this is
 *
 * A real HTTP server on 127.0.0.1 that speaks the real Anthropic Messages
 * streaming wire protocol: `POST /v1/messages`, `content-type:
 * text/event-stream`, and the `message_start` / `content_block_start` /
 * `content_block_delta` / `content_block_stop` / `message_delta` /
 * `message_stop` frame sequence that `api.anthropic.com` emits. The production
 * `Anthropic` client inside `@duya/ai` opens a real socket to it and parses the
 * real SSE.
 *
 * ## Why it is not E4.1's `eval-offline-provider.ts`
 *
 * That fixture is the better one — it scripts thinking blocks, tool calls,
 * usage accounting and mid-stream errors, and it is the reference the eval
 * matrix is written against. It is not reachable from here without cost, and
 * the cost is measured rather than assumed:
 *
 *  - `e2e` IS one of the audit's roots (`scripts/architecture/audit-imports.mjs`
 *    ROOTS = `["apps","packages","tests","e2e"]`), while `evals` deliberately
 *    is not. So `evals -> host test tree` is invisible to the architecture
 *    gates and `e2e -> host test tree` is not.
 *  - Importing it from a spec measured `module-dependency` 460 -> 461 — one
 *    new blocking edge (`e2e/turn/electron-turn.spec.ts` ->
 *    `apps/desktop/src/main/__tests__/eval-offline-provider.ts`), with zero
 *    `deep-import` and zero `package-boundary-escape` movement.
 *  - `apps/desktop/src/main/__tests__/**` is excluded from every tsconfig in
 *    the repo, so nothing typechecks that file. Reaching into it from a spec
 *    that no tsconfig covers either means an untyped import on both sides.
 *
 * The narrow alternative is to declare `e2e` as a module permitted to reach
 * the host, which is a governance decision about the whole e2e tree and not
 * something a test slice should decide for it.
 *
 * ## What this is NOT
 *
 * It is a PROVIDER, not a fake agent. It has one input (a request body) and
 * one output (SSE bytes); it knows nothing about runs, sessions, manifests,
 * budgets or terminals, and it cannot emit a `chat:*` frame, append a
 * `RunEvent` or settle a run. Optional tool calls use names taken from the
 * request's advertised tools, but this server still only decides the bytes
 * returned for one HTTP request. The executor decides what the turn does.
 *
 * The default response stays text-only for the E4.4 turn-boundary check. The
 * optional tool-call response lets the plugin UI smoke test exercise MCP tool
 * execution and host events through the same real Agent Server and worker.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackAnthropicOptions {
  /** The assistant text to stream, split across two deltas so the client's own
   *  accumulation is exercised rather than one whole-string frame. */
  readonly text: string;
  /** Reported back in `message_start`; the client echoes the model it asked for. */
  readonly model: string;
  /** Token counts the fixture declares, so usage accounting has something real
   *  to read. The E2E spec does not assert on them; they exist because the wire
   *  format carries them. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Optional first-request MCP tool calls, selected by an advertised tool-name fragment. */
  readonly toolCalls?: readonly {
    readonly nameIncludes: string;
    readonly input: Record<string, unknown>;
  }[];
}

export interface LoopbackAnthropic {
  /** Hand this to the chat request as `providerConfig.baseURL`. */
  readonly baseUrl: string;
  /** Every `POST /v1/messages` the real client made, in order. */
  readonly requests: ReadonlyArray<{ readonly model: unknown; readonly toolNames: readonly string[] }>;
  /** Tool calls the model fixture actually returned, in request order. */
  readonly toolCallsSent: ReadonlyArray<{ readonly name: string; readonly input: Record<string, unknown> }>;
  /** Every `x-api-key` header seen, which is how the spec proves the client
   *  used the endpoint it was given rather than a configured provider. */
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

/** Stream one assistant message: a text block, then the terminal frames. */
function writeTurn(res: ServerResponse, opts: LoopbackAnthropicOptions): void {
  sseFrame(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_loopback_e2e',
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

function writeToolCalls(
  res: ServerResponse,
  opts: LoopbackAnthropicOptions,
  calls: ReadonlyArray<{ name: string; input: Record<string, unknown> }>,
): void {
  sseFrame(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_loopback_tool_${Date.now()}`,
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
  calls.forEach((call, index) => {
    sseFrame(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `toolu_loopback_${Date.now()}_${index}`, name: call.name, input: {} },
    });
    sseFrame(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    });
    sseFrame(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sseFrame(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: opts.outputTokens ?? 8 },
  });
  sseFrame(res, 'message_stop', { type: 'message_stop' });
}

/**
 * Start the loopback endpoint on an ephemeral port, so parallel spec files
 * never collide and nothing is reachable off the machine.
 */
export async function startLoopbackAnthropic(
  opts: LoopbackAnthropicOptions,
): Promise<LoopbackAnthropic> {
  const requests: Array<{ model: unknown; toolNames: string[] }> = [];
  const toolCallsSent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const authHeadersSeen: string[] = [];

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!req.url?.endsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found', message: 'loopback e2e provider' } }));
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
      requests.push({
        model: parsed.model,
        toolNames: tools.map((t) => String(t.name ?? '')),
      });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const matchingCalls = (requests.length === 1 ? opts.toolCalls ?? [] : [])
        .flatMap((plannedToolCall) => {
          const matchingTool = tools.find((tool) => String(tool.name ?? '').includes(plannedToolCall.nameIncludes));
          if (!matchingTool || typeof matchingTool.name !== 'string') return [];
          const call = { name: matchingTool.name, input: plannedToolCall.input };
          toolCallsSent.push(call);
          return [call];
        });
      if (matchingCalls.length > 0) {
        writeToolCalls(res, opts, matchingCalls);
      } else {
        writeTurn(res, opts);
      }
      res.end();
    })();
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    toolCallsSent,
    authHeadersSeen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
