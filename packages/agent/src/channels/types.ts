/**
 * Compatibility surface for the legacy Agent package.
 *
 * Shared channel contracts now live in @duya/agent-protocol/channels.
 * Credential records stay local to this package and are not a wire contract.
 */
export * from '@duya/agent-protocol/channels';

export interface ConnectorSecretRecord {
  [field: string]: string;
}