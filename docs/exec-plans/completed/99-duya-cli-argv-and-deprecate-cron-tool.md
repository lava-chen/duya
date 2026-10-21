# Plan 99: `duya_cli` argv-style + Delete `cronTool`

> **Status**: ✅ Complete
> **Created**: 2026-06-04
> **Depends on**: Plan 96 (Phase 8 frozen) + Plan 98 (channel/cron/message added to descriptors)

## Context

After plan 98 added 3 new top-level commands (`channel`, `cron`, `message`),
the `duya_cli` agent tool was structurally broken:

1. **Hard-coded enum drift** — `DuyaCliTool.ts` had a frozen v0 Zod
   enum of 9 commands (`status`, `plugin`, `session`, `doctor`, `skill`,
   `mcp`, `provider`, `install-cli`, `uninstall-cli`). The 3 new
   commands from plan 98 were in the descriptor registry but **not**
   in the Zod schema, so the agent could not invoke them.
2. **No way to pass complex bodies** — the `cron` create command needs
   `{name, schedule, prompt, model}` JSON. The structured
   `command/subcommand/id/format/yes` shape had no slot for it.
3. **Duplicate `cronTool` capability** — `CronTool.ts` exposed the same
   6 actions (list/create/update/delete/run/runs) that plan 98 added
   to `duya_cli cron`. Two surfaces, two schemas, two prompts.

## Goal

1. **Single source of truth** — `DuyaCliTool`'s Zod schema is
   auto-derived from `descriptors.ts`. Adding a new command in the
   registry is the only edit needed.
2. **argv-style invocation** — agents pass `argv: string[]` mirroring
   the external CLI 1:1. No translation layer. No schema drift.
3. **Deprecate `cronTool`** — the agent prompt now uses
   `duya_cli { argv: ['cron', 'list'] }` instead of `cron({ action: 'list' })`.

## Implementation

### 1. `DuyaCliTool.ts` — auto-derived schema + argv parser

**Before**: Hard-coded `COMMANDS` and `SUBCOMMANDS` maps in the tool.
**After**: Derived from `CLI_DESCRIPTORS`:

```ts
const COMMANDS = CLI_DESCRIPTORS.map((d) => d.name);
const SUBCOMMANDS = Object.fromEntries(
  CLI_DESCRIPTORS.filter((d) => d.subcommands)
    .map((d) => [d.name, Object.keys(d.subcommands!)])
);
```

The Zod `inputSchema` now accepts **either** structured or argv:

```ts
const inputSchema = z.object({
  // Plan 99 — preferred
  argv: z.array(z.string()).optional(),
  // Phase 8 — preserved for backward compat
  command: z.enum(COMMANDS).optional(),
  subcommand: z.string().optional(),
  id: z.string().optional(),
  format: z.enum(['json', 'text']).optional(),
  yes: z.boolean().optional(),
}).refine((data) => data.argv !== undefined || data.command !== undefined, {
  message: 'either argv or command must be provided',
});
```

`argv` parser recognizes `--key value` and `--key=value` forms for the
flags agents commonly need: `--format`, `--yes`, `--limit`, `--offset`,
`--platform`, `--from-file`, `--cron`, `--prompt`. Unknown flags
(beyond these) are tolerated and skipped — agent can pass any CLI flag
the descriptor accepts.

### 2. `--cron <json>` option (P3)

Added inline JSON body to `duya cron create` / `update` so the agent
doesn't have to write a temp file via `--from-file`:

```ts
// cron.ts createJob / updateJob
const cronJson = (ctx.options as Record<string, unknown>)['cron'] as string | undefined;
const fromFile = typeof ctx.options.fromFile === 'string' ? ctx.options.fromFile : undefined;

if (!cronJson && !fromFile) {
  return toolError('duya cron create requires --cron <json> or --from-file <path>');
}
```

`registry.ts` `CliSubcommandOptions` got a new optional `cron?: string`
field. The descriptor declares `--cron <json>` in the cron create /
update subcommand options. `build-control-plane.ts` parses
`opts.cron` into `ctx.options.cron`.

### 3. `cronTool` deleted

Removed `packages/agent/src/tool/CronTool/` entirely (3 files).
Removed `import { cronTool }` and `registry.register(cronTool.toTool(), cronTool)`
from `builtin.ts`. The `cronTool` export was removed from
`builtin.ts` barrel.

Agent prompt updated (both `prompts/general/sections/static/intro.ts`
and `prompts/sections/intro.ts`):

- `cron` removed from the "deprecated tools" list
- `channel / cron / message` added to the "duya_cli covers these" list
- New "Invocation style (Plan 99)" section explaining argv vs
  structured, **with argv as the preferred style for new code**
- `cron create` example using `--cron '<JSON_BODY>'` (single-quoted to
  keep the JSON double-quotes inside a template string)

## Files changed

### Modified

| Path | Change |
|---|---|
| `packages/agent/src/tool/DuyaCliTool/DuyaCliTool.ts` | Schema auto-derived; argv parser added; SUBCOMMANDS map dynamic |
| `packages/agent/src/tool/DuyaCliTool/__tests__/DuyaCliTool.test.ts` | 16 → 28 tests (added argv cases + new-command enum cases) |
| `packages/agent/src/cli/commands/cron.ts` | `--cron <json>` inline body support |
| `packages/agent/src/cli/program/descriptors.ts` | `--cron <json>` option on cron create / update |
| `packages/agent/src/cli/program/build-control-plane.ts` | Parse `opts.cron` into `ctx.options.cron` |
| `packages/agent/src/cli/program/registry.ts` | `CliSubcommandOptions.cron?: string` |
| `packages/agent/src/cli/program/build-agent-runner.ts` | Pass `cronBodyJson` through to `ctx.options.cron`; CliInvocation field added |
| `packages/agent/src/tool/builtin.ts` | Remove `cronTool` import + register + export |
| `packages/agent/src/prompts/general/sections/static/intro.ts` | Add channel/cron/message to duya_cli list; add argv-style section; remove `cron` from deprecated list |
| `packages/agent/src/prompts/sections/intro.ts` | Same as above |

### Deleted

| Path | Reason |
|---|---|
| `packages/agent/src/tool/CronTool/CronTool.ts` | All 6 actions now reachable via `duya_cli` argv |
| `packages/agent/src/tool/CronTool/constants.ts` |  |
| `packages/agent/src/tool/CronTool/index.ts` |  |
| `packages/agent/src/tool/CronTool/prompt.ts` |  |

## Backwards compatibility

- **Phase 8 frozen structured style preserved** — `{ command, subcommand, id, yes, format }` still works. New code should prefer argv.
- **`--from-file` still works** for `duya cron create` — useful for humans who already have a JSON file ready.
- **argv parser is permissive** — unknown flags are skipped, not error. Agents can pass the full CLI flag surface without schema updates.

## Verification

```bash
npm run typecheck:all          # ✅ pass
npm run test -- packages/agent/src/  # 132/132 pass
```

Manual smoke (when desktop app is running):

```bash
# External CLI
node packages/agent/dist/cli/index.js cron list
node packages/agent/dist/cli/index.js cron create --from-file ./job.json --yes

# Agent (via duya_cli)
# - structured (legacy)
duya_cli { command: 'cron', subcommand: 'list' }
# - argv (preferred)
duya_cli { argv: ['cron', 'list'] }
duya_cli { argv: ['cron', 'create', '--cron', '{"name":"daily","schedule":{"kind":"cron","cronExpr":"0 7 * * *"},"prompt":"Collect morning news","model":"gpt-4o"}', '--yes'] }
duya_cli { argv: ['channel', 'list', '--platform', 'telegram'] }
duya_cli { argv: ['message', 'list', 'session-123', '--format', 'json'] }
```

## Out of scope (deferred)

- **Deprecate `duyaConfigTool` read actions** — the read actions
  were already removed in plan 96 Phase 8. The remaining write
  actions (`provider_add` / `mcp_server_add` / `settings_*` /
  `vision_*` / `style_*` / `pairing_*`) are GUI-only high-risk
  (forbidden by `roadmap.md §3.2`). Not migrating.
- **Deprecate `duya_restart`** — still useful for agent self-restart
  after config changes; the prompt already explains this.
- **Auto-derive Zod schema from descriptor `args[]` / `options[]`**
  — would let `argv` items be type-checked per-subcommand. Deferred
  until the per-subcommand flag surface grows past ~20 entries.
