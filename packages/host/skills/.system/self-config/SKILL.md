---
name: self-config
description: "Configures DUYA itself — reads and writes ~/.duya/config.toml, secrets.json, cronjob.toml, and related runtime files for the model, providers, MCP servers, memory (including RAG), skills, voice, cron jobs, channels, and plugins. Trigger on user requests like 'configure duya', 'change settings', 'add a model', 'add an MCP server', 'enable RAG', 'set up voice', 'schedule a cron job'. Use the `duya` CLI when available; fall back to file edits only when no CLI command exists."
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash]
---

# DUYA Self-Configuration

Guide for reading and safely editing DUYA's own configuration. All user data
lives under the config root `~/.duya/` on every platform (on Windows:
`C:\Users\<you>\.duya\`; on macOS: `~/.duya`; on Linux: `~/.duya`). There is no
separate `Application Support/duya` or `.config/duya` root — the path is the
same `~/.duya` everywhere. Start any config task by locating the real root for
this machine.

## Configuration files

| File | Format | Purpose | Security |
|---|---|---|---|
| `config.toml` | TOML | Single source of truth: storage, model, providers, agent, memory, channels, gateway, mcp_servers, plugins, skills, voice | Plaintext, never secrets |
| `secrets.json` | JSON | API keys / tokens / credentials | 0600, never log |
| `cronjob.toml` | TOML | Cron job definitions — the single authoritative source for scheduled runs | Plaintext |
| `plugins/` | dir | Installed plugins + `marketplace.json` catalog | — |
| `memory/` | dir | Memory store (see self-knowledge) | — |
| `logs/app.log` | log | Structured app logs (WARN+ to console by default) | — |

## `config.toml` structure (top-level sections)

- `[storage]` — `database_path`, `rollout_root`, `attachments_root`
- `[model]` — `default`, `provider`, `base_url` (the active model selection)
- `[providers.<id>]` — model provider entries: `id`, `name`, `providerType` (`anthropic` | `openai`), `baseUrl`, `options`. **API keys are NOT stored here** — they live in `secrets.json`
- `[agent]` — `max_turns`, `temperature`, `max_tokens`, `sandbox_enabled`, `tool_use_enforcement`, timeouts
- `[memory]` — `memory_enabled`, `user_profile_enabled`, `provider`, `model`
- `[memory.rag]` — retrievable memory (RAG, plan 428): `enabled`, `index_path`, `scan_paths`, `embedding_enabled`, `embedding_provider`, `embedding_model`. When enabled, DUYA rebuilds a SQLite index (`~/.duya/rag/memory-rag.db`, FTS5 keyword search + optional vector embeddings) over the curated memory tree plus `scan_paths` after each curation run.
- `[voice]` / `[stt]` — voice input; `stt.engine` is `local` (whisper.cpp) or `cloud` (OpenAI-compatible `/v1/audio/transcriptions`)
- `[image_generation]` — image generation (plan image-gen): `enabled`, `provider` (`openai` | `fal`), `model`, `base_url`, `api_key`, `size`, `quality`, `output_dir`, `timeout_ms`. Exposes the discoverable `image_generate` tool (reached via `tool_search`) and the `duya image` CLI subcommand. **API key preferred in env** (`IMAGE_GENERATION_API_KEY` / `OPENAI_API_KEY` / `FAL_KEY`); the `api_key` field exists for convenience but secrets belong in env. Defaults: provider `openai`, model `gpt-image-1`, size `1024x1024`, output `~/.duya/media/generated`
- `[channels]` — channel adapters (e.g. `telegram`); bot tokens live in `secrets.json`
- `[mcp_servers]` / `mcp_servers` — MCP server entries: `transport` (`stdio` | `streamable-http`), `command`, `args`, `env`, `url`, `headers`, `enabled`, `allowed_agent_ids`
- `[plugins]` — per-plugin toggles (`enabled`, `trustLevel`, `scope`, `marketplace`)
- `skills = [...]` — `[[skills.config]]` entries `{ name, enabled }` (skill enable/disable overrides, decision 15)
- `[security]` — `redact_secrets`, `secrets_encrypted`
- Reserved / not-yet-wired: `[projects]`, `[features]`, `[apps]`

## Change settings through the `duya` CLI first

Prefer the `duya` CLI over hand-editing files: it validates input, writes
atomically, splits secrets into `secrets.json`, and broadcasts the reload IPC
so changes apply immediately. Use this skill to *understand* the config; let
the CLI *write* it.

### Locating the `duya` command

`duya` is installed by the DUYA desktop app as a wrapper script. Its location
depends on platform and on whether PATH was modified:

- Windows: `%LOCALAPPDATA%\duya\bin\duya.cmd` (and `duya.ps1`). Usually on the
  user PATH; if `duya` is not found, call the wrapper by its absolute path.
- macOS / Linux: `$HOME/.local/bin/duya` (symlink into the app bundle). If
  missing from PATH, invoke `$HOME/.local/bin/duya` directly.
- Production bundle (bypasses the wrapper): `resources/cli-bundle/cli.cjs`
  inside the app's resources dir, run with the app's Node. `DUYA_CLI_USER_DATA_DIR`
  may need to point at the app's userData in dev.

Before editing any file, confirm `duya` exists and works:
`duya --version` (or the absolute wrapper path above). If it does not respond,
do NOT fall back to guessing edits — tell the user, or use the app UI / the
overrides below.

### CLI-first workflow

1. **Use the CLI for the change**: `duya provider add`, `duya mcp …`,
   `duya hook …`, `duya memory …`, `duya cron`, or the Settings UI. Prefer
   these over writing files directly — the CLI guarantees validation, secret
   splitting, and hot reload.
2. Only if there is no CLI command / UI toggle for a setting, and it *must*
   change, fall back to a minimal file edit after explaining the trade-off to
   the user.
3. After any change, verify with `duya config` / the relevant `duya …:list`
   command and confirm the app picked it up, instead of assuming it is live.

## File-handling rules (when a file edit is unavoidable)

1. **Never put secrets in `config.toml`.** Add them to `secrets.json` under a
   stable key, then reference the provider id in `config.toml`. Never print a
   secret value back to the user or to logs.
   - **Exception — `[image_generation] api_key`.** The auto-split only catches
     keys ending in `.apiKey` / `.token` / `.env.` / `.credentials.`. The
     documented field is snake_case `api_key`, so it is NOT auto-split and will
     remain in plaintext `config.toml`. Prefer the env vars
     (`IMAGE_GENERATION_API_KEY` / `OPENAI_API_KEY` / `FAL_KEY`) instead.
2. **Read first, edit minimally.** Preserve every existing section and comment.
   TOML is whitespace-sensitive — keep the `[section]` headers intact.
3. **Write atomically.** Prefer editing in place with `Edit` for small changes;
   for bulk rewrites, write to a temp file then move it over the original so a
   crash cannot leave a half-written config.
4. **Validate after editing.** For provider changes, re-read the file and check
   the section parses; verify `providerType` matches the base URL protocol.
5. **Apply.** Some settings (model, provider, mcp_servers, channels) only take
   effect after a restart of the agent / DUYA, or after the relevant reload IPC
   fires (e.g. MCP apply, skills reload). Tell the user when a restart is
   required rather than claiming the change is live.

## Common tasks

Each task has a dedicated reference file. Read only the one relevant to the
current task — load on demand, not all at once.

| Task | Reference |
|---|---|
| Add / change a model provider | `references/model-and-providers.md` |
| Add / verify an MCP server | `references/mcp.md` |
| Enable / disable a skill, or enable RAG memory | `references/skills-and-memory.md` |
| Schedule a cron job, change voice input, or enable image generation | `references/cron-and-media.md` |

When in doubt, prefer the CLI first; see "Change settings through the `duya`
CLI first" above.

## Security boundaries

- `secrets.json` is permission 0600; never change that, never copy a secret
  into a file outside `~/.duya`, and never include a secret value in a message.
- Never add hidden instruction files or prompt-injection content to config.
- Changes to `secrets.json` should be the minimal delta, with no backups left
  in plaintext.

## Where the code lives

- Config shape + defaults: `electron/config/schema.ts` (`DuyaConfig`)
- Config store / atomic writes: `electron/config/store.ts`, `store-instance.ts`
- Migration logic: `electron/config/migrate.ts`
- MCP apply + reload: see `packages/agent/src/skills/mcp.ts` and the MCP IPC
- Cron definition source: `~/.duya/cronjob.toml` (plan 409)

Read `electron/config/schema.ts` before editing config.toml so you match the
exact field names. When in doubt about a setting, ask the user instead of
guessing.