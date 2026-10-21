/** Compatibility re-export for callers migrating to Host connector services. */
export {
  getSettingsPath,
  getUserMcpTomlPath,
  mergeMcpSecrets,
  readUserMcpToml,
} from '@duya/host/connector-services/config';
export type {
  MCPConfigItem,
  MCPConfigReadOptions,
} from '@duya/host/connector-services/config';
