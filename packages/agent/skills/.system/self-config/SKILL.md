---
name: self-config
description: "DUYA self-configuration — 配置 DUYA 自身：记忆(含 RAG 检索钩子)、模型、MCP、频道、定时任务、语音、技能、agent 行为，编辑 ~/.duya/config.toml 等。用户说"配置 duya / 改设置 / 配 MCP / 加模型 / 配记忆 / 配钩子 / 配定时任务"时使用。Do not use for the user's own project; that is ordinary file work."
when-to-use: "Whenever the task reads or writes DUYA's own runtime configuration (~/.duya), not user project config."
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

Each task below lists the *preferred* `duya` CLI / UI path first, with the
underlying `config.toml` shape as reference only (the CLI writes it for you).

- **Add a model provider**: use the Settings UI or `duya provider` /
  `duya config set` if available. Underlying shape: `[providers.<id>]` in
  `config.toml`, `[model] default/provider/base_url`, key in `secrets.json`.
- **Add an MCP server**: use `duya mcp add --server <name> --command <cmd>`
  (plus `--arg`, `--env KEY=VAL`, `--agent`). Underlying shape: an entry in
  `mcp_servers` (stdio: `command`+`args`; remote: `url`+`headers`), scope with
  `allowed_agent_ids` if desired. **Do not guess the `command` alone.** For a
  stdio server, the exact `command` plus `args` is what makes it enter MCP
  mode — a bare `command` (e.g. `codegraph` without `args: ["serve", "--mcp"]`)
  starts the server's interactive CLI instead of speaking MCP over stdio, so
  the agent never sees its tools. Always obtain the exact `command` + `args`
  from the server's own documentation or its installer:
  - Run the server's official install/print subcommand when available, e.g.
    `codegraph install --print-config claude` (prints the exact
    `command`+`args` snippet), then copy those values verbatim.
  - Otherwise consult the server's README / MCP page for the canonical
    stdio invocation rather than inferring it.
  After adding the entry, verify the server actually connects and yields
  tools (see "Verify an MCP server" below) before telling the user it works.
- **Enable/disable a skill**: use the Settings UI / skill manager when
  present. Underlying shape: `{ name = "<skill>", enabled = false }` in the
  `skills` array (or remove it to re-enable).
- **Enable retrievable memory (RAG)**: toggle Settings → Memory → RAG, or set
  `enabled = true` under `[memory.rag]` (a file edit is acceptable here), and
  add extra scan dirs to `scan_paths` if desired. Then register the retrieval
  hook with the CLI — do NOT hand-edit config.toml for hooks:
  1. Use the `hooks.json` in the `memory-search` skill
     (`packages/agent/skills/.system/memory-search/`) — fix its `args[0]` to
     the absolute path of `scripts/memory-rag-hook.mjs` on this machine.
  2. Register it: `duya hook add <path-to-that-hooks.json>` (validates the
     file before writing; `--yes` required in non-interactive mode).
     `duya hook validate <path>` checks a file without writing;
     `duya hook list` shows what is registered.
  The template runs the retrieval in the **background** (`async: true`) and
  delivers the result back into the session as a background notification
  next turn (`asyncRewake: true`) — keep both fields; a synchronous RAG
  hook would block the first turn and its stdout is never injected into
  the model. Query the index directly with `duya memory search "<query>"`
  (or rebuild on demand with `duya memory rebuild`); see the
  `memory-search` skill for the full RAG overview and hook.json schema.
- **Schedule a cron job**: use `duya cron` / the Settings UI. Underlying
  source: `~/.duya/cronjob.toml`.
- **Change voice input**: use the Settings UI if present. Underlying shape:
  `[voice] stt.engine` and device/model fields.
- **Enable image generation**: add a `[image_generation]` section to
  `config.toml` (no dedicated CLI subcommand exists; this one is a file edit):
  ```toml
  [image_generation]
  enabled = true
  provider = "openai"     # openai | fal
  model = "gpt-image-1"   # openai: gpt-image-1/2, dall-e-3; fal: fal-ai/flux/dev …
  # base_url = ""         # OpenAI-compatible endpoint override (optional)
  size = "1024x1024"
  quality = "auto"        # auto | low | medium | high
  # output_dir = ""       # default ~/.duya/media/generated
  # timeout_ms = 180000
  ```
  Store the key in env (`IMAGE_GENERATION_API_KEY`, or `OPENAI_API_KEY`
  for the openai provider / `FAL_KEY` for fal) — prefer env over the
  `api_key` field per the secrets rule above. The `image_generate` tool
  stays off the default tool surface (exposeMode `discoverable`): the
  agent reaches it via `tool_search`, or the user can generate directly
  with `duya image "<prompt>" [--provider …] [--model …] [--size …]` and
  inspect the effective config with `duya image:config`.

## Verify an MCP server

A config entry that parses is not proof the server works. "Configured" only
means the static fields are valid; the server may still fail to connect or
yield zero tools. After adding/editing a stdio server, verify it before
reporting success:

1. Confirm the `command` resolves on PATH for the process DUYA spawns
   (`Get-Command <cmd>` on Windows, `which <cmd>` on Unix). A PowerShell
   shim (`<cmd>.ps1`) is what a bare `command` resolves to — prefer the args
   form that enters MCP mode.
2. Spawn the server with the exact `command` + `args` and confirm it speaks
   MCP over stdio — a bare `command` that drops into an interactive CLI will
   time out on the handshake instead of listing tools.
3. Confirm the tool count is non-zero; a server that connects but exposes no
   tools is still not useful to the agent.
4. If it fails, inspect the MCP apply log / `app.log` for the connection
   error and fix the `command`+`args` (or transport/url) rather than
   assuming the config is correct.

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
