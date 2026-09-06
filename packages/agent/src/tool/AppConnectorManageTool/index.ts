/**
 * App Connector Management Tools (Plan 503) — bot-only connector
 * elicitation. Registered `discoverable` in the builtin registry and
 * surfaced only to bot profiles via BOT_TOOLSET.
 */
export {
  ListAppConnectorsTool,
  ConnectAppTool,
  LIST_APP_CONNECTORS_TOOL_NAME,
  CONNECT_APP_TOOL_NAME,
} from './AppConnectorManageTool.js';

import { ListAppConnectorsTool, ConnectAppTool } from './AppConnectorManageTool.js';

/** Shared singleton instances (registered in tool/builtin.ts). */
export const listAppConnectorsTool = new ListAppConnectorsTool();
export const connectAppTool = new ConnectAppTool();
