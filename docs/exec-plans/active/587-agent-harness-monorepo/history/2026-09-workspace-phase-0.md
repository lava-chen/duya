> Historical / superseded for execution. 原位置：`docs/exec-plans/backlog/2026-09-workspace-phase-0.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# Duya Workspace — Phase 0: Domain and Creation Contract

> Status: Planning  
> Priority: P0  
> Scope: Architecture and product contract only; no runtime implementation in this phase.

## Summary

Define the Workspace foundation before implementation: restore `Project` to one logical root, move multi-folder authorization and execution settings into a device-local `Workspace`, and specify the settings and defaults users encounter when creating one.

Phase 0 produces an implementable contract for Workspace Core, Context Resolver, and Trust / Permission. It does not add database tables, IPC, tools, UI, an indexer, or a sandbox.

## Current Duya Baseline

- `Project` has a UUID, `canonical_root`, and `paths[]`; each path entry can carry a description. Project path resolution is based on normalized local paths. See `electron/db/core/project-store.ts`, `electron/db/core/projectService.ts`, and `electron/memory-state/pathUtils.ts`.
- Project-private plans and `AGENTS.md` are stored under Duya's per-project data directory. Their ownership must be evaluated separately from the `paths[]` feature; do not discard project identity or project-scoped data as part of simplifying roots.
- Chat sessions persist `working_directory`; there is no `workspace_id` binding today. Chat, Workflow, sidebar Terminal, and CLI have distinct cwd entry points.
- File-tool checks run in the Agent runtime. They are not a Main-owned filesystem broker, and shell execution has no OS sandbox.
- Existing `allowedRoots` checks and approval policy are reusable, but Phase 0 must document which call sites actually enforce them and which do not.

## Goals

1. Specify `Project → Workspace → Root → Session → Run` ownership and lifecycle.
2. Decide the single-root Project contract and inventory every multi-path consumer before any field or API is removed.
3. Specify Workspace creation settings, derived values, defaults, and advanced settings.
4. Define the V1 Trust / Permission matrix using only guarantees Duya can enforce.
5. Define Main Process authority, Agent / Workflow manifest propagation, and the file-operation boundary.
6. Produce migration rules for current Project paths, Session working directories, and project-scoped data.
7. Close dependencies and sequencing with current Project DB, permission, and context-loading plans.

## Non-goals

- No code, schema migration, IPC, UI, or tool changes.
- No persistent Workspace index, embeddings, generic ChangeJournal, or rollback engine.
- No remote/cloud Workspace backend.
- No claim that Trust or Workspace roots sandbox shell, MCP, plugins, or arbitrary child processes.

## Domain Decisions to Close

### Project returns to a single root

Working direction: a Project has one canonical root path. Multiple local folders belong to `WorkspaceRoot[]`, not to `Project`.

Phase 0 must inventory and classify:

- `projects.paths[]`, per-path descriptions, and APIs that consume them;
- `canonical_root` and whether it remains the canonical field or is replaced by a single-root `root_path`;
- path aliases / path-to-project overrides, including whether they support project relocation or only multi-root lookup;
- session-to-project reverse lookup and additional permission directories;
- project-private plans, `AGENTS.md`, Memory, bots, and other data that must remain Project-scoped.

The plan must identify which multi-path fields and APIs can be removed, which need a compatibility period, and how existing projects are migrated without changing `project_id`. Do not delete project-private configuration merely because Project becomes single-root. Do not infer that a folder is safe to remove because it is not the first path.

### Workspace owns local roots and execution policy

- One Project may have multiple device-local Workspaces; a Workspace may be unbound to a Project for scratch work.
- A Workspace may contain one or more roots. Each root has a stable ID, alias, role, access mode, and local canonical path.
- `defaultRoot` is a root ID. `cwd` is a root ID plus a relative path.
- Project rules and Memory remain Project-scoped where they describe the logical project. Device paths, Trust, local permissions, index state, and run manifests are Workspace-scoped.
- Main owns the authoritative root map, policy decision, and immutable Run manifest. Agent-facing tools use logical root references; a direct absolute-path handoff to MCP or untrusted extensions is not the desired contract.

## Workspace Creation Contract

Phase 0 must produce and review a field-by-field decision table. Initial proposal:

| Setting | User input or derived | V1 decision |
|---|---|---|
| Workspace name | User input | Required; suggest the selected folder name. |
| Project | User input | Optional; select an existing Project or create one from a single root. |
| Folder roots | User input | At least one local folder. Additional folders are Workspace roots, not Project paths. |
| Root alias | User input / suggested | Suggest from folder name; require uniqueness within the Workspace. |
| Root role | User input / suggested | `source`, `docs`, `data`, or `output`; allow a simple default and edit later. |
| Root access | User input | `read` or `read-write`, displayed per root. No implicit write access for added roots. |
| Default root and cwd | Derived / optional edit | Default to the first selected root and its root directory; store as root ID plus relative path. |
| Trust | User input | Show `restricted` / `trusted` with plain-language effects. Decide and document the safe default in Phase 0. |
| Shell, network, MCP, connectors | Advanced policy | Specify `deny` / `ask` / `allow` separately. Expose only settings whose behavior is enforced in V1. Never offer `sandboxed` until a real sandbox exists. |
| Instructions | Derived | Discover applicable global, Project, root, and nested instructions; retain source and digest in the Run manifest. |
| Indexing | Derived / later | V1 scope must be decided. Do not present code/document indexing options before the corresponding indexers exist. |
| Workspace ID, root IDs, device binding, revisions | System-generated | Not exposed as creation form fields. |

The final plan must distinguish:

1. required creation fields;
2. optional or advanced policy choices;
3. automatically derived values;
4. deferred capabilities.

It must also specify what happens when an existing path is missing, duplicated, aliases another root, is a symlink/junction, or resolves outside the selected root.

## Trust and Permission Contract

Phase 0 must define a capability matrix for at least `read`, `write`, `execute`, `network`, `MCP`, and `connector`. The matrix must cover Restricted and Trusted, per-root read/write access, the existing PermissionMode / approval flow, and the behavior when a policy is missing or conflicting.

Required invariants:

- Workspace rules and repository instructions never grant capabilities.
- Root `read` access cannot be upgraded by a tool, Profile, Mode, MCP schema, or project instruction.
- `trusted` does not silently authorize all network, connector, or plugin actions.
- Deny wins; approval is an explicit operation grant and does not create a filesystem sandbox.
- Until shell and extension processes are sandboxed or brokered, UI and docs must state that those processes can run with the OS user's privileges.
- Manifest policy is immutable for a Run. A policy change affects a new Run, not an in-flight one, unless an explicit revocation mechanism is designed.

## Work Items

### 0.1 Repository and call-path audit

- [ ] Read the current `ARCHITECTURE.md`, execution-plan README, and relevant scoped `AGENTS.md` files in the local checkout.
- [ ] Read active plans that affect Project DB ownership, Permission, and nested instruction loading; record their status and avoid overlapping schema changes.
- [ ] Inventory every `Project.paths`, `canonical_root`, path-alias, `working_directory`, and additional-directory producer / consumer.
- [ ] Inventory file, shell, MCP, connector, Plugin, Workflow, Research, and CLI execution entry points; mark which run in Main, Agent Worker, or child processes.
- [ ] Record current path-check coverage, symlink/junction behavior, and any direct filesystem access outside the built-in tools.

### 0.2 Domain and Project simplification

- [ ] Write the object ownership table for Project, Workspace, Root, Session, and Run.
- [ ] Decide the single-root Project field and identify the exact multi-path fields / APIs to deprecate or remove.
- [ ] Preserve Project UUID and classify plans, instructions, Memory, bots, and path-relocation metadata as Project- or Workspace-owned.
- [ ] Define migration behavior for existing multi-path Projects and sessions whose cwd is not the Project's primary path.

### 0.3 Workspace creation and defaults

- [ ] Finalize the creation form fields and the required / advanced / derived / deferred split.
- [ ] Finalize root alias, role, access, default-root, and cwd behavior.
- [ ] Choose safe defaults for Trust, shell, network, MCP, and connectors; document effects in user-facing language.
- [ ] Define validation and error cases for paths, duplicate roots, missing folders, symlinks, and junctions.

### 0.4 Architecture and enforcement boundary

- [ ] Define `WorkspaceService`, `WorkspaceRegistry`, `RootResolver`, `PolicyEngine`, `ContextResolver`, and Run manifest responsibilities.
- [ ] Choose whether V1 file operations are brokered by Main or are explicitly an Agent-side application policy with narrower security claims.
- [ ] Define how Chat, Research, Workflow, Terminal, CLI, and MCP receive or are denied Workspace context.
- [ ] Specify manifest identity, revision, instruction digest, path privacy, and in-flight policy-change behavior.

### 0.5 Phase 1 implementation plan and acceptance criteria

- [ ] Split follow-up work into P0 foundation, P1 local Workspace V1, and P2 sandbox / index / extension capabilities.
- [ ] Name the files/modules to change and the migration/compatibility steps.
- [ ] Define security acceptance cases for traversal, root access modes, symlink/junction escapes, stale manifests, and shell bypass disclosure.
- [ ] Update `ARCHITECTURE.md` proposal or link this plan from it after the Phase 0 decisions are reviewed.

## Deliverables

1. This plan updated with decisions and evidence.
2. A reviewed Workspace domain model and Project single-root migration contract.
3. A reviewed Workspace creation-settings matrix and Trust / Permission matrix.
4. A Main / Agent / Workflow boundary diagram and immutable Run manifest contract.
5. A sequenced Phase 1+ execution plan with file/module scope and acceptance criteria.

## Exit Criteria

- [ ] Every current multi-path Project consumer has a migration or removal decision.
- [ ] No Project ID, Memory scope, or project-private user data is silently re-keyed or discarded.
- [ ] Creation fields, defaults, derived state, and deferred controls are explicit.
- [ ] Restricted / Trusted behavior is specified for all six capability categories.
- [ ] The design distinguishes Agent-side permission checks from OS-enforced isolation.
- [ ] Chat, Research, Workflow, Terminal, CLI, and extension handling of Workspace context is defined.
- [ ] Phase 1 plan is implementable without unresolved ownership or compatibility questions.

## Dependencies and Coordination

- Coordinate Project table / DB ownership with active plan `534-projects-core-db-and-main-db-migration`; Phase 0 must not perform a competing Projects schema migration.
- Coordinate nested instruction discovery with active plan `408b-nested-agents-md-loading`; Workspace Context Resolver should reuse the established loader contract where appropriate.
- Coordinate permission and MCP policy semantics with `419-permission-decision-bus` and app-connection approval plans; do not duplicate approval state.
- Check whether `424-config-driven-custom-agents` or other active plans introduce separate Agent work directories that need Workspace binding.

## Progress Log

- 2026-09-29: Created Phase 0 plan from the Workspace architecture investigation and the decision to return Project to a single-root model. Local plan status and source documents still need confirmation in the checkout before implementation begins.
