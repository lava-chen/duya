export interface GatewayThreadWriteInput {
  readonly sessionId: string;
  readonly title: string;
  readonly now: number;
}

/** Local-only projection of Gateway sessions into the legacy thread roster. */
export interface HostLocalGatewayThreadApiV1 {
  getGatewayThreadTitle(sessionId: string): Promise<string | null>;
  ensureGatewayThread(input: GatewayThreadWriteInput): Promise<void>;
  resetGatewayThread(input: GatewayThreadWriteInput): Promise<void>;
  setGatewayThreadTitle(input: GatewayThreadWriteInput): Promise<void>;
  touchGatewayThread(sessionId: string, updatedAt: number): Promise<void>;
}
