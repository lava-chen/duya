export interface GatewayUserMapping {
  readonly id: string;
  readonly platform: string;
  readonly platformUserId: string;
  readonly platformChatId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GatewayUserMappingInput {
  readonly platform: string;
  readonly platformUserId: string;
  readonly platformChatId: string;
  readonly sessionId: string;
}

/** Local-only Gateway identity mapping; it is not exposed to remote clients. */
export interface HostLocalGatewayUserMapApiV1 {
  findGatewayUserMapping(platform: string, platformChatId: string): Promise<GatewayUserMapping | null>;
  findGatewayUserMappingBySession(sessionId: string): Promise<GatewayUserMapping | null>;
  listGatewayUserMappings(platform?: string): Promise<readonly GatewayUserMapping[]>;
  upsertGatewayUserMapping(input: GatewayUserMappingInput): Promise<void>;
}
