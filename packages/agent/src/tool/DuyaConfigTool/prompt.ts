import { DUYA_CONFIG_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `Read or modify DUYA configuration. Use this to help the user manage API providers, models, vision settings, output styles, and MCP servers through conversation.

## Available actions

### Reading config
- **providers_list** — List all configured API providers with their status
- **settings_get** — Get current agent settings (model, temperature, maxTokens, etc.)
- **vision_get** — Get current vision model settings
- **style_get** — Get current output style settings
- **mcp_server_list** — List all configured MCP servers

### Managing providers
- **provider_add** — Add or update an API provider. Requires: id, name, providerType, baseUrl?, apiKey, isActive?
- **provider_remove** — Remove a provider by id
- **provider_activate** — Switch active provider by id

### Modifying settings
- **settings_set** — Update agent settings. Allowed fields: model, maxTokens, temperature, topP, topK, enableThinking, thinkingBudget
- **vision_set** — Update vision settings. Allowed fields: provider, model
- **style_set** — Update output style. Allowed fields: styleId

### MCP server management
- **mcp_server_add** — Add a new MCP server. Requires: serverName, mcpCommand. Optional: mcpArgs, mcpEnv, agentIds
- **mcp_server_remove** — Remove an MCP server by serverName
- **mcp_server_assign** — Assign or unassign agents to an MCP server. Requires: serverName. Optional: agentIds (empty = allow all agents)

## MCP servers overview
MCP (Model Context Protocol) servers provide external tools for the agent. Each server is defined by a CLI command and arguments.
- Common commands: npx, uvx, node, python, docker
- serverName: unique identifier for the server (e.g., "brave-search", "github")
- mcpCommand: the command to run (e.g., "npx", "uvx")
- mcpArgs: command arguments (e.g., ["-y", "@anthropic/mcp-server-brave"])
- mcpEnv: environment variables for the server process (e.g., {"BRAVE_API_KEY": "..."})
- agentIds: list of agent profile IDs allowed to use this server. Leave empty/undefined to allow all agents.

### Pairing management (DM access approval)
- **pairing_list** — List all pending pairing requests and approved users across all platforms
- **pairing_approve** — Approve a pairing code for a platform. Requires: platform, code
- **pairing_revoke** — Revoke an approved user's access. Requires: platform, platformUserId
- **pairing_is_approved** — Check if a user is approved on a platform. Requires: platform, platformUserId

## Pairing system overview
When a messaging platform's DM policy is set to "pairing", unknown users receive an 8-character pairing code.
The admin must approve this code to grant access. Pairing codes:
- Use unambiguous characters (no 0/O/1/I) for readability
- Expire after 1 hour
- Max 3 pending codes per platform
- Rate limited (1 request per user per 10 minutes)
- Lockout after 5 failed approval attempts (1 hour)
- Approved users are stored persistently

## Security
- API keys are stored encrypted and never returned in full
- Only safe configuration paths are modifiable
- UI preferences and internal feature flags cannot be changed through this tool`;

export function getPrompt(): string {
  return `Tool: ${DUYA_CONFIG_TOOL_NAME} — Manage DUYA configuration`;
}