import type {
  HostLocalMailboxApiV1,
  HostMailboxEnqueueInput,
} from '@duya/agent-protocol/mailbox';
import type { Mailbox } from '@duya/data/mailbox';

/** Local-only mailbox projection over the Data-owned state machine. */
export function createHostLocalMailboxApi(mailbox: Mailbox): HostLocalMailboxApiV1 {
  return {
    async getItem(id) {
      return mailbox.get(id);
    },
    async getByClientMsgId(sessionId, clientMsgId) {
      return mailbox.getByClientMsgId(sessionId, clientMsgId) ?? null;
    },
    async enqueue(input: HostMailboxEnqueueInput) {
      return mailbox.enqueue({
        id: input.id,
        sessionId: input.sessionId,
        submittedRunId: input.submittedRunId,
        content: input.content,
        kind: input.kind,
        ...(input.attachments === undefined ? {} : { attachments: [...input.attachments] }),
        ...(input.clientMsgId === undefined ? {} : { clientMsgId: input.clientMsgId }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.meta === undefined ? {} : { meta: { ...input.meta } }),
      });
    },
    async edit(id, patch) {
      return mailbox.edit(id, patch);
    },
    async guide(id) {
      return mailbox.guide(id);
    },
    async promoteQueued(id) {
      const existing = mailbox.get(id);
      return existing ? mailbox.promoteQueued(existing.sessionId, id) : null;
    },
    async cancel(id, reason) {
      return mailbox.cancel(id, reason, 'user');
    },
    async cancelByAgent(input) {
      return mailbox.cancelByAgent(input);
    },
    async claimBatch(input) {
      return mailbox.claimBatch(input);
    },
    async apply(input) {
      return mailbox.apply(input);
    },
    async listMailboxItems(sessionId, options = {}) {
      return mailbox.list(sessionId, {
        ...(options.status === undefined ? {} : { status: [...options.status] }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
    },
    async listMailboxItemsForSession(sessionId) {
      return mailbox.listForSession(sessionId);
    },
  };
}
