export interface GatewayMessageMirrorInput {
  readonly sessionId: string;
  readonly role?: string;
  readonly content: string;
}

export interface HostLocalGatewayMessageMirrorApiV1 {
  appendGatewayMessageMirror(input: GatewayMessageMirrorInput): Promise<{ readonly id: string }>;
}
