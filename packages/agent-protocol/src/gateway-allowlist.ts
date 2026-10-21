export type GatewayAllowlist = Readonly<Record<string, readonly string[]>>;

/** Local-only sender policy state and atomic mutation operations. */
export interface HostLocalGatewayAllowlistApiV1 {
  getGatewayAllowlist(): Promise<GatewayAllowlist>;
  isGatewayUserAllowed(platform: string, platformUserId: string): Promise<boolean>;
  addGatewayAllowlistEntry(platform: string, platformUserId: string): Promise<void>;
  removeGatewayAllowlistEntry(platform: string, platformUserId: string): Promise<void>;
}
