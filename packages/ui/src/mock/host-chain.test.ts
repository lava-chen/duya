/**
 * The mock's own contract, exercised through the PRODUCT's plumbing.
 *
 * This test drives the exact chain the browser drives:
 *
 *   mock bridge -> createUiServices -> runs.listBySession -> runs.openSession
 *   -> the run projection's durable-window poll -> mergeRunSessionRows
 *
 * If the scripted reply does not come out of that chain, the mock is not
 * showing what the product shows, and a browser session proves nothing.
 */

import { describe, expect, it } from 'vitest';
import { createUiServices } from '@/services';
import { mergeRunSessionRows } from '@/lib/run-session-view';
import { createMockHostBridge } from './mock-host-bridge';
import { MOCK_SESSION_IDS } from './fixtures';

const POLL_INTERVAL_MS = 5;

describe('mock host chain', () => {
  it('projects the scripted reply through the shared run projection', async () => {
    const bridge = createMockHostBridge();
    const services = createUiServices({
      bridge,
      platform: 'web',
      capabilities: {
        localFileAccess: false,
        settings: false,
        extensions: false,
        bots: false,
        automation: false,
        workflows: false,
        turnConfiguration: true,
      },
      ledgerPollIntervalMs: POLL_INTERVAL_MS,
    });

    const sessionId = MOCK_SESSION_IDS.sidebar;
    const runs = await services.runs.listBySession(sessionId);
    expect(runs.length).toBe(1);
    const runId = runs[0]!.runId;

    const controller = new AbortController();
    const projection = services.runs.openSession(runId, sessionId, controller.signal);
    projection.start();

    // Wait until the durable-window poll has drained the script.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const snapshot = projection.getSnapshot();
      if (snapshot.messages.length > 0 && snapshot.run.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const snapshot = projection.getSnapshot();
    controller.abort();

    // The projection carries the assistant text and the tool call.
    expect(snapshot.messages.length).toBe(1);
    expect(snapshot.messages[0]!.text).toContain('信息架构');
    expect(snapshot.toolCalls.length).toBe(1);

    // And the renderer sees the same rows the chat view renders.
    const rows = mergeRunSessionRows([], snapshot);
    const assistant = rows.find((row) => row.role === 'assistant' && row.content !== '');
    expect(assistant).toBeDefined();
    expect(assistant!.content).toContain('信息架构');
  });
});
