/**
 * The attachment and message-card state domains of the standalone Host's
 * worker db bridge.
 *
 * ## Why this file exists
 *
 * Two worker writes went nowhere in the standalone Host, because both fell
 * through to `unimplemented_domain` and the worker kept going:
 *
 *  - `attachment:store` — the parsed-document context the worker attaches
 *    to a message was dropped;
 *  - `sendMessageState:*` — the pending state of an interactive card
 *    (widget / cursor-agent run / secret request) was never written, so a
 *    later turn could not resolve it.
 *
 * The message-card writes are best-effort by contract: the Desktop bridge
 * swallows the store error and answers with a soft failure, so the worker
 * never sees an unhandled rejection. The standalone Host keeps that
 * contract, and these assertions pin it.
 */
import { describe, expect, it } from 'vitest';
import type {
  HostLocalAttachmentApiV1,
  HostLocalParsedDocumentInput,
} from '@duya/agent-protocol/session-api';
import type {
  CreateSecretPendingInput,
  CreateWidgetPendingInput,
  CursorAgentRunInput,
  HostLocalSendMessageStateApiV1,
} from '@duya/agent-protocol/send-message-state';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';

function bridge(options: {
  readonly attachmentApi?: HostLocalAttachmentApiV1;
  readonly sendMessageStateApi?: HostLocalSendMessageStateApiV1;
}) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...options,
  });
}

function recordingAttachmentApi(): { api: HostLocalAttachmentApiV1; stored: HostLocalParsedDocumentInput[] } {
  const stored: HostLocalParsedDocumentInput[] = [];
  const api: HostLocalAttachmentApiV1 = {
    async storeParsedDocument(input) {
      stored.push(input);
      return { success: true };
    },
    async getParsedDocumentsForSession() {
      return [];
    },
    async getParsedDocumentsForMessage() {
      return [];
    },
    async getImageAttachmentsForSession() {
      return [];
    },
  };
  return { api, stored };
}

function recordingMessageStateApi(options: { readonly fail?: boolean } = {}): {
  api: HostLocalSendMessageStateApiV1;
  widgets: CreateWidgetPendingInput[];
  secrets: CreateSecretPendingInput[];
  runs: CursorAgentRunInput[];
} {
  const widgets: CreateWidgetPendingInput[] = [];
  const secrets: CreateSecretPendingInput[] = [];
  const runs: CursorAgentRunInput[] = [];
  const api: HostLocalSendMessageStateApiV1 = {
    async createWidgetPending(input) {
      if (options.fail) throw new Error('store unavailable');
      widgets.push(input);
    },
    async updateWidgetResponse() {},
    async upsertCursorAgentRun(input) {
      if (options.fail) throw new Error('store unavailable');
      runs.push(input);
    },
    async updateCursorAgentRun() {},
    async createSecretPending(input) {
      if (options.fail) throw new Error('store unavailable');
      secrets.push(input);
    },
    async markSecretProvided() {},
  };
  return { api, widgets, secrets, runs };
}

describe('the standalone Host attachment domain', () => {
  it('stores the parsed document with the fields the bridge mapped', async () => {
    const { api, stored } = recordingAttachmentApi();
    const host = bridge({ attachmentApi: api });

    await expect(host.dispatch('attachment:store', {
      messageId: 'message-1',
      sessionId: 'session-1',
      filename: 'report.pdf',
      filePath: '/tmp/report.pdf',
      charCount: 120,
      text: 'the extracted text',
      extractMethod: 'pdf',
      imageChunks: [{ base64: 'AAA', mediaType: 'image/png' }],
    })).resolves.toEqual({ success: true });

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      messageId: 'message-1',
      sessionId: 'session-1',
      filename: 'report.pdf',
      filePath: '/tmp/report.pdf',
      charCount: 120,
      text: 'the extracted text',
      extractMethod: 'pdf',
    });
    expect(stored[0].imageChunks).toHaveLength(1);
  });

  it('answers with a soft failure when the message id is empty', async () => {
    const { api, stored } = recordingAttachmentApi();
    const host = bridge({ attachmentApi: api });

    // There is no message to attach the document to. The Desktop bridge
    // answers with a soft failure here rather than throwing.
    await expect(host.dispatch('attachment:store', { sessionId: 'session-1' }))
      .resolves.toEqual({ success: false, error: 'messageId is required' });
    expect(stored).toHaveLength(0);
  });

  it('fails fast when the Host has not composed the attachment API', async () => {
    await expect(bridge({}).dispatch('attachment:store', { messageId: 'message-1' }))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });
});

describe('the standalone Host message card state domain', () => {
  it('writes the widget pending state', async () => {
    const { api, widgets } = recordingMessageStateApi();
    const host = bridge({ sendMessageStateApi: api });

    await expect(host.dispatch('sendMessageState:createWidgetPending', {
      id: 'widget-1',
      messageId: 'message-1',
      sessionId: 'session-1',
      botAgentId: 'bot-1',
      prompt: 'pick one',
      widgetJson: '{"kind":"chart"}',
      createdAt: 1700,
    })).resolves.toEqual({ success: true, messageId: 'message-1' });

    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ id: 'widget-1', messageId: 'message-1' });
  });

  it('writes the secret pending state', async () => {
    const { api, secrets } = recordingMessageStateApi();
    const host = bridge({ sendMessageStateApi: api });

    await expect(host.dispatch('sendMessageState:createSecretPending', {
      id: 'secret-1',
      messageId: 'message-1',
      sessionId: 'session-1',
      label: 'API key',
      connector: 'github',
      field: 'token',
      createdAt: 1700,
    })).resolves.toEqual({ success: true, messageId: 'message-1' });

    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({ id: 'secret-1', connector: 'github' });
  });

  it('writes the cursor agent run state', async () => {
    const { api, runs } = recordingMessageStateApi();
    const host = bridge({ sendMessageStateApi: api });

    await expect(host.dispatch('sendMessageState:upsertCursorAgentRun', {
      id: 'cursor-1',
      messageId: 'message-1',
      sessionId: 'session-1',
      bcId: 'bc-1',
      status: 'pending',
      createdAt: 1700,
      updatedAt: 1700,
    })).resolves.toEqual({ success: true, messageId: 'message-1' });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 'cursor-1', bcId: 'bc-1', status: 'pending' });
  });

  it('answers with a soft failure when the store write fails', async () => {
    const { api } = recordingMessageStateApi({ fail: true });
    const host = bridge({ sendMessageStateApi: api });

    // The write is best-effort: a failed side-state write must not become an
    // unhandled rejection inside the worker.
    await expect(host.dispatch('sendMessageState:createWidgetPending', {
      id: 'widget-1',
      messageId: 'message-1',
    })).resolves.toEqual({ success: false, reason: 'transaction_failed' });
  });

  it('fails fast when the Host has not composed the message state API', async () => {
    await expect(bridge({}).dispatch('sendMessageState:createWidgetPending', { id: 'widget-1' }))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });
});
