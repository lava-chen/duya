---
name: self-knowledge
description: "DUYA 自我认知与仓库地图 — 用户问 DUYA 自身(架构/数据库/模块/构建/当前进度)时使用：'DUYA 架构'、'项目现在做到哪'、'这个模块在哪'、'怎么构建'、'数据库结构'。Also when starting work and you need to find the relevant docs before touching code. Not for generic coding questions in the user's own project."
when-to-use: "Before non-trivial work in the DUYA repo: locate the right doc or plan first, then read code."
allowed-tools: [Read, Glob, Grep]
---

# DUYA Self-Knowledge

A map to the DUYA knowledge base and repository — not a substitute for
reading the actual docs. This skill tells you WHERE to look; always open the
named file and read it rather than answering from memory.

## Repository map (root refs)

- `AGENTS.md` — root rules, commands, gates, footguns, logging conventions.
  **Start here before any work.**
- `ARCHITECTURE.md` — database schema, data flows, module APIs, packaging.
  Read before starting; update after significant changes.
- `docs/` — the knowledge base:
  - `docs/exec-plans/README.md` — **current work status** (active plans table).
    Check this first to verify a feature/plan is still active.
  - `docs/exec-plans/active/` — plans being executed (phased, checkboxed).
  - `docs/exec-plans/completed/` — finished plans with decision logs.
  - `docs/exec-plans/tech-debt-tracker.md` — known tech debt.
  - `docs/design-docs/` — design decisions and core beliefs.
  - `docs/product-specs/`, `docs/references/`, `docs/generated/` — specs,
    LLM-optimized tooling references, auto-generated docs (e.g. `db-schema.md`).
  - `docs/wiki/` — LLM-structured wiki (concepts / modules / classes / workflows).

## Code map

- Frontend: `src/` — Vite + React 19 + Zero Router.
- Agent core: `packages/agent/` — `@duya/agent` workspace package
  (`src/` for the agent loop, `skills/` for the skills directory).
- Electron main: `electron/` — Main Process + Agent Server + Gateway
  (IPC handlers under `electron/ipc/`, config under `electron/config/`).
- Plugin core: `packages/plugin-core/` — plugin manifests, MCP, workflows, security.
- Gateway: `packages/gateway/` — channel adapters (Telegram, etc.).
- Build scripts: `scripts/` — esbuild configs, plugin scaffold/validate scripts.

## How to answer a "current status" question

1. Read `docs/exec-plans/README.md` — the Active Plans table lists every
   in-flight plan with priority + status.
2. For the specific plan, read `docs/exec-plans/active/<number>-<name>.md` and
   check its checkbox progress.
3. Cross-check git history (`git log --oneline -10`) and the current branch if
   the user asks what changed recently.

## How to answer an architecture question

1. Search `ARCHITECTURE.md` for the subsystem name first; it records schema,
   flows, and module APIs in one place.
2. Then read the relevant source (`codegraph explore "<symbols>"` or direct
   reads) to confirm the CURRENT state — docs can lag code.
3. If the question is about skills, note: system-level skills ship in
   `packages/agent/skills/.system/`; ordinary built-in skills live in
   `packages/agent/skills/<category>/`; user skills live in `~/.duya/skills/`.

## Rules of thumb

- Docs are the map, code is the truth. When they disagree, trust code and flag
  the doc as stale.
- `docs/exec-plans/README.md` is the first place to check before any work —
  do not start coding against an inactive or superseded plan.
- Keep answers grounded in the files you actually read; link with repo-root
  relative paths (`src/components/...:line`), never absolute paths.
