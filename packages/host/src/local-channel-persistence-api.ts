import type {
  ChannelBindingInput,
  ChannelOffsetInput,
  HostLocalChannelPersistenceApiV1,
  WeixinContextTokenInput,
} from '@duya/agent-protocol/channel-persistence';
import type { ChannelPersistenceStore } from '@duya/data/channel-persistence-store';

export function createHostLocalChannelPersistenceApi(
  store: ChannelPersistenceStore,
): HostLocalChannelPersistenceApiV1 {
  return {
    async listChannelBindings(channelType) {
      return store.listBindings(channelType);
    },
    async getChannelBinding(channelType, chatId) {
      return store.getBinding(channelType, chatId);
    },
    async upsertChannelBinding(input: ChannelBindingInput) {
      return store.upsertBinding(input);
    },
    async getChannelOffset(channelType, offsetKey) {
      return store.getOffset(channelType, offsetKey);
    },
    async setChannelOffset(input: ChannelOffsetInput) {
      store.setOffset(input);
    },
    async getWeixinContextToken(accountId: string, peerUserId: string) {
      return store.getWeixinContextToken(accountId, peerUserId);
    },
    async setWeixinContextToken(input: WeixinContextTokenInput) {
      store.setWeixinContextToken(input);
    },
    async deleteWeixinContextTokens(accountId: string) {
      store.deleteWeixinContextTokens(accountId);
    },
  };
}
