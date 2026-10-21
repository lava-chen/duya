// @vitest-environment node

/**
 * workflow-run-stream.test.ts — plan 560 D5: the wire side of the run stream.
 *
 * The route's frame shape is what the panel renders from, so the parser is
 * tested against a real SSE byte stream (ReadableStream → fetch → reader) rather
 * than by mocking internals: a framing bug here shows up as an empty run card.
 */

import { describe, expect, it } from 'vitest';
import { openWorkflowRunStream, type WorkflowRunSseFrame } from './workflow-run-stream';

const encoder = new TextEncoder();

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const PORT_RESOLVER = async () => 4123;

describe('openWorkflowRunStream', () => {
  it('parses every frame kind and stops on the terminal one', async () => {
    const frames: WorkflowRunSseFrame[] = [];
    const result = await openWorkflowRunStream({
      runId: 'run-1',
      afterSeq: 3,
      onFrame: (f) => frames.push(f),
      signal: new AbortController().signal,
      resolvePort: PORT_RESOLVER,
      fetchImpl: (async () =>
        sseResponse([
          'event: record\nid: 4\ndata: {"frame":"record","runId":"run-1","seq":4,"record":{"seq":4,"kind":"phase"}}\n\n',
          'event: artifact\ndata: {"frame":"artifact","runId":"run-1","artifact":{"name":"report.md","relPath":"run-1/report.md"}}\n\n',
          'event: permission\ndata: {"frame":"permission","runId":"run-1","request":{"requestId":"req-1","toolName":"Bash"}}\n\n',
          'event: done\ndata: {"frame":"done","runId":"run-1","summary":{"runId":"run-1","status":"complete"}}\n\n',
        ])) as typeof fetch,
    });

    expect(result.ended).toBe('done');
    expect(frames.map((f) => f.frame)).toEqual(['record', 'artifact', 'permission', 'done']);
    expect(frames[0].seq).toBe(4);
    expect((frames[0].record as { seq: number }).seq).toBe(4);
    expect((frames[1].artifact as { name: string }).name).toBe('report.md');
    expect((frames[2].request as { requestId: string }).requestId).toBe('req-1');
    expect((frames[3].summary as { status: string }).status).toBe('complete');
  });

  it('ignores keep-alive comment lines and unknown event kinds', async () => {
    const frames: WorkflowRunSseFrame[] = [];
    const result = await openWorkflowRunStream({
      runId: 'run-1',
      afterSeq: 0,
      onFrame: (f) => frames.push(f),
      signal: new AbortController().signal,
      resolvePort: PORT_RESOLVER,
      fetchImpl: (async () =>
        sseResponse([
          ': keep-alive\n\n',
          ': keep-alive\n\n',
          'event: record\nid: 1\ndata: {"frame":"record","runId":"run-1","seq":1,"record":{"seq":1}}\n\n',
          'event: heartbeat\ndata: {"frame":"heartbeat"}\n\n',
        ])) as typeof fetch,
    });

    // No terminal frame: the server just closed, so the caller must retry.
    expect(result.ended).toBe('aborted');
    expect(frames.map((f) => f.frame)).toEqual(['record']);
  });

  it('survives an unparseable data line without corrupting the stream', async () => {
    const frames: WorkflowRunSseFrame[] = [];
    await openWorkflowRunStream({
      runId: 'run-1',
      afterSeq: 0,
      onFrame: (f) => frames.push(f),
      signal: new AbortController().signal,
      resolvePort: PORT_RESOLVER,
      fetchImpl: (async () =>
        sseResponse([
          'event: record\ndata: {not json}\n\n',
          'event: record\ndata: {"frame":"record","runId":"run-1","seq":2,"record":{"seq":2}}\n\n',
        ])) as typeof fetch,
    });
    expect(frames.map((f) => f.seq)).toEqual([2]);
  });

  it('reports a transport error for a non-200 response', async () => {
    const result = await openWorkflowRunStream({
      runId: 'run-1',
      afterSeq: 0,
      onFrame: () => {},
      signal: new AbortController().signal,
      resolvePort: PORT_RESOLVER,
      fetchImpl: (async () => sseResponse(['nope'], 404)) as typeof fetch,
    });
    expect(result.ended).toBe('error');
    expect(result.error).toContain('404');
  });

  it('reports an error when there is no server to talk to', async () => {
    const result = await openWorkflowRunStream({
      runId: 'run-1',
      afterSeq: 0,
      onFrame: () => {},
      signal: new AbortController().signal,
      resolvePort: async () => null,
    });
    expect(result.ended).toBe('error');
    expect(result.error).toContain('agent server');
  });
});
