# Plan 98: CLI Channel / Cron / Message + Command-Registration Refactor

> **Status**: In Progress (Phase A — refactor foundation)
> **Created**: 2026-06-04
> **Updated**: 2026-06-04
> **Depends on**: Phase 0–8 (all complete)
> **Reference doc**: [`docs/design-docs/cli-control-plane/2026-06-04-comparison-vs-openclaw.md`](../../design-docs/cli-control-plane/2026-06-04-comparison-vs-openclaw.md)
> **Binding design contract**: [`docs/design-docs/cli-control-plane/roadmap.md`](../../design-docs/cli-control-plane/roadmap.md)

## Goal

1. Expose three duya-internal domains that the CLI control plane
   does not yet cover: **`message`**, **`cron`**, **`channel`**.
2. Replace the 1191-line `packages/agent/src/cli/index.ts` (inline
   `.command(...).action(...)` blocks) with a **descriptor + shared
   registry** pattern.
3. Eliminate the hand-rolled `switch` chain in
   `packages/agent/src/tool/DuyaCliTool/runner.ts:116-247` so the
   Phase 8 agent tool and the CLI bundle resolve the **same** handler
   from one registry.

## Scope

| Phase | Scope | Status |
|-------|-------|--------|
| A | Refactor foundation (descriptor + shared registry) | 🟡 In progress |
| B | `duya channel` (read-only) | ⏳ |
| C | `duya cron` (full Phase 7 write surface) | ⏳ |
| D | `duya message` (read-only) | ⏳ |
| E | `registry.test.ts` + agent tool bridge | ⏳ |
| F | Doc close-out + `npm run typecheck:all` | ⏳ |

---

## New commands (binding DTOs frozen v1.0.0)

### `duya channel`

| Subcommand | HTTP | Notes |
|---|---|---|
| `list [--platform <p>]` | `GET /v1/channels` | List discovered channels |
| `info <id>` | `GET /v1/channels/:id` | Single channel + binding |
| `platforms` | `GET /v1/platforms` | Configured platforms (telegram / qq / feishu) |
| `status [--platform <p>]` | `GET /v1/platforms/:p/status` | `ChannelStatus` snapshot |

**DTOs (frozen)**:
- `ChannelListItem`: `id / platform / name / guild? / type / bound: bool`
- `ChannelInfoItem`: `+ duyaSessionId? / sdkSessionId? / workingDirectory? / model?`
- `PlatformItem`: `platform / enabled / connected / totalMessages / lastConnectedAt? / lastError?`
- `PlatformStatusItem`: same + `streaming / toolProgress / showReasoning`

**No write ops.** Channel management is the gateway's responsibility.

### `duya cron`

| Subcommand | HTTP | R/W | Notes |
|---|---|---|---|
| `list` | `GET /v1/crons` | R | All crons |
| `info <id>` | `GET /v1/crons/:id` | R | Single cron + recent runs |
| `create` | `POST /v1/crons` | W | `--yes` for non-interactive |
| `update <id>` | `PATCH /v1/crons/:id` | W | `--yes` |
| `delete <id>` | `DELETE /v1/crons/:id` | W | `--yes` |
| `run <id>` | `POST /v1/crons/:id/run` | W | Manual trigger |
| `runs <id>` | `GET /v1/crons/:id/runs` | R | Run history (paginated) |

**DTOs (frozen)**:
- `CronListItem`: `id / name / description / status / scheduleKind / scheduleExpr / nextRunAt? / lastRunAt? / lastError?`
- `CronInfoItem`: `+ scheduleAt? / scheduleEveryMs? / scheduleCronExpr? / scheduleCronTz? / workflowId / prompt / model / concurrencyPolicy / maxRetries`
- `CronRunItem`: `id / cronId / runStatus / startedAt? / endedAt? / output? / errorMessage? / sessionId?`
- `CreateCronInput`: same as `electron/automation/types.ts` `CreateAutomationCronInput` minus `id`

**Write ops** follow `roadmap.md §3.2` (Phase 7):
- `--yes` required in non-interactive mode
- Interactive confirm in TTY mode
- `X-Correlation-Id` header
- Audit log at `<userData>/control-plane-audit.log.jsonl`

### `duya message`

| Subcommand | HTTP | Notes |
|---|---|---|
| `list <sessionId>` | `GET /v1/sessions/:id/messages` | All messages in session (paginated) |
| `show <sessionId> <msgId>` | `GET /v1/sessions/:id/messages/:msgId` | Single message |
| `count <sessionId>` | `GET /v1/sessions/:id/messages/count` | Replaces `messageCount` in session show |

**DTOs (frozen, no internal columns leaked)**:
- `MessageListItem`: `id / role / content / name? / msgType / createdAt / tokenUsage? / durationMs? / toolName?`
- `MessageInfoItem`: `+ toolCallId? / toolInput? / thinking? / attachments?`
  - Excludes: `viz_spec`, `sub_agent_id`, `seq_index`, `status`

**No write ops.** Message create/update is the agent's streaming job.

---

## Command registration refactor

### Target shape

```
packages/agent/src/cli/
├── index.ts                        # 100 lines: buildProgram() + parse()
├── program/                        # NEW
│   ├── registry.ts                 # CliCommandDescriptor types
│   ├── descriptors.ts              # All descriptors (data only)
│   ├── build-program.ts            # Commander wiring
│   ├── build-agent-runner.ts       # Phase 8 tool bridge
│   └── context.ts                  # OutputFormat, locale
└── commands/                       # Unchanged shape
    ├── status.ts / plugin.ts / session.ts / skill.ts / mcp.ts /
    ├── provider.ts / doctor.ts / install.ts /
    ├── channel.ts (NEW) / cron.ts (NEW) / message.ts (NEW)
```

### Shared types

`packages/agent/src/cli/program/registry.ts`:

```typescript
export type CliCommandPath =
  | 'status' | 'doctor'
  | 'plugin' | 'session' | 'skill' | 'mcp' | 'provider'
  | 'channel' | 'cron' | 'message'
  | 'install-cli' | 'uninstall-cli' | 'config' | 'setup';

export interface CliCommandDescriptor {
  name: string;
  description: string;
  subcommands?: Record<string, CliSubcommand>;
  write?: boolean;
}

export interface CliSubcommand {
  description: string;
  args?: { name: string; required: boolean; description: string }[];
  options?: { flags: string; description: string }[];
  run: (
    args: string[],
    options: Record<string, string | boolean>
  ) => Promise<number>;
}
```

### Backwards compatibility

- Every existing `run*` function in `commands/*.ts` keeps its signature.
- `index.ts` shrinks from 1191 → ~100 lines.
- `DuyaCliTool/runner.ts:116-247` switch replaced with
  `buildAgentRunner().resolve(inv)`.
- All frozen DTOs and exit codes unchanged.

### Why this shape (vs openclaw's full `program/` machinery)

- duya has **10 existing commands**; descriptor pays for itself after
  adding cron (7 subcommands) + 3 new top-level commands (~20 total).
- Lazy loading is out of scope: keep startup fast; revisit when
  command count > 30.
- Plugin CLI dynamic registration is out of scope: duya plugins don't
  currently expose CLI surface.

---

## Files to change

### New files

| Path | Purpose |
|---|---|
| `packages/agent/src/cli/program/registry.ts` | Descriptor types + frozen paths |
| `packages/agent/src/cli/program/descriptors.ts` | All command descriptors |
| `packages/agent/src/cli/program/build-program.ts` | Commander wiring |
| `packages/agent/src/cli/program/build-agent-runner.ts` | Phase 8 tool bridge |
| `packages/agent/src/cli/program/context.ts` | OutputFormat, locale |
| `packages/agent/src/cli/commands/channel.ts` | channel command (read-only) |
| `packages/agent/src/cli/commands/cron.ts` | cron command (full surface) |
| `packages/agent/src/cli/commands/message.ts` | message command (read-only) |
| `electron/cli/handlers/channels.ts` | HTTP `/v1/channels*` + `/v1/platforms*` |
| `electron/cli/handlers/crons.ts` | HTTP `/v1/crons*` |
| `electron/cli/handlers/messages.ts` | HTTP `/v1/sessions/:id/messages*` |
| `tests/cli-control-plane/channel.test.ts` | Integration tests |
| `tests/cli-control-plane/cron.test.ts` | Integration tests (incl. write ops) |
| `tests/cli-control-plane/message.test.ts` | Integration tests |
| `tests/cli-control-plane/registry.test.ts` | Registry unit tests |

### Modified files

| Path | Change |
|---|---|
| `packages/agent/src/cli/index.ts` | 1191 → ~100 lines |
| `packages/agent/src/tool/DuyaCliTool/runner.ts:116-247` | Replace `switch` with shared resolver |
| `electron/cli/cli-api-server.ts` | Register 3 new handler modules |
| `electron/db/queries/messages.ts` | Add `getMessageById()` + paginated `listMessagesBySession()` |
| `electron/automation/Scheduler.ts` | Re-export existing functions (no logic change) |
| `docs/design-docs/cli-control-plane/roadmap.md` | Add Phase 9/10/11 to §6; freeze new DTOs in §3.4 |
| `docs/exec-plans/active/96-duya-cli-tool.md` | Reference plan 98 |

### Out of scope

- `duya channel enable/disable` (gateway-managed; no user need yet)
- `duya cron create --from-template` (NL templates, separate plan)
- `duya message search` (semantic search needs embeddings)
- Lazy command loading (defer until command count > 30)
- Plugin CLI dynamic registration (defer until needed)

---

## Implementation phases

### Phase A — Refactor foundation (no behavior change) 🟡

1. Add `program/registry.ts`, `program/context.ts`,
   `program/descriptors.ts`, `program/build-program.ts`,
   `program/build-agent-runner.ts`.
2. Move all 10 existing command registrations to descriptors.
3. Replace `runner.ts` switch with `buildAgentRunner()`.
4. **Verify**: `npm run typecheck:all` + all 7 existing
   `tests/cli-control-plane/*.test.ts` PASS unchanged.

### Phase B — `duya channel`

5. `electron/cli/handlers/channels.ts` with `GET /v1/channels`,
   `GET /v1/channels/:id`, `GET /v1/platforms`,
   `GET /v1/platforms/:p/status`.
6. `packages/agent/src/cli/commands/channel.ts` with
   `list / info / platforms / status`.
7. Register in `descriptors.ts`. Add DTO freeze to
   [`roadmap.md §3.4`](../../design-docs/cli-control-plane/roadmap.md).
8. `tests/cli-control-plane/channel.test.ts`.

### Phase C — `duya cron` (full Phase 7)

9. `electron/cli/handlers/crons.ts` with full REST surface.
10. `packages/agent/src/cli/commands/cron.ts` with 7 subcommands.
11. Register in `descriptors.ts`. Freeze cron DTOs in roadmap.
12. `tests/cli-control-plane/cron.test.ts` (read + write + audit).

### Phase D — `duya message` (read-only)

13. Paginated `listMessagesBySession()` + `getMessageById()` in
    `electron/db/queries/messages.ts`.
14. `electron/cli/handlers/messages.ts`.
15. `packages/agent/src/cli/commands/message.ts` with
    `list / show / count`.
16. Register. Freeze DTOs (redact `viz_spec` / `sub_agent_id`).
17. `tests/cli-control-plane/message.test.ts`.

### Phase E — Registry tests

18. `tests/cli-control-plane/registry.test.ts`.

### Phase F — Close-out

19. Update `roadmap.md` §3.4 + §6.
20. Update [`96-duya-cli-tool.md`](./96-duya-cli-tool.md).
21. `npm run typecheck:all` + all tests PASS.
22. Move plan 98 to `completed/`.

---

## Critical files (must read before implementing)

- `packages/agent/src/cli/api/client.ts:47-88` — `CliApiClient.connect()`
- `packages/agent/src/cli/api/errors.ts:17-33` — `CliApiError` taxonomy
- `packages/agent/src/cli/commands/skill.ts:137-179` — Phase 7 write op
- `electron/cli/cli-api-server.ts:60-176` — route table + `checkBearer()`
- `electron/automation/Scheduler.ts:50-72` — cron facade
- `electron/gateway/channel-directory.ts:1-110` — channel shapes
- `electron/db/queries/messages.ts:117-121` — message SQL
- [`roadmap.md`](../../design-docs/cli-control-plane/roadmap.md) — binding decisions

## Verification

```bash
npm run typecheck:all
npm run test -- tests/cli-control-plane/
npm run test -- DuyaCliTool.test.ts

# Manual smoke (desktop app must be running)
node packages/agent/dist/cli/index.js --help
node packages/agent/dist/cli/index.js channel list
node packages/agent/dist/cli/index.js cron list
node packages/agent/dist/cli/index.js message list <sessionId> --format json
node packages/agent/dist/cli/index.js cron create --prompt "test" --yes
```
