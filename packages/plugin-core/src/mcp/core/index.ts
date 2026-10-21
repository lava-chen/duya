// packages/plugin-core/src/mcp/core/index.ts
// Plan 580 D1 — protocol-pure MCP Core barrel. NO dependencies outside
// this package (plus the MCP SDK types); no Registry / Catalog /
// connection-layer knowledge.

export {
  McpError,
  classifyMcpError,
  breakerDisposition,
  breakerDispositionForError,
  errorCodeForClass,
  getMcpErrorCode,
} from './error-taxonomy.js';
export type {
  McpErrorCode,
  McpErrorClass,
  BreakerDisposition,
} from './error-taxonomy.js';

export {
  createDeadlineClock,
  deadlineClockFrom,
  deadlineClockFromIpc,
} from './deadline.js';
export type { DeadlineClock } from './deadline.js';

export { canonicalizeJson, computeSchemaRevision } from './descriptor.js';
export type { McpToolDescriptor } from './descriptor.js';

export {
  listAllTools,
  formatDiscoveryLogLine,
  discoveryDebugEnabled,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_TOOLS,
} from './list-tools.js';
export type {
  McpListToolsClient,
  ListAllToolsOptions,
  ListAllToolsResult,
  DiscoveryTruncation,
} from './list-tools.js';

export {
  fnv1a32Hex,
  deriveConnectionSlug,
  connectionNamespace,
  allocateConnectionToolAlias,
  CONNECTION_TOOL_ALIAS_MAX_LENGTH,
} from './alias.js';

export {
  projectForProvider,
  downgradedSchemaDescription,
  DEFAULT_PROVIDER_SPEC_BUDGET,
} from './projection.js';
export type { SchemaProjection } from './projection.js';

export {
  emptyLedgerSnapshot,
  serializeInventoryLedgerSnapshot,
} from './ledger-types.js';
export type {
  InventoryLedgerSnapshot,
  InventoryLayers,
  DiscoveryStatus,
} from './ledger-types.js';
