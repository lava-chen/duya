---
name: agent-create
description: "Guide for creating custom DUYA agents described in ~/.duya/config.toml under [agents.<id>]. Use when the user wants to create a new custom agent, add a new agent to the chat agent picker, set up a per-agent workspace/AGENTS.md, or otherwise says they want to 'create an agent' (e.g. invoking the `duya agent create` CLI flow)."
user-invocable: true
---

# Custom Agent Creator

Guide for creating config-driven custom agents in DUYA. Custom agents are
declared in `~/.duya/config.toml` under `[agents.<id>]` and appear in the chat
agent picker. This skill collects the required details, scaffolds the agent's
workspace and `AGENTS.md`, and appends the TOML section safely.

## Config model

Each custom agent is a `[agents."<id>"]` table in `~/.duya/config.toml`.
Supported fields (mirror `CustomAgentConfig`):

| Field          | Required | Meaning                                        |
|----------------|----------|------------------------------------------------|
| `name`         | yes      | Display name in the agent picker               |
| `description`  | yes      | Short purpose shown to the user                |
| `workspace`    | yes*     | Working dir; defaults to `~/.duya/workspace/<id>` |
| `model`        | no       | Default model override                         |
| `agents_md`    | no       | Path to the agent's `AGENTS.md`; defaults to `<workspace>/AGENTS.md` |
| `tools`        | no       | `{ profile = "..." }` tool profile             |
| `plugins`      | no       | Optional plugin list                           |

Tool profiles (`tools.profile`): `full` (default), `coding`, `minimal`,
`research`.

## Process

### 1. Collect details (Q&A)

Ask only for what is not already obvious. Defaults are shown in bold.

- **name** — display name (required).
- **description** — one-line purpose (required).
- **workspace** — default `~/.duya/workspace/<slug>`.
- **model** — optional model override.
- **tools profile** — `full` / `coding` / `minimal` / `research` (default `full`).
- **AGENTS.md content or path** — optional; a path to an existing file or raw
  content to write.
- **plugins** — optional `plugins` list.

Derive `<id>` (slug) from the name: lowercase alphanumeric plus dashes only,
e.g. `My Cool Agent` → `my-cool-agent`. **Confirm the id and name with the user
before writing anything to config.**

### 2. Create the workspace

```bash
mkdir -p ~/.duya/workspace/<slug>
```

`~/.duya` is already an allowed directory, so no extra permission grant is
needed.

### 3. Write AGENTS.md

Write the agent's instructions to `<workspace>/AGENTS.md`. If the user gave no
content, write a one-line placeholder:

```txt
# <name>

<description>
```

### 4. Append the TOML section

Append to `~/.duya/config.toml` (create the file if it does not exist):

```toml
[agents."<id>"]
name = "<name>"
description = "<description>"
workspace = "<workspace>"
model = "<model>"                     # optional
agents_md = "<workspace>/AGENTS.md"
tools = { profile = "<profile>" }
```

Use the strongly-quoted key `[agents."<id>"]` so slashes/hyphens in the id are
safe. Only add `model`, `plugins`, or `tools.deny`/`tools.allow` when the user
asked for them.

### 5. Validate and confirm

- Re-read `~/.duya/config.toml` and confirm it still parses as TOML (or rely on
  the ConfigStore hot-reload to surface a parse error).
- Confirm the agent now appears in the chat agent picker.

## Hard constraints

- **Only modify the `[agents."<id>"]` section** — never touch other config
  tables, secrets, or unrelated agent sections.
- **Confirm `id` and `name` with the user before writing** the config.
- Workspace parent is always under `~/.duya`; never place workspaces elsewhere
  without explicit user consent.
- If `config.toml` fails to parse after the edit, revert your appended block
  and report the error rather than reformatting the whole file.