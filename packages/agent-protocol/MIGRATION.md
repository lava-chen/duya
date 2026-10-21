# Migration and compatibility window — `@duya/agent-protocol/transcript`

Plan 587 T3.1. Moved 2026-10-03, on top of `origin/master` @ `9a37112c`.

This file is the record plan 587 T3.1 asks for: what moved, what it replaced,
how long the old entry points stay, what "a verifiable compatibility window"
means for a type-only migration, and what the exact command is that proves the
shim can be deleted.

---

## 1. What moved, and what it is

The pure transcript data moved from `packages/ai/src/types.ts` to
`packages/agent-protocol/src/transcript/`, reachable as
`@duya/agent-protocol/transcript`.

| Moved to `/transcript` | Was declared in | Fields |
| --- | --- | --- |
| `Message`, `AssistantMessage`, `ProviderResponseMeta` | `@duya/ai` | 31 / 11 / 2 |
| `TextContent`, `ImageContent`, `ToolUseContent`, `ToolResultContent`, `ThinkingContent`, `ProviderBlockContent`, `MessageContent` | `@duya/ai` | 5 / 2 / 8 / 4 / 5 / 4 |
| `TokenUsage`, `UsageCall`, `StopReason` | `@duya/ai` | 8 / 9 / 9 members |
| `ToolUse`, `ToolResultMetadata`, `ToolGroupProgressSource`, `ToolResultImage` | `@duya/ai` | 6 / 8 / 3 members |
| `ToolResultWire` (the JSON half of `ToolResult`) | `@duya/ai` | 9 |
| `ConnectorToolParamsDisplayEntry`, `PermissionRequestEvent`, `AgentProgressEvent`, `HookEventPayload` | `@duya/ai` | 3 / 7 / 12 / 15 |
| `ApiFormat`, `MessageRole`, `MessageContentType` | `@duya/ai` | 7 / 4 / 6 members |

### What deliberately did NOT move

| Stayed | Where | Why |
| --- | --- | --- |
| `ToolResult` (the two `Promise` fields) | `@duya/ai`, as `RuntimeToolResult` | A `Promise` has no JSON form. Contract §A forbids Promise on the wire. |
| `SSEEvent` | `@duya/ai` | Its `tool_result` member carries `data: ToolResult`, i.e. the Promise-bearing type. Moving the union means either dropping two fields or rebuilding the frame — the first is the forbidden field loss, the second is a behaviour change. |
| `ToolResultMetadata` (the second copy) | `packages/agent/src/tool/types.ts` | Divergent copy; see §5. |
| The event vocabulary's own `TokenUsage`, `UsageCall`, `StopReason`, `MessageContent`, `ToolResult` | `@duya/agent-protocol` main entry | Different shapes on purpose. See §4. |

---

## 2. The deprecated entry points and their removal tasks

| Entry point | Status | Removal task | Gate before removal |
| --- | --- | --- | --- |
| `@duya/ai` — `Message`, `MessageContent` and the content blocks, `TokenUsage`, `UsageCall`, `StopReason`, `ToolUse`, `ToolResultMetadata`, `PermissionRequestEvent`, `AgentProgressEvent`, `AssistantMessage`, `ProviderResponseMeta`, `ApiFormat`, `MessageRole`, `MESSAGE_CONTENT_TYPES` | `@deprecated` re-export | `587-T3-1-REMOVE-TRANSCRIPT` | §3 |
| `@duya/ai` — `ToolResult` | `@deprecated` alias of `RuntimeToolResult` | `587-T3-1-RENAME-TOOLRESULT` | §3 |
| `@duya/ai` — `toToolResultWire`, `serializeToolResult`, `hasDeferredRuntimeState` | new, not deprecated | `587-T3-1-WIRE-SERIALIZER` (wiring it into the emitter) | n/a |
| `@duya/agent` — the same re-export block in `src/types.ts` | `@deprecated` re-export | `587-T3-1-REMOVE-TRANSCRIPT` | §3 |
| `@duya/ai` — `SSEEvent` | **not deprecated** | `587-T3-1-MOVE-SSE-UNION` | deferred to the router cutover PR |
| `packages/agent/src/tool/types.ts` — `ToolResultMetadata` | **not deprecated** | `587-T3-1-MERGE-METADATA` | deferred |
| `apps/desktop/src/renderer/types/stream.ts` — `PermissionRequestEvent` | **not deprecated** | `587-T3-1-MERGE-PERMISSION-EVENT` | deferred |

The last three are NOT deprecated in this change, deliberately: deprecating a
type without a path to remove it is how a shim becomes permanent.

---

## 3. What "a verifiable compatibility window" means here

Plan 587 §G requires "at least one verifiable compatibility release window"
and says explicitly: "不能只依赖'类型检查过了'" — typecheck alone is not the window.

**My honest answer is that a full window cannot be established in this PR**, and
here is why. A compatibility window is a claim about consumers. `@duya/ai` and
`@duya/agent` are `"private": true` — they are not published to a registry, so
there is no external consumer population to observe, and no release cadence
whose artefacts a consumer could be pinned against. There is no meaningful
"one release later" to point at. Claiming a window here would be inventing a
guarantee the packaging does not support.

What can be established in one PR is weaker but real, and this is the smallest
thing that can:

**(a) Structural identity, enforced at build time.** The shim is a
re-export, not a copy, so there is exactly one definition. Proven by
`packages/ai/test/tool-result-wire.test.ts` asserting
`@duya/ai`'s `MESSAGE_CONTENT_TYPES` is element-wise identical to the
protocol's, and that a protocol-typed value is assignable to each `@duya/ai`
name. A copy would drift; a re-export cannot, and the test fails if it is ever
replaced by one.

**(b) Resolution through the published `exports` map.** Proven by
`packages/agent-protocol/test/24-transcript-exports-resolution.test.ts`, which
resolves `@duya/agent-protocol/transcript` with a real Node resolver in a child
process (no vite alias in scope), asserts it lands on `dist/transcript/index.js`
rather than `src/`, and then compiles a scratch consumer that imports every
moved type by bare package specifier with `moduleResolution: NodeNext`. Without
this, a type can typecheck through a path the package does not expose.

**(c) A dated, enumerated consumer census.** The set of importers is knowable
in-repo; it is in §6. The window's actual precondition is that this list goes
empty, and the command below makes that check mechanical.

**(d) The command that closes the window.** When the deprecation is removed,
this must exit 0 on the day of removal:

```bash
# Must print nothing. Any hit is a consumer that has not migrated.
grep -rn --include=*.ts --include=*.tsx \
  -e "from '@duya/ai'" -e "from '@duya/ai/types.js'" \
  packages apps e2e | grep -v node_modules
```

A clean run on a full release boundary — not the same day the shim was added —
is the smallest defensible window. **Until that run is recorded on a release,
`587-T3-1-REMOVE-TRANSCRIPT` must not be actioned.**

---

## 4. Why the two `TokenUsage` / `StopReason` families were not merged

`@duya/agent-protocol` already owned a `TokenUsage`, `UsageCall`, `StopReason`,
`MessageContent` and `ToolResult` before this change. Merging the incoming ones
with them would have been the tidy-looking move and would have destroyed
fields. Measured differences:

| | protocol (event vocabulary) | moved (`/transcript`) |
| --- | --- | --- |
| token fields | `inputTokens`, `cacheReadTokens`, … (camelCase) | `input_tokens`, `cache_hit_tokens`, … (snake_case, as stored) |
| `StopReason` | 6 members | 9 members |
| `MessageContent` | 4 members | 6 members |
| `ToolResult` failure bit | `outcome: ToolCallOutcome`, required | `error?: boolean` |
| `TextContent.phase` | `string` | `'commentary' \| 'final_answer'` |
| `ThinkingContent.encrypted` | `boolean` | `string` |

Four `StopReason` members (`max_turns`, `max_tokens`, `tool_use`,
`repeated_tool_calls`) and two `MessageContent` members (`ImageContent`,
`ProviderBlockContent`) exist in only one of the two. A narrower union is the
exact failure T3.1 forbids. Both are kept, each in its own module, named by
the surface it belongs to.

---

## 5. Divergences recorded, not fixed

Plan 587 requires an unproven capability be reported as unsupported rather than
claimed. Three real divergences were found while building the inventory. All
three are behaviour-affecting, so none is fixed in this types-only PR; each has
a named removal task.

1. **`ToolResultMetadata` exists twice, differently.**
   `packages/agent/src/tool/types.ts:183` lacks `matchCount`, `truncated` and
   `engine`, which `@duya/ai`'s copy has. Recorded in
   `TOOL_RESULT_METADATA_DIVERGENCE`. → `587-T3-1-MERGE-METADATA`.

2. **`WorkerEvent` is already an incomplete union.**
   `packages/agent/src/process/worker-protocol.ts` declares **27** members in
   `WorkerEvent` and exports **33** `*Event` interfaces. Six are absent from
   the union, so a consumer narrowing on `WorkerEvent` cannot narrow on them:

   - `ResearchUpdatedEvent`
   - `WorkflowRunEvent`
   - `ClipboardWriteEvent`
   - `CompactOverThresholdEvent`
   - `CompactStepEvent`
   - `CompactSummaryOutcomeEvent`

   Three of those have `build*Event` factories in the same file
   (`buildResearchUpdatedEvent`, `buildWorkflowRunEvent`,
   `buildClipboardWriteEvent`), so they are produced, not merely declared.
   This is exactly the research / workflow / compaction extension coverage
   T3.1 asks the event map to have, and it is missing on master — reproduced
   here, **not fixed**, because completing it is the router cutover's job and
   would change behaviour. → part of `587-T3-1-MOVE-SSE-UNION`.

   Reproduce (member count vs. exported-interface count):
   ```bash
   node -e "const s=require('fs').readFileSync('packages/agent/src/process/worker-protocol.ts','utf8');
   const l=s.split(/\r?\n/);const i=l.findIndex(x=>x.startsWith('export type WorkerEvent'));
   const m=[];for(let j=i+1;j<l.length;j++){const r=l[j].match(/^\s*\|\s*([A-Za-z0-9_]+)/);if(!r)break;m.push(r[1]);}
   const e=[...s.matchAll(/^export interface ([A-Za-z0-9_]+Event)\b/gm)].map(x=>x[1]);
   console.log(m.length, e.filter(x=>!m.includes(x)));"
   # -> 27 [ 'ClipboardWriteEvent', 'WorkflowRunEvent', 'ResearchUpdatedEvent',
   #          'CompactOverThresholdEvent', 'CompactStepEvent', 'CompactSummaryOutcomeEvent' ]
   ```

3. **The Desktop `PermissionRequestEvent` is a strict superset.**
   `apps/desktop/src/renderer/types/stream.ts` adds `connector` and
   `suggestions` on top of the `@duya/ai` shape. Repointing the renderer at the
   moved type would compile and silently drop "Always allow" for
   app-connection tools. → `587-T3-1-MERGE-PERMISSION-EVENT`.

---

## 6. Consumer census

Measured on `587/t3-1-wire-single-source` with
`grep -rln --include='*.ts' --include='*.tsx' "from '@duya/ai'" packages apps e2e`,
excluding `node_modules` and `dist`.

| Package | Files importing `@duya/ai` |
| --- | --- |
| `packages/agent` | 54 |
| `apps/desktop` | 29 |
| `packages/computer-use` | 4 |
| **total distinct files** | **87** |

`packages/cli`, `packages/conductor`, `packages/gateway`, `packages/voice` and
`packages/agent-core` import **none** of them.

**None of the 87 were modified.** That is the point of the shim: the migration
of consumers is the NEXT PR, and mixing it with this move would violate the
"types move, behaviour does not" split.

Reproduce with:

```bash
grep -rln --include='*.ts' --include='*.tsx' "from '@duya/ai'" packages apps e2e \
  | grep -v node_modules | wc -l    # -> 87
```

---

## 7. Status summary (contract §H vocabulary)

| | |
| --- | --- |
| **Moved** | yes — 18 types + 3 constant tuples into `@duya/agent-protocol/transcript` |
| **Typechecked** | yes — `npm run typecheck:all` |
| **Tested** | yes — drift tests #23 and #24, `packages/ai/test/tool-result-wire.test.ts` |
| **Merged** | no — local commit only, not pushed |
| **RuntimeVerified** | **no.** No tool was executed, no provider called, no worker spawned, no packaged Electron run. The serializer is proven by unit tests against constructed values only. |

The last row is the one that matters for honesty: everything here is a
type-level and pure-projection result. `toToolResultWire` is not wired into any
emitter yet (`587-T3-1-WIRE-SERIALIZER`), so no runtime path exercises it.

---

## 8. One thing a type-only test in this package cannot do

Worth writing down, because it was found the hard way while building this and
it changes what "tested" means here.

**`packages/agent-protocol/test/**` is never typechecked.** The package
tsconfig sets `"exclude": [..., "test"]`, and the root `tsconfig.json` includes
only the desktop renderer and conductor. Vitest runs protocol tests through
esbuild, which strips types without checking them.

The consequence is specific and was measured: deleting `ImageContent` from the
`MessageContent` union — exactly the field loss T3.1 forbids — left
`test/23-wire-field-classification.test.ts` at **20 passed, 0 failed**. A
union-completeness assertion written in a protocol test is decorative.

So the guarantee that no variant is dropped for a tidier union now lives in
compiled source instead:

- `MESSAGE_CONTENT_UNION_IS_COMPLETE` in `src/transcript/content.ts`
- `STOP_REASON_IS_COMPLETE` in the same file

Both compare the union against a value constant with an exact-type check in
both directions. With `ImageContent` removed,
`npm run typecheck:protocol` now fails with
`TS2322: Type 'true' is not assignable to type 'false'` and **exit 2**.

The division of labour is now: compiled source proves *union == constant*, and
test #23 proves *the constant is the six and nine members the code expects*.
Adding a protocol test to a typecheck path is a separate, worthwhile change
(`587-T3-1-TYPECHECK-TESTS`); it is not done here because turning on type
checking for a test directory that predates this change would surface
unrelated errors across all 20 existing protocol test files.

---

## 9. Suite measurements

Both runs taken in THIS worktree, back to back, so the comparison is like for
like (`npm test`, whole repo).

| | master (stashed, 1025 collected) | this branch (1028 collected) |
| --- | --- | --- |
| Test files collected | 1025 | **1028** (+3: the two protocol drift tests and the `ai` serializer test) |
| Files failed | 43 | 44 |
| Tests failed | 97 | 99 |
| Tests passed | 11881 | 11916 (+35) |

**Collection did not drop.** The +3 is exactly the files this change adds.

One file fails here that does not fail on master:
`packages/agent/tests/integration/RealTasks.test.ts`. It is **not** a
regression — it is a pre-existing ordering flake that only appears under
full-suite load. The assertion is:

```
expect(results[0]).toContain('Content A')
```

on two reads dispatched to a `StreamingToolExecutor`; under load the second
file completed first and `results[0]` held `Content B`. Run in isolation it
passes 3/3 (13 tests each time), and this change is types-only with no runtime
behaviour difference. Reproduce the flake by re-running the full suite.

The 43 files failing on both are unchanged from master, including
`packages/agent-protocol/test/13-citation-drift.test.ts` (4 `router.ts`
citations, verified byte-identical on master by stashing and re-running).
