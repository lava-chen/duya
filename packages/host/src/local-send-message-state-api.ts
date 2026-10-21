import type { HostLocalSendMessageStateApiV1 } from '@duya/agent-protocol/send-message-state';
import type { SendMessageStateStore } from '@duya/data/send-message-state-store';

export function createHostLocalSendMessageStateApi(
  store: SendMessageStateStore,
): HostLocalSendMessageStateApiV1 {
  return {
    async createWidgetPending(input) { store.createWidgetPending(input); },
    async updateWidgetResponse(input) { store.updateWidgetResponse(input); },
    async upsertCursorAgentRun(input) { store.upsertCursorAgentRun(input); },
    async updateCursorAgentRun(input) { store.updateCursorAgentRun(input); },
    async createSecretPending(input) { store.createSecretPending(input); },
    async markSecretProvided(input) { store.markSecretProvided(input); },
  };
}
