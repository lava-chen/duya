---
name: self-config
description: "DUYA self-configuration. Use when the user asks to configure DUYA itself — edit ~/.duya/config.toml, add or change a model provider, set API secrets, configure MCP servers, channels, cron jobs, memory, voice, or agent behavior. Also trigger when DUYA misbehaves and the fix is a config change, or when the user says '配置 duya', '改一下设置', '加个模型', '配一下 MCP', '调一下参数'. Do not use for configuring the user's own project; that is ordinary file work."
when-to-use: "Whenever the task reads or writes DUYA's own runtime configuration (~/.duya), not user project config."
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash]
---

# DUYA Self-Configuration

Guide for reading and safely editing DUYA's own configuration. All user data
lives under the config root `~/.duya/` (on Windows: `C:\Users\<you>\.duya\`;
on macOS: `~/Library/Application Support/duya`; on Linux: `~/.config/duya`).
Start any config task by locating the real root for this machine.

## Configuration files

| File | Format | Purpose | Security |
|---|---|---|---|
| `config.toml` | TOML | Single source of truth: storage, model, providers, agent, memory, channels, gateway, mcp_servers, plugins, skills, voice | Plaintext, never secrets |
| `secrets.json` | JSON | API keys / tokens / credentials | 0600, never log |
| `settings.json` / `settings.local.json` | JSON | UI + runtime key/value settings (`skillEnabledOverrides`, `security_bypass_skills`, skill paths) | Plaintext, low sensitivity |
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
- `[voice]` / `[stt]` — voice input; `stt.engine` is `local` (whisper.cpp) or `cloud` (OpenAI-compatible `/v1/audio/transcriptions`)
- `[channels]` — channel adapters (e.g. `telegram`); bot tokens live in `secrets.json`
- `[mcp_servers]` / `mcp_servers` — MCP server entries: `transport` (`stdio` | `streamable-http`), `command`, `args`, `env`, `url`, `headers`, `enabled`, `allowedAgentIds`
- `[plugins]` — per-plugin toggles (`enabled`, `trustLevel`, `scope`, `marketplace`)
- `skills = [...]` — `[[skills.config]]` entries `{ name, enabled }` (skill enable/disable overrides, decision 15)
- `[security]` — `redact_secrets`, `secrets_encrypted`
- Reserved / not-yet-wired: `[projects]`, `[features]`, `[apps]`

## Editing rules

1. **Never put secrets in `config.toml`.** Add them to `secrets.json` under a
   stable key, then reference the provider id in `config.toml`. Never print a
   secret value back to the user or to logs.
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

- **Add a model provider**: create `[providers.<id>]` in `config.toml`, set
  `[model] default/provider/base_url`, and store the key in `secrets.json`.
- **Add an MCP server**: add an entry to `mcp_servers` (stdio: `command`+`args`;
  remote: `url`+`headers`). Enable it, scope with `allowedAgentIds` if desired.
- **Enable/disable a skill**: add `{ name = "<skill>", enabled = false }` to the
  `skills` array (or remove it to re-enable).
- **Schedule a cron job**: edit `~/.duya/cronjob.toml`.
- **Change voice input**: set `[voice] stt.engine` and device/model fields.

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
