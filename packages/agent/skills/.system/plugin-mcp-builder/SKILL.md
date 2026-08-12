---
name: plugin-mcp-builder
description: "Build DUYA plugins and MCP servers. Use when the user wants to extend DUYA's capabilities — create a first-party or local plugin (skills, MCP, hooks, CLI, UI), wire a new MCP server (stdio or streamable-http), or scaffold a plugin with the duya.plugin.v1 manifest. Complement to /plugin-development (full workflow) and /self-config (managing installed servers). Trigger on '做个插件', '接个 MCP', '写个 MCP server', '怎么扩展 duya', 'add a plugin', 'add an MCP server'."
when-to-use: "When the task is about extending DUYA itself via plugins or MCP, not about consuming an existing server."
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash]
---

# DUYA Plugin & MCP Builder

How to extend DUYA with plugins and MCP servers. This skill gives the
overview and the MCP-specific path; for the full plugin workflow (scaffold,
marketplace, hooks, validation, cachebuster) read `/plugin-development` and
follow its scripts. For managing already-installed MCP servers, read
`/self-config`.

## Plugin system overview

Every DUYA plugin is a directory with a manifest at its root — either
`plugin.json` (`schemaVersion: "duya.plugin.v1"`) or `plugin.md` (markdown
manifest for simple skill-only plugins). The manifest parser enforces the
schema at `electron/plugins/manifest.ts`; validation script:
`node scripts/validate-plugin.mjs <plugin-path>`.

Layout:

```
my-plugin/
├── plugin.json          # duya.plugin.v1 manifest (required)
├── plugin.md            # human-readable overview (optional)
├── skills/<name>/SKILL.md   # skill capabilities
├── mcp/servers.json     # MCP servers (or declare inline in capabilities)
├── workflows/<wf>.yaml  # workflow templates
├── permissions/policy.json  # five-tier permission policy
└── hooks/hooks.json     # hook registrations
```

`capabilities` in the manifest declares what the plugin provides:
`skills`, `mcpServers`, `cli`, `hooks`, `ui`. Required top-level fields:
`schemaVersion`, `id`, `name`, `version`, `description`, `author`,
`permissions`, `engines` (`duya` + optional `node`). No `[TODO: ...]`
placeholders — validation rejects them.

Built-in plugin examples to copy from:
`packages/plugin-core/src/plugins/builtin/` (documents, pdf, presentations,
spreadsheets). Their `plugin.json` shows the minimal manifest shape.

## MCP server integration

DUYA runs MCP servers in two transports:

- **stdio** — `command` + `args`, spawned as a child process. Default and
  recommended for local servers.
- **streamable-http** — a `url` (HTTPS-only) with optional `headers`. Used for
  remote endpoints; the agent constructs a Streamable HTTP client.

A server can be wired two ways:

1. **Declared in a plugin** (`capabilities.mcpServers` or `mcp/servers.json`),
   so it installs/scopes with the plugin and its `permissions/policy.json`.
2. **Registered in config** — an entry in `~/.duya/config.toml` under
   `mcp_servers` (fields: `transport`, `command`, `args`, `env`, `url`,
   `headers`, `enabled`, `allowedAgentIds`). This is the "user-managed" path
   (see `/self-config`).

### Building a new MCP server

Use the standard MCP SDK for the language you're comfortable with:

- **Python**: `mcp` package (`FastMCP`) — `from mcp.server.fastmcp import FastMCP`.
- **TypeScript/Node**: `@modelcontextprotocol/sdk` — `McpServer` / stdio
  transport.

Reference: the `mcp-builder` skill covers writing high-quality MCP servers
(endpoints, schemas, error handling). Follow its guidance for tool design.

Minimal FastMCP server:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("my-tools")

@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

Wire it as stdio: `command: "python"`, `args: ["path/to/server.py"]`.

### Trust & permission boundaries

- Plugins declare intent in `permissions/policy.json` (five tiers: `read`,
  `draft`, `write`, `modify`, `dangerous`). The default posture is read-only;
  write actions require confirmation.
- Keep credentials out of plugin files — no API keys in `plugin.json`, MCP
  config, or `servers.json`. Keys belong in `~/.duya/secrets.json`.
- Official remote-MCP assets are centralized in
  `packages/plugin-core/src/plugins/loader/official-assets.ts`; provider
  OAuth is handled by the app-connection layer (plan 312), not by the plugin.
- For enterprise/trust policy: `packages/plugin-core/src/security/` (trust
  level + permission policy). Tool-call gating at runtime lives in
  `packages/agent/src/permissions/`. Keep the two concepts separate.

## Suggested flow

1. Clarify the capability: skills-only plugin, MCP server, hooks, or UI.
2. For a full plugin: run the scaffold script (see `/plugin-development`),
   add capabilities with flags, validate with
   `node scripts/validate-plugin.mjs <plugin-path>`.
3. For MCP only: build the server with the SDK (FastMCP / MCP SDK), test it
   standalone, then wire it via `mcp_servers` in config or a plugin manifest.
4. Verify: enable it, check the agent can call the new tools, and confirm no
   credentials were committed.

Always reference `/plugin-development` for the authoritative schema details and
the current `scripts/create-basic-plugin.mjs` flags before generating a plugin.
