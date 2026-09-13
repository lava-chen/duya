# Plan 526 — Shared agent channel root (`~/.duya/agents`)

## Problem

Per-bot channel data (bindings, connector secrets, weixin gateway state,
inbound attachments) lives under Electron `<userData>/agents/`, which is
namespaced per install mode (`duya-dev` in dev, plain `duya` packaged).
Bots registered in the shared `~/.duya/config.toml` therefore show up in
both installs, but channel bindings configured in dev never exist in the
packaged app — the connector runtime starts zero connectors and every
channel shows disconnected.

`~/.duya/agents/<agentId>/` is already the bot identity home
(profile.json, settings.json, avatar, sessions, memory, skills) via
`electron/config/agent-paths.ts`. The worker side
(`packages/agent/src/prompts/bot/loader.ts:239`) already reads channel
`connection.json` from `~/.duya/agents/...` — a latent inconsistency with
the main-process write root that this plan also fixes.

## Change

Move the five channels-subsystem path resolvers from
`app.getPath('userData')/agents` to
`getDuyaAgentsRoot(getConfigStore().getConfigDir())` (=
`~/.duya/agents`), keeping each module's existing id validation:

1. `electron/channels/channel-store.ts` — `resolveAgentsDir()`
2. `electron/channels/connector-secret-store.ts` — `resolveAgentSecretsDir()`
3. `electron/channels/connector-runtime.ts` — `listAgentIds()` (skip dot dirs)
4. `electron/channels/attachment-store.ts` — `inboundAttachmentDir()`
5. `electron/channels/weixin-connector.ts` — `resolveAgentStateDir()`

Boot migration (`electron/channels/legacy-root-migration.ts`, wired in
`electron/main.ts` before connector-runtime start): merge
`channels/`, `connector-secrets/`, `gateway/`, `attachments/` from legacy
`<userData>/agents/*` into the shared root, per-file, target-exists
wins (idempotent, never clobbers newer shared data, source kept).

## Out of scope

- SQLite (duya-core.db pending wakes, memory-state.db) stays per-userData.
- `~/.duya/cronjob.toml` (routines) already shared.

## Progress

- [x] Path resolvers switched to shared root
- [x] `connector-runtime.listAgentIds()` skips dot dirs
- [x] Boot migration module + `main.ts` wiring
- [x] Tests updated to `_setConfigStoreForTest` injection
- [x] vitest channels/ipc suites green (45 passed)
- [x] Electron tsc: zero new errors vs stash baseline (863 pre-existing parallel-WIP)
- [x] ARCHITECTURE.md storage section updated
- [x] Data migrated: 7 files from `duya-dev/agents` merged into `~/.duya/agents` (bots dd287a/deba74 bindings + secrets + weixin gateway state); boot migration is now a no-op
