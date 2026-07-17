export interface GatewayInboundChatMessage {
  prompt: string;
  platform: string;
  platformMsgId: string;
  platformChatId: string;
  options?: Record<string, unknown>;
}

export interface BuildGatewayInboundChatRequestOptions {
  inbound: GatewayInboundChatMessage;
  providerConfig?: Record<string, unknown>;
  workingDirectory: string;
}

/**
 * Build the Agent Server request for an inbound channel turn.
 *
 * `workingDirectory` must be top-level: the Agent Server reads it before
 * spawning the worker. Putting it only inside `options` leaves the worker with
 * an empty cwd and makes shell tools fall back to the Electron process cwd.
 */
export function buildGatewayInboundChatRequest({
  inbound,
  providerConfig,
  workingDirectory,
}: BuildGatewayInboundChatRequestOptions): Record<string, unknown> {
  return {
    prompt: inbound.prompt,
    options: {
      ...inbound.options,
      platform: inbound.platform,
      platformMsgId: inbound.platformMsgId,
      platformChatId: inbound.platformChatId,
      agentProfileId: 'gateway',
    },
    providerConfig,
    workingDirectory,
    defaultWorkspaceDirectory: workingDirectory,
  };
}
