export interface ChannelBindingRow {
  readonly id: string;
  readonly channel_type: string;
  readonly chat_id: string;
  readonly duya_session_id: string;
  readonly sdk_session_id: string;
  readonly working_directory: string;
  readonly model: string;
  readonly mode: string;
  readonly active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ChannelBindingInput {
  readonly id: string;
  readonly channel_type: string;
  readonly chat_id: string;
  readonly duya_session_id: string;
  readonly sdk_session_id?: string;
  readonly working_directory?: string;
  readonly model?: string;
  readonly mode?: string;
}

export interface ChannelOffsetRow {
  readonly channel_type: string;
  readonly offset_key: string;
  readonly offset_value: string;
  readonly offset_type: string;
  readonly updated_at: number;
}

export interface ChannelOffsetInput {
  readonly channelType: string;
  readonly offsetKey: string;
  readonly offsetValue: string;
  readonly offsetType?: string;
}

export interface WeixinContextTokenInput {
  readonly accountId: string;
  readonly peerUserId: string;
  readonly contextToken: string;
}

/** Authenticated local persistence API for channel bindings, offsets, and Weixin context tokens. */
export interface HostLocalChannelPersistenceApiV1 {
  listChannelBindings(channelType?: string): Promise<readonly ChannelBindingRow[]>;
  getChannelBinding(channelType: string, chatId: string): Promise<ChannelBindingRow | null>;
  upsertChannelBinding(input: ChannelBindingInput): Promise<ChannelBindingRow | null>;
  getChannelOffset(channelType: string, offsetKey: string): Promise<ChannelOffsetRow | null>;
  setChannelOffset(input: ChannelOffsetInput): Promise<void>;
  getWeixinContextToken(accountId: string, peerUserId: string): Promise<string | null>;
  setWeixinContextToken(input: WeixinContextTokenInput): Promise<void>;
  deleteWeixinContextTokens(accountId: string): Promise<void>;
}
