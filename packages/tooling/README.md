# `@duya/tooling`

The extension **contract plus assembly** for Duya. Three things, and nothing
else:

1. **13 narrow contributor interfaces** — one thing each, derived backwards
   from extension points that already exist in the codebase.
2. **`ExtensionRegistry` with 13 independent slots** plus a builder with one
   narrow method per slot.
3. **Assembly-time `validate()`** — duplicate identities, capability
   escalation, lifecycle hook cycles, and prompt slot conflicts are all
   rejected before a registry exists.

## What this package refuses to be

- **Not a universal registry.** There is no `register(plugin)`. There are 13
  methods, each taking exactly one typed contributor.
- **Not a feature package.** It implements nothing. Every contributor
  interface describes an extension point; the host injects the
  implementation.
- **Not a behaviour takeover mechanism.** A contributor returns data or a
  decision. It never owns a loop, a scheduler, or a dispatch order — the
  runtime keeps the loop and asks the registry at fixed points.
- **Not a catalog runtime.** The `catalogRevision` / `replaceByOwner` state in
  `packages/agent/src/tool/registry.ts` stays there. That is runtime catalog
  state, not an extension contract.

## Dependency rule

`tooling` imports **no** `capabilities`, **no** `connectors`, **no**
`memory`. It has zero runtime dependencies. If it imported a feature package
it would become "the registry where everything is registered" — precisely the
shape this package exists to avoid.

```
protocol  <-  tooling  <-  runtime
                  <-  capabilities
                  <-  connectors
                  <-  memory
```

## The 13 slots

Each contributor interface is derived from an existing extension point, and
names it in its doc comment.

| # | Slot | Contributor | Derived from |
| --- | --- | --- | --- |
| 1 | `modes` | `ModeContributor` | `modes/index.ts` `ModeModifier` |
| 2 | `tools` | `ToolContributor` | `tool/builtin.ts` |
| 3 | `promptSections` | `PromptSectionContributor` | `prompts/modules/registry.ts` |
| 4 | `hooks` | `HookContributor` | `hooks/builtin.ts` `LoopHookRegistration` |
| 5 | `context` | `ContextContributor` | `agentsmd/manager.ts` |
| 6 | `skills` | `SkillContributor` | `skills/index.ts` |
| 7 | `approvalPolicies` | `ApprovalPolicyContributor` | `permissions/policy.ts` |
| 8 | `profiles` | `ProfileContributor` | `agent-profile/` |
| 9 | `servers` | `ServerContributor` | `mcp/index.ts` + App-Connection tools |
| 10 | `memoryPolicies` | `MemoryPolicyContributor` | `memory-rollout/stage1_policy_editor.ts` |
| 11 | `decisions` | `DecisionContributor` | `decisions/` |
| 12 | `lifecycles` | `LifecycleContributor` | `lifecycle/` |
| 13 | `tokenUsage` | `TokenUsageContributor` | `observability/cache-monitor.ts` |

Slot 9 is one slot for two sources (`kind: 'mcp' | 'app-connector'`) because
the runtime already owns both buckets in one mechanism — see `ToolOwner` in
`tool/registry.ts`: `'mcp'` and `` `connector:${connectionId}` ``.

## Assembly

```ts
import {
  ExtensionRegistryBuilder,
  allCapabilities,
  assembleExtensions,
} from '@duya/tooling';

const builder = new ExtensionRegistryBuilder();
builder.modeContributor(myMode);
builder.toolContributor(myTool);

const registry = assembleExtensions(builder, allCapabilities());
```

`assembleExtensions` is the only construction path. `ExtensionRegistry`'s
constructor is private and its `create` static is `@internal` with
`stripInternal` enabled, so a consumer compiling against `dist/index.d.ts`
cannot build a registry without passing validation.

## Gates

| Gate | Check |
| --- | --- |
| T1 | no import of `capabilities` / `connectors` / `memory` |
| T2 | `validate()` exists and is invoked by the real assembly path |
| T3 | no `register(any)`-shaped method on the registry or the builder |

Tests live in `tests/` and are collected by the root `vitest.config.ts`
through its existing `packages/*/tests/**/*.test.ts` glob.
