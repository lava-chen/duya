---
name: mcp-management
description: Manage user-installed MCP servers in DUYA. Use when a user asks to add, configure, remove, scope, or diagnose an MCP server for DUYA Agent. Covers safe stdio MCP installation through the DUYA control plane and mcp.toml reload behavior; do not use for plugin-bundled MCP servers.
---

# MCP Management

Manage user MCP servers through `duya_cli`; do not directly edit `mcp.toml` or legacy settings stores. The control plane is the only agent write path and writes the same user configuration used by the Settings MCP page.

## Tool access

`duya_cli` is discoverable. If it is not in the current tool list, call `tool_search` with `duya_cli`, then use the complete schema supplied on the next turn. Do not substitute a shell command or a direct file write.

## Scope

- Manage only user-installed MCP servers.
- Do not add, remove, or alter MCP servers supplied by plugins. Direct the user to the plugin settings instead.
- Treat `mcp.toml` as the persisted source of truth. DUYA reloads it after every control-plane write and watches it for manual edits.

## Add a stdio server

1. Identify the server name, executable, arguments, and any required environment variable from the server's official setup instructions.
2. Explain the command and required permissions before creating it. Do not put secrets in prose, logs, or an untrusted command.
3. Call `duya_cli` with `yes: true` and argv-style arguments. Repeat `--arg`, `--env`, and `--agent` as needed.

```json
{
  "argv": [
    "mcp", "add",
    "--server", "example",
    "--command", "npx",
    "--arg", "-y",
    "--arg", "@example/mcp-server",
    "--env", "EXAMPLE_TOKEN=<user-provided-secret>",
    "--yes"
  ],
  "yes": true,
  "format": "json"
}
```

`mcp add` currently configures stdio servers (`command`, repeated `--arg`, repeated `--env`). Do not pretend it can configure an HTTP MCP endpoint; explain that HTTP setup needs first-class control-plane and Settings UI support before configuring it for the user.

## Manage an existing user server

- Remove: `duya_cli` with `argv: ["mcp", "remove", "<name>", "--yes"]` and `yes: true`.
- Scope to profiles: `duya_cli` with `argv: ["mcp", "assign", "<name>", "--agent", "<profile-id>", "--yes"]` and `yes: true`. Omit `--agent` to make it available to all profiles.
- After each write, state that DUYA has requested a live reload. Confirm usable capabilities from the next MCP capability directory or the Settings MCP status; do not claim a server connected merely because configuration was written.

## Failure handling

- If the control plane reports a duplicate server name, do not overwrite it. Ask whether the user wants removal and re-addition.
- If the server cannot launch, keep the configuration intact, report the connection error, and check executable, arguments, dependencies, and required environment variables.
- Never move a plugin MCP into `mcp.toml` just to make it visible. Plugin MCPs use their own lifecycle.
