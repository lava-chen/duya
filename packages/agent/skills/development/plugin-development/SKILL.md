---
name: plugin-development
description: "Create DUYA plugins with valid `plugin.json` manifests matching the `duya.plugin.v1` schema. Use when the user wants to create a new plugin, add plugin capabilities (skills/hooks/MCP/CLI/UI), generate marketplace entries, or update an existing local plugin during development."
---

# Plugin Creator

## Quick Start

1. **Determine manifest format** — DUYA supports two manifest formats:

| Format | File | Best for | Complexity |
|--------|------|----------|------------|
| Markdown manifest | `plugin.md` | Simple skill-only or builtin plugins | Minimal |
| JSON manifest | `plugin.json` | Plugins with hooks, MCP servers, CLI, UI | Full |

2. **Create the plugin scaffold** — Run the scaffold script from the DUYA project root:

```bash
# Plugin names are normalized to lower-case kebab-case (max 64 chars).
# Run from the DUYA project root (where package.json lives).
# Scripts are at <duya-root>/scripts/.
# By default creates in DUYA's userData/plugins directory.
# Use --dev for development mode (userData/duya-dev/plugins).
node scripts/create-basic-plugin.mjs <plugin-name>
```

Use `--dev` when running DUYA in development mode (`npm run electron:dev`):

```bash
node scripts/create-basic-plugin.mjs my-plugin --dev --with-skills --with-marketplace
```

Use `--parent-dir` to override the output directory:

```bash
node scripts/create-basic-plugin.mjs my-plugin --parent-dir ~/duya-plugins
```

3. **Add capabilities with flags**:

```bash
node scripts/create-basic-plugin.mjs my-plugin \
  --with-skills --with-hooks --with-mcp
```

4. **Generate marketplace entry** (so the plugin appears in DUYA UI):

```bash
node scripts/create-basic-plugin.mjs my-plugin --with-marketplace
```

5. **Validate before handing back**:

```bash
node scripts/validate-plugin.mjs <plugin-path>
```

For updates to an existing local plugin:

```bash
node scripts/update-plugin-cachebuster.mjs <plugin-path>
```

---

## What this skill creates

- Creates plugin root at `/<parent-directory>/<plugin-name>/`.
- Always creates `/<parent-directory>/<plugin-name>/plugin.json` (full manifest) or `plugin.md` (markdown manifest).
- Adds a `schemaVersion` of `"duya.plugin.v1"` — required by the ingestion path.
- Fills required fields: `id`, `name`, `version`, `description`, `author`, `capabilities`, `permissions`, `engines`.
- Creates or updates `~/.duya/plugins/marketplace.json` when `--with-marketplace` is set.
- `<plugin-name>` is normalized: kebab-case, max 64 chars, no consecutive hyphens.
- Supports optional creation of:
  - `skills/` directory with placeholder `SKILL.md`
  - `hooks/` directory with sample `hooks.json`
  - `commands/` directory
  - `agents/` directory
  - `.mcp.json` for MCP server configurations

---

## Directory Layout

### Full Manifest (plugin.json)

```
my-plugin/
├── plugin.json             # Required: duya.plugin.v1 manifest
├── skills/                 # Optional: skill definitions
│   └── my-skill/
│       └── SKILL.md
├── commands/               # Optional: slash command definitions
│   └── deploy.md
├── agents/                 # Optional: sub-agent definitions
│   └── reviewer.md
├── hooks/                  # Optional: hook configurations
│   └── hooks.json
└── .mcp.json              # Optional: MCP server configs
```

### Markdown Manifest (plugin.md)

```
my-plugin/
├── plugin.md               # Required: YAML frontmatter + Markdown body
└── skills/                 # Optional: skill definitions
    └── my-skill/
        └── SKILL.md
```

---

## plugin.json Format (duya.plugin.v1)

The manifest at the plugin root must follow the `duya.plugin.v1` schema. Fields marked **(required)** are enforced by the manifest parser at `electron/plugins/manifest.ts`.

```json
{
  "schemaVersion": "duya.plugin.v1",
  "id": "com.duya.my-plugin",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does in one sentence",
  "author": {
    "name": "Your Name",
    "url": "https://github.com/yourname"
  },
  "capabilities": {
    "skills": ["./skills/my-skill/SKILL.md"],
    "mcpServers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
      }
    ],
    "cli": [
      {
        "name": "deploy",
        "command": "./scripts/deploy.sh"
      }
    ],
    "hooks": [
      {
        "event": "PreToolUse",
        "handler": "./hooks/hooks.json"
      }
    ],
    "ui": [
      {
        "id": "my-panel",
        "type": "sidebar",
        "entry": "./ui/panel.html"
      }
    ]
  },
  "permissions": [
    { "name": "file-read", "scope": "project" }
  ],
  "setup": [
    {
      "id": "api-key",
      "label": "API Key",
      "type": "secret",
      "required": true
    }
  ],
  "engines": {
    "duya": ">=0.9.0",
    "node": ">=18"
  }
}
```

### Field Guide

**Top-level (required):**

- `schemaVersion` — Always `"duya.plugin.v1"`. Validated by the manifest parser.
- `id` — Unique reverse-domain identifier (e.g., `com.duya.my-plugin`). Generated as `com.duya.<name>` by default.
- `name` — Plugin identifier, kebab-case. Must match the folder name.
- `version` — Strict semver (e.g., `0.1.0`). Development builds use cachebuster suffix: `0.1.0+duya.local-20260528`.
- `description` — Short purpose summary for the catalog view.
- `author` — Publisher identity: `name` (required), `url` (optional).
- `capabilities` — Object declaring what the plugin provides (see below).
- `permissions` — Array of permission requests (see below).
- `engines` — Version constraints: `duya` (required), `node` (optional).

**capabilities fields (all optional — omit capabilities the plugin doesn't provide):**

- `skills` — `string[]`. Paths to skill directories or `SKILL.md` files.
- `mcpServers` — `Array<{ name, command, args? }>`. MCP server configurations (inline, not file references).
- `cli` — `Array<{ name, command, args? }>`. CLI tool configurations.
- `hooks` — `Array<{ event, handler }>`. Hook registrations. `handler` points to a `.json` hook config file.
- `ui` — `Array<{ id, type, entry }>`. UI contributions. `type` is `"sidebar" | "panel" | "settings"`.

**permissions (required, can be empty `[]`):**

Each permission has:
- `name` — Permission identifier (e.g., `"file-read"`, `"network"`, `"exec"`)
- `scope` — Optional: `"plugin"`, `"project"`, or `"system"`
- `domains` — Optional: string array for network-scoped permissions

**setup (optional):**

Each setup field has:
- `id` — Field identifier
- `label` — Human-readable label
- `type` — `"text" | "secret" | "path" | "url"`
- `required` — Boolean, default `false`

**engines (required):**

- `duya` — Semver range for DUYA version compatibility (e.g., `">=0.9.0"`).
- `node` — Optional: semver range for Node.js version.

---

## plugin.md Format (Markdown Manifest)

For simple skill-only or builtin plugins, use the Markdown manifest at `plugin.md`. The manifest parser (`readPluginManifestLenient`) reads YAML frontmatter from this file:

```markdown
---
name: my-simple-plugin
title: "My Simple Plugin"
description: "A simple skill-only plugin"
version: "0.1.0"
author: "Your Name"
---

# My Simple Plugin

## What this plugin provides

- `my-skill` — A simple domain expertise skill.

## When to suggest

Suggest when the user asks about...

## Context

Additional context the agent should know about this plugin.
```

### Frontmatter Fields

- `name` (required) — Plugin identifier, kebab-case.
- `title` (optional) — Display name for the UI.
- `description` (required) — Short summary.
- `version` (optional) — Semver version.
- `author` (optional) — Publisher name.

The Markdown body is used as the `agentContext` — the text the agent reads to understand the plugin.

---

## Skill Manifest Format

Each skill lives in `skills/<skill-name>/SKILL.md`:

```markdown
---
name: my-skill
description: "What this skill provides"
---

# My Skill

## When to Apply

Describe when the agent should use this skill.

## Best Practices

1. Practice one
2. Practice two

## Examples

### Example: Scenario
Describe how this skill applies.
```

---

## Hook Config Format

Hook config files are JSON files referenced by `capabilities.hooks[].handler`:

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash(git *)",
      "command": {
        "type": "command",
        "command": "echo 'git operation detected'",
        "timeout": 5000
      }
    },
    {
      "event": "FileChanged",
      "command": {
        "type": "prompt",
        "prompt": "A file has changed. Should we run checks?",
        "timeout": 10000
      }
    }
  ]
}
```

**Hook command types:**
- `command` — Run a shell command
- `prompt` — Send a prompt to the LLM for evaluation
- `http` — HTTP callback (posts to a URL)
- `agent` — Run a sub-agent for verification

**Hook events:**
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `PermissionRequest`,
`UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `ConfigChange`,
`FileChanged`, `WorktreeCreate`, `WorktreeRemove`

---

## MCP Config Format

MCP servers can be declared inline in `capabilities.mcpServers`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
      "description": "Filesystem access"
    }
  }
}
```

Or defined in `.mcp.json` at plugin root and referenced by the PluginManager.

---

## Marketplace Workflow

- Personal marketplace file lives at `{userData}/plugins/marketplace.json`.
  - On Windows: `%APPDATA%/duya/plugins/marketplace.json` (dev: `.../duya/duya-dev/plugins/`)
  - On macOS: `~/Library/Application Support/duya/plugins/marketplace.json`
  - On Linux: `~/.config/duya/plugins/marketplace.json`
- `--with-marketplace` creates or updates entries in this file.
- `--dev` targets the development-mode userData directory.
- **DUYA reads this file on startup** via `electron/plugins/catalog.ts` — plugins listed here appear in the catalog UI.
- Each marketplace entry includes: `source`, `policy`, `category`.
- Plugin order in `plugins[]` is render order — append new entries.
- If the marketplace file doesn't exist, seed it with a root `name` and empty `plugins[]`.
- After creating a plugin with `--with-marketplace`, **restart DUYA** to see it in the catalog.
- From the catalog UI, click **Install** to install the plugin. The PluginManager will copy all plugin files (skills, scripts, assets) to the cache and register it.

### marketplace.json Format

```json
{
  "name": "personal",
  "plugins": [
    {
      "name": "my-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/my-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

**Category values** (mapped to `PluginCategory` in catalog):
`productivity`, `development`, `research`, `data`, `communication`, `media`, `automation`, `other`

**Policy values:**
- `installation`: `NOT_AVAILABLE`, `AVAILABLE`, `INSTALLED_BY_DEFAULT`
- `authentication`: `ON_INSTALL`, `ON_USE`

---

## Required Behavior

- Folder name and `plugin.json` `name` are always the same normalized plugin name.
- `schemaVersion` must be `"duya.plugin.v1"` — enforced by `readPluginManifest()`.
- `capabilities` must be an object (not null, not array).
- `permissions` must be an array (can be empty `[]`).
- `engines.duya` must be a non-empty string.
- Do not leave `[TODO: ...]` placeholders — validation rejects them.
- Omit capability keys the plugin doesn't provide (do not include empty arrays).
- When generating marketplace entries, always include `source`, `policy`, and `category`.
- Preserve existing marketplace entries when inserting new ones.

---

## Updating Existing Local Plugins (Cachebuster Flow)

When iterating on a plugin during development:

1. **Update the cachebuster** to trigger fresh load:

```bash
node scripts/update-plugin-cachebuster.mjs <plugin-path>
```

This appends/replaces a `+duya.local-<timestamp>` suffix to the version in `plugin.json`.

2. **Reinstall** the plugin in DUYA. Either:
   - From the DUYA catalog UI: remove the old version, then install again
   - Or use the IPC API: `plugin.installLocal({ pluginPath: '<path>' })`

3. **Restart DUYA** and start a new thread to pick up updated skills and tools.

### Cachebuster Format

- Preserve the existing semver prefix. Replace only the suffix.
- Format: `<base-version>+duya.local-<YYYYMMDD-HHMMSS>`
- Examples:
  - `0.1.0` → `0.1.0+duya.local-20260528-143022`
  - `0.1.0+duya.old` → `0.1.0+duya.local-20260528-143022`

---

## Validation

Before handing back a generated plugin, run:

```bash
node scripts/validate-plugin.mjs <plugin-path>
```

Validator checks against `electron/plugins/manifest.ts` expectations:
- `plugin.json` or `plugin.md` exists at plugin root
- `schemaVersion` is `"duya.plugin.v1"` (if `plugin.json`)
- `id` is present and non-empty
- `capabilities` is an object
- `permissions` is an array
- `engines.duya` is present
- No `[TODO: ...]` placeholders
- All referenced file paths resolve
- Skill `SKILL.md` files have valid YAML frontmatter
- MCP server configs have `name` and `command`

---

## Quick Reference

### Naming Rules

| Input | Output |
|-------|--------|
| `My Plugin` | `my-plugin` |
| `Code-Review` | `code-review` |
| `my__plugin` | `my-plugin` |
| `GitHub!Helper` | `github-helper` |
| Max length | 64 characters |

### Plugin Capability Flags

| Flag | Creates | plugin.json capabilities field |
|------|---------|-------------------------------|
| `--with-skills` | `skills/` directory | `"skills": [...]` |
| `--with-hooks` | `hooks/hooks.json` | `"hooks": [{ "event": "...", "handler": "..." }]` |
| `--with-mcp` | `.mcp.json` | `"mcpServers": [{ "name": "...", "command": "..." }]` |
| `--with-cli` | `commands/` or `scripts/` | `"cli": [{ "name": "...", "command": "..." }]` |
| `--with-ui` | `ui/` directory | `"ui": [{ "id": "...", "type": "...", "entry": "..." }]` |

### Hook Command Types

| Type | Purpose | Example |
|------|---------|---------|
| `command` | Run shell command | `"echo 'done'"` |
| `prompt` | Ask LLM | `"Should we continue?"` |
| `http` | HTTP request | `{"url": "https://..."}` |
| `agent` | Run sub-agent | `{"prompt": "..."}` |

---

## Publishing

### To GitHub

```bash
git init && git add . && git commit -m "Initial plugin"
gh repo create my-duya-plugin --public --push
git tag v0.1.0 && git push origin v0.1.0
```

### To DUYA Marketplace

1. Fork `duya-marketplace` repo
2. Add entry to `marketplace.json`
3. Submit pull request

---

## Troubleshooting

### Manifest validation fails

- `schemaVersion` must be `"duya.plugin.v1"` (exact string)
- `capabilities` must be an object, not a string path
- `permissions` must exist as an array (empty `[]` is valid)
- `engines.duya` is required

### Plugin not loading / not appearing in catalog

- `plugin.json` must be at plugin root (not inside a subdirectory)
- `id` follows reverse-domain format
- Plugin must be listed in `~/.duya/plugins/marketplace.json` to appear in the catalog
- **Restart DUYA** after adding/updating marketplace.json — the catalog is read on startup
- Check DUYA logs: `~/.duya/logs/app.log` for `PluginCatalog` warnings
- The `source.path` in marketplace.json must be absolute or relative to `~/.duya/plugins/`
- Verify the plugin directory exists at the path specified in marketplace.json

### Plugin installs but doesn't work

- `installFromCatalog` copies all plugin files from the source directory for local plugins
- Check that `skills/`, `hooks/`, and other capability directories exist in the source
- After install, verify the symlink at `~/.duya/plugins/installed/<plugin-id>/`
- Run `node scripts/validate-plugin.mjs <plugin-path>` to check the manifest

### Hook not firing

- Hook event name must match exactly (case-sensitive)
- Handler path must resolve to a valid `.json` file
- Enable debug logging: `export DUYA_LOG_LEVEL=debug`