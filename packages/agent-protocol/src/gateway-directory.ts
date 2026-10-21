export interface GatewayChannelDirectoryEntry {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  readonly guild?: string;
  readonly type: string;
}

export interface HostLocalGatewayDirectoryApiV1 {
  listGatewayChannels(platform?: string): Promise<readonly GatewayChannelDirectoryEntry[]>;
  replaceGatewayChannels(
    platform: string,
    channels: readonly Omit<GatewayChannelDirectoryEntry, 'platform'>[],
  ): Promise<void>;
}
