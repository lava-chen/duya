---
name: agent-create
description: "Guide for creating custom DUYA agents (bots) declared in ~/.duya/config.toml under [agents.<id>]. Use when the user wants to create a new custom agent, add a new agent to the chat agent picker or the sidebar Bots section, set up a per-agent workspace/AGENTS.md, or otherwise says they want to 'create an agent' or 'create a bot' (e.g. invoking the `duya agent create` CLI flow)."
user-invocable: true
---

# Custom Agent Creator

Custom agents (bots) are declared in `~/.duya/config.toml` under
`[agents.<id>]` and appear in the chat agent picker and the sidebar Bots
section. This skill collects the required details, scaffolds the agent's
workspace and `AGENTS.md`, and creates the agent through the
**`duya agent create` control-plane command** (the `duya_cli` tool).

## Never hand-edit config.toml

All agent creation goes through the single control-plane write path —
the same one the Settings form and the external `duya` CLI use:

```
duya agent create  →  POST /v1/config/agents  →  upsertConfigAgent()
```

This is not optional. Hand-editing `config.toml` to add an
`[agents.<id>]` section skips what the write path enforces:

- **id validation** — `^[a-z0-9][a-z0-9-]*$`; a hand-typed quoted key
  like `[agents."my/bot"]` creates an id that can never host a runtime
  identity file
- **duplicate-safe upsert** — re-running create with an existing id
  UPDATES that agent instead of appending a second TOML table with the
  same name
- **prompt preservation** — hand-edited `[agents.<id>.prompt]` tables
  survive the upsert; a blind append can clobber or duplicate them
- **identity seeding** — first creation seeds the runtime identity file
  `~/.duya/agents/<id>/profile.json` (display name / title / description
  / avatar). Identity is read-side merged over config and is what the
  sidebar Bots roster displays
- **audit logging** — the write is recorded in the control-plane audit log

If `duya agent create` fails (for example the desktop control plane is
unreachable), report the error verbatim and stop. Do NOT fall back to
editing `config.toml`.

## Config model

Each custom agent is a `[agents.<id>]` table. You do not write this TOML
yourself — `duya agent create` maps flags onto it:

| Flag                 | Required | Config field  | Meaning                                             |
|----------------------|----------|---------------|-----------------------------------------------------|
| `--id <id>`          | yes*     | `id`          | Lowercase alphanumeric + dashes, from the name      |
| `--name <name>`      | yes      | `name`        | Display name in the picker / Bots roster            |
| `--description <s>`  | no       | `description` | Short purpose shown to the user                     |
| `--workspace <dir>`  | no       | `workspace`   | Working dir; default `~/.duya/workspace/<id>`       |
| `--model <m>`        | no       | `model`       | Default model override                              |
| `--instructions-file <path>` | no | `agents_md`  | Path to the agent's `AGENTS.md`; default `<workspace>/AGENTS.md` |
| `--tools-profile <p>`| no       | `tools.profile` | `full` (default) / `coding` / `minimal` / `research` |
| `--allow <t>`        | no       | `tools.allow` | Repeatable — extra allowed tools                    |
| `--deny <t>`         | no       | `tools.deny`  | Repeatable — denied tools                           |
| `--plugins <p>`      | no       | `plugins`     | Repeatable — plugin list                            |

\* Without `--id` the command derives one from the name (slugify:
lowercase, non-alphanumerics → dashes). Pass `--id` explicitly whenever
the derived slug could be ambiguous.

## Process

### 1. Collect details (Q&A)

Ask only for what is not already obvious. Defaults are shown in bold.

- **name** — display name (required).
- **description** — one-line purpose (recommended).
- **workspace** — default `~/.duya/workspace/<id>`.
- **model** — optional model override.
- **tools profile** — `full` / `coding` / `minimal` / `research` (default `full`).
- **AGENTS.md content** — instructions for the agent (see step 3).
- **plugins** — optional plugin list.

Derive `<id>` from the name (lowercase alphanumeric plus dashes only,
e.g. `My Cool Agent` → `my-cool-agent`). **Confirm the id and name with
the user before writing anything.**

### 2. Create the workspace

```bash
mkdir -p ~/.duya/workspace/<id>
```

`~/.duya` is already an allowed directory, so no extra permission grant
is needed. (`duya agent create` also creates the directory if missing.)

### 3. Write AGENTS.md

Write the agent's instructions to `<workspace>/AGENTS.md` with the file
write tool. If the user gave no content, write a one-line placeholder:

```txt
# <name>

<description>
```

`agents_md` defaults to `<workspace>/AGENTS.md`, so in the common case
you do NOT pass `--instructions-file`. Pass it only when the user wants
the instructions at a non-default path.

### 4. Create the agent (duya_cli tool)

Call the `duya_cli` tool with a write operation (`yes: true`) and
`format: json`:

```
argv: ["agent", "create",
       "--id", "<id>",
       "--name", "<name>",
       "--description", "<description>",
       "--workspace", "~/.duya/workspace/<id>"]
```

Add `--model`, `--tools-profile`, `--allow`, `--deny`, or `--plugins`
only when the user asked for them. Omit `--description` when the user
gave none.

The response is `{ ok: true, agent: { ... } }`. On failure the tool
result carries the command's stderr — surface it verbatim.

### 5. Verify

Run `duya agent list` (`format: json`) and confirm the new id is present
with the expected fields. The config store hot-reloads, so the agent
appears in the chat agent picker and the sidebar Bots section without a
restart.

Later display edits (name / title / avatar) belong to the sidebar
"Edit Bot" dialog, which writes `agents/<id>/profile.json` — never to
re-running create with tweaked display fields.

## Hard constraints

- **Never hand-edit `config.toml`** to create, update, or delete an
  agent — not even "just to fix" an id or description.
- **Only touch the agent being created** — never other config tables,
  secrets, or unrelated agent sections.
- **Confirm `id` and `name` with the user before writing.**
- **On failure, report the error verbatim and stop.** No TOML fallback.
- Workspace parent is always under `~/.duya`; never place workspaces
  elsewhere without explicit user consent.
