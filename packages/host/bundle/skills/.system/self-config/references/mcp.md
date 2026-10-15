# MCP servers

Add, edit, and verify MCP server entries in `config.toml`. The CLI is
the only agent write path for this section — do not hand-edit
`config.toml` for MCP changes unless the CLI cannot express them.

## Add an MCP server

Use `duya mcp add`:

```bash
duya mcp add --server <name> --command <cmd> [--arg <arg>]... [--env KEY=VAL] [--agent <agent-id>]
```

For remote servers, use `--url <url>` and `--header KEY=VAL` instead
of `--command`/`--arg`. Scope with `--agent` / `allowed_agent_ids` to
restrict which agents can see the server.

The CLI validates the entry and broadcasts the MCP apply IPC so the
new server is live without a restart.

### Getting the right `command` + `args`

**Do not guess the `command` alone.** For a stdio server, the exact
`command` plus `args` is what makes it enter MCP mode — a bare
`command` (e.g. `codegraph` without `args: ["serve", "--mcp"]`)
starts the server's interactive CLI instead of speaking MCP over
stdio, so the agent never sees its tools. Always obtain the exact
`command` + `args` from the server's own documentation or its
installer:

- Run the server's official install/print subcommand when available,
  e.g. `codegraph install --print-config claude` (prints the exact
  `command`+`args` snippet), then copy those values verbatim.
- Otherwise consult the server's README / MCP page for the canonical
  stdio invocation rather than inferring it.

After adding the entry, verify the server actually connects and
yields tools (see "Verify an MCP server" below) before telling the
user it works.

## Underlying `config.toml` shape

```toml
[[mcp_servers]]
name = "<name>"
transport = "stdio" | "streamable-http"
enabled = true
command = "<cmd>"            # stdio only
args = ["...", "..."]        # stdio only
env = { KEY = "VAL" }        # stdio only, optional
url = "<endpoint>"           # streamable-http only
headers = { ... }            # streamable-http only, optional
allowed_agent_ids = ["*"]    # or restrict to specific agents
```

## Verify an MCP server

A config entry that parses is not proof the server works.
"Configured" only means the static fields are valid; the server may
still fail to connect or yield zero tools. After adding/editing a
stdio server, verify it before reporting success:

1. Confirm the `command` resolves on PATH for the process DUYA
   spawns (`Get-Command <cmd>` on Windows, `which <cmd>` on Unix). A
   PowerShell shim (`<cmd>.ps1`) is what a bare `command` resolves
   to — prefer the args form that enters MCP mode.
2. Spawn the server with the exact `command` + `args` and confirm it
   speaks MCP over stdio — a bare `command` that drops into an
   interactive CLI will time out on the handshake instead of listing
   tools.
3. Confirm the tool count is non-zero; a server that connects but
   exposes no tools is still not useful to the agent.
4. If it fails, inspect the MCP apply log / `app.log` for the
   connection error and fix the `command`+`args` (or transport/url)
   rather than assuming the config is correct.

## Disable / remove

- Disable (keep config, hide from agent): `duya mcp disable <name>`,
  or set `enabled = false` in `config.toml`.
- Remove entirely: `duya mcp remove <name>`, or delete the
  `[[mcp_servers]]` entry from `config.toml`.