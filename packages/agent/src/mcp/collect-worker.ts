/** Compatibility re-export for callers migrating to Host connector services. */
export {
  collectWorkerMCPCandidates,
  fetchPluginSetupValuesForMcp,
} from '@duya/host/connector-services/collector';
export type {
  MCPCollectorDatabasePort,
  MCPCollectorLogger,
  MCPCollectorPorts,
} from '@duya/host/connector-services/collector';
