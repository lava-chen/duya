---
name: obsidian
description: Use duya against a local Obsidian vault through the official desktop `obsidian` CLI. Search and read notes, create or update notes, manage backlinks, tasks, properties, templates, and restore from local note history. Trigger on any mention of Obsidian, a vault note, or requests to search, read, summarize, create, or edit Obsidian notes. Requires the Obsidian desktop app with the official CLI enabled.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Obsidian

Work with the user's local Obsidian vault through the official desktop
`obsidian` CLI. The CLI is a local tool; duya invokes it with the `Bash` tool.
No app connection or MCP server is required.

## Preconditions

Confirm these before relying on the CLI:

- the `obsidian` command is installed and on the system path
- the Obsidian desktop CLI has been enabled and registered
- the desktop app is available locally
- the first CLI command may launch Obsidian if it is not already running
- the target vault path may live outside the current working directory, which
  changes how mutations must be executed

## Core operating policy

1. Use only documented official Obsidian CLI commands and parameters.
2. If `vault=` is used, place it first before the command.
3. Classify the target as one of: `active-file`, `resolved-file`,
   `exact-path`, `daily-note`, `ambiguous`, or `none`.
4. Use read-only resolution first when the file target is unclear.
5. Use `file=` only for loose read-only note resolution.
6. Once the exact note is known, switch to `path=` for subsequent commands.
7. Never mutate note content with `file=` or against an ambiguous target.
8. Never mutate note content through implicit active-file behavior.
9. Note-content mutations require either an exact `path=` or an explicit
   documented daily-note command such as `daily:append` or `daily:prepend`.
10. Use minimal local filesystem operations to support the CLI when needed:
    check path existence, list files or folders, create missing parent
    folders, verify results on disk, and perform safe non-content vault
    structure operations.
11. Prefer the official CLI for note-content work even when filesystem support
    is available.
12. Prefer structured output when the command documents `json`, `yaml`, `csv`,
    or `tsv`.
13. Before the first mutation in a session, run a lightweight read-only probe
    such as `obsidian version`, `read`, or `daily:read` to confirm the CLI and
    app are responsive.
14. If a capability is outside the official desktop CLI surface, say so plainly
    and stop.

## Resolution policy

- If the request already provides an exact vault-relative path, use `path=`
  immediately.
- If the request is specifically about today's daily note, use the documented
  `daily:*` command family and classify the target as `daily-note`.
- If the request only provides a note name, resolve read-only first with search
  or file discovery.
- If multiple notes could match, surface the ambiguity and stop before any
  mutation.
- If no file or path is supplied, only read-only commands may act on the
  active file.

## Command families

Read and inspect:
- `read`, `file`, `files`, `folder`, `folders`, `outline`, `search`,
  `search:context`

Create and modify:
- `create`, `append`, `prepend`, `daily`, `daily:path`, `daily:read`,
  `daily:append`, `daily:prepend`, `move`, `rename`, `delete`

Links and structure:
- `backlinks`, `links`, `unresolved`, `orphans`, `deadends`

Tasks and metadata:
- `tasks`, `task`, `properties`, `property:read`, `property:set`,
  `property:remove`, `aliases`, `tags`

Templates and history:
- `templates`, `template:read`, `template:insert`, `history`,
  `history:list`, `history:read`, `history:restore`, `diff`

## Response contract

Always return:

- the official Obsidian capability used
- the target mode: `active-file`, `resolved-file`, `exact-path`,
  `daily-note`, `ambiguous`, or `none`
- the exact command or commands proposed or run
- whether structured output was used when available
- the files affected, if any
- the blocking reason when clarification or refusal is required