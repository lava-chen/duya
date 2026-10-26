import type { ChannelOutboundMessage } from './channels.js';

/** Authenticated routing snapshot. Credentials never belong in this record. */
export interface BotChannelTarget {
  readonly ownerId: string;
  readonly botId: string;
  readonly bindingId: string;
  readonly platform: string;
  readonly chatId: string;
  readonly authorizationRevision?: string;
}

export type BotDeliveryStatus = 'pending' | 'sending' | 'delivered' | 'unknown' | 'blocked';

export interface BotDelivery {
  readonly id: string;
  readonly inboxId: string;
  readonly runId: string;
  readonly target: BotChannelTarget;
  readonly outbound: ChannelOutboundMessage;
  readonly status: BotDeliveryStatus;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly deadlineMs: number | null;
  readonly remoteMessageId: string | null;
  readonly reason: string | null;
  readonly createdAtMs: number;
}

export type BotDeliveryResult =
  | { readonly state: 'delivered'; readonly remoteMessageId: string }
  | { readonly state: 'not_sent'; readonly reason: string }
  | { readonly state: 'unknown' };

/** Only an authenticated local owner can query these durable receipts. */
export interface HostBotDeliveryApiV1 {
  listBotDeliveries(botId: string): Promise<readonly BotDelivery[]>;
}
