import type { HostLocalUsageApiV1 } from '@duya/agent-protocol/usage-api';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { ProviderModelPricingStore } from '@duya/data/provider-model-pricing-store';

/** Local Host projection for usage-summary session versions and pricing. */
export function createHostLocalUsageApi(options: {
  readonly stores: Pick<CoreDataHostStores, 'sessions' | 'messageLog'>;
  readonly pricing: ProviderModelPricingStore;
}): HostLocalUsageApiV1 {
  return {
    async getUsageIndex() {
      const timelineVersions = options.stores.messageLog.getCountsBySession();
      const sessions = options.stores.sessions.list({}).map((session) => ({
        id: session.id,
        title: session.title,
        model: session.model,
        providerId: session.providerId ?? '',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        timelineVersion: timelineVersions.get(session.id) ?? 0,
      }));
      const pricing = options.pricing.list();
      const latestUpdatedAt = options.pricing.latestUpdatedAt();

      return {
        sessions,
        pricing,
        ...(latestUpdatedAt === null ? {} : { pricingVersion: `pricing@${latestUpdatedAt}` }),
      };
    },
  };
}
