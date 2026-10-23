# @duya/capabilities

Capability implementations for Duya. **Slice 1 (plan 610 A8): the filesystem capability.**

## What lives here

| Module | Moved from |
| --- | --- |
| `src/contracts/` | `packages/agent/src/tool/types.ts` + `dependencies.ts` (pure tool contract; `ToolUseContext` narrowed to the structural field set tools read) |
| `src/BaseTool.ts` | `packages/agent/src/tool/BaseTool.ts` |
| `src/{ReadTool,WriteTool,EditTool,GlobTool,GrepTool,ApplyPatchTool}/` | `packages/agent/src/tool/<Tool>/` |
| `src/file-{read-state,mutation-queue,snapshot,snapshot-store}.ts` | `packages/agent/src/tool/` (session-level FS state) |
| `src/permissions/` | `packages/agent/src/permissions/{types,policy}.ts` |
| `src/utils/{path,multimodal-detection,notebook}.ts`, `src/utils/bash/` | `packages/agent/src/utils/` |
| `src/utils/{shellDetector,shell/providers}.ts` | `packages/agent/src/utils/` |
| `src/fs-contributors.ts` | new — `ToolContributor` projection into `@duya/tooling`'s `tools` slot |

## Boundary discipline

- **No lifecycle knowledge.** No Goal / Task / Session types (gate G23). The
  caller context (`contracts/tool.ts` `ToolUseContext`) is a narrow structural
  type; the agent's wide `ToolUseContext` is assignable to it without casts.
- **No imports from `@duya/agent`.** The edge only points agent → capabilities.
- **`@duya/tooling` is declaration-only.** `createFileSystemToolContributors()`
  projects each tool into the `tools` slot; the executor stays with the host.

## Agent compatibility

`packages/agent/src/{tool,permissions,utils}` keep byte-compatible shims at
every moved path (`export * from '@duya/capabilities/...'`), so no agent-side
or desktop-side import path changed. The shim layer is retired when plan 610
A7's retirement gates (G26–G29) flip consumers to import
`@duya/capabilities` directly.

## Still in the agent (later slices)

The Bash/PowerShell command executor and background-task lifecycle (+ `BashWorker.ts` second bundle entry, gate G22),
CanvasConductor, remaining OSTool context capabilities, skills, mcp,
ModuleTool, ImageGenerateTool / VisionTool — see
`docs/exec-plans/active/610-architecture-series/01-layered-architecture/06-six-new-packages.md`.
