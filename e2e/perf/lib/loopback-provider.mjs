/**
 * e2e/perf/lib/loopback-provider.mjs — a scripted Anthropic Messages endpoint.
 *
 * The streaming scenario needs a model that produces a KNOWN amount of
 * output at a KNOWN rate. This server speaks the real Anthropic streaming
 * wire protocol (`text/event-stream`, `message_start` / `content_block_*` /
 * `message_delta` / `message_stop`), so the production client inside
 * `@duya/ai` opens a real socket to it and parses real SSE.
 *
 * It is a PROVIDER, not an agent: it decides the bytes of one HTTP request
 * and nothing else. It cannot open a run, append an event or settle
 * anything. The executor — the real worker behind the real agent server —
 * does all of that, which is why the numbers this fixture produces describe
 * the product and not the fixture.
 *
 * Two scripts:
 *   'text'  one long reply, streamed in `chunkCount` deltas
 *   'tool'  `toolCalls` tool_use blocks in one assistant message; the
 *           executor runs them and comes back for the follow-up request,
 *           which this server answers with a short closing text.
 */
import { createServer } from 'node:http';

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {'text'|'tool'} options.mode
 * @param {string} options.model
 * @param {number} [options.chunkCount]  text mode: how many deltas
 * @param {number} [options.chunkChars]   text mode: characters per delta
 * @param {number} [options.intervalMs]   delay between deltas
 * @param {number} [options.toolCalls]    tool mode: how many tool_use blocks
 * @param {string} [options.toolName]     tool mode: the tool to call
 * @param {string} [options.toolPath]     tool mode: the path argument
 */
export async function startLoopbackProvider(options) {
  const mode = options.mode ?? 'text';
  const model = options.model ?? 'perf-loopback-model';
  const chunkCount = options.chunkCount ?? 2000;
  const chunkChars = options.chunkChars ?? 12;
  const intervalMs = options.intervalMs ?? 10;
  const toolCalls = options.toolCalls ?? 60;
  const toolName = options.toolName ?? 'Read';
  const toolPath = options.toolPath ?? 'perf-fixture.txt';

  const requests = [];
  let textRequests = 0;

  const server = createServer((req, res) => {
    void (async () => {
      if (!req.url || !req.url.endsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found' } }));
        return;
      }
      const body = await readBody(req);
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      requests.push({
        model: parsed.model ?? null,
        toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        at: Date.now(),
      });

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      sse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_perf_loopback',
          type: 'message_start',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 16, output_tokens: 0 },
        },
      });

      if (mode === 'tool' && textRequests === 0) {
        // One assistant message carrying every tool_use block.
        for (let i = 0; i < toolCalls; i += 1) {
          const index = i;
          sse(res, 'content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: `toolu_perf_${index}`,
              name: toolName,
              input: {},
            },
          });
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({ file_path: toolPath }),
            },
          });
          sse(res, 'content_block_stop', { type: 'content_block_stop', index });
        }
        sse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: toolCalls * 8 },
        });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        textRequests += 1;
        return;
      }

      if (mode === 'tool') {
        // The follow-up request: the executor already ran the tools.
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'tool storm finished' },
        });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 },
        });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      // Text mode: one long reply, streamed delta by delta.
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      const pieces = Array.isArray(options.chunks) && options.chunks.length > 0
        ? options.chunks.map((chunk) => chunk.text)
        : Array.from({ length: chunkCount }, (_unused, i) => `chunk-${String(i).padStart(5, '0')} `);
      for (const piece of pieces) {
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: piece },
        });
        if (intervalMs > 0) await sleep(intervalMs);
      }
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: chunkCount },
      });
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    })();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
