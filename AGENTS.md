# AGENTS.md

> Map to the knowledge base — not a 1,000-page manual.

Telegraph style. Root rules only. Read scoped `AGENTS.md` before subtree work.

## Start

- Repo: `https://github.com/lava-chen/duya`&#x20;
- Before ANY work: read [docs/exec-plans/active/README.md](./docs/exec-plans/README.md) for current work status
- Verify feature/plan is still active; read relevant active plan file for progress
- Read [ARCHITECTURE.md](./ARCHITECTURE.md) before starting — contains database schema, data flows, module details
- For multi-step tasks: use `/plan` mode before writing code
- Replies: repo-root refs only: `src/components/chat/MessageList.tsx:45`. No absolute paths, no `~/`.
- Missing deps: `npm install`, retry once, then report first actionable error.

## Map

- Frontend: `src/` (Vite + React 19 + Zero Router)
- Agent core: `packages/agent/` (@duya/agent, workspace package)
- Electron main: `electron/` (process manager, SQLite single writer, IPC)
- Build scripts: `scripts/` (esbuild configs)
- Docs: `docs/{design-docs,exec-plans,generated,product-specs,references}/`
- Scoped guides: `docs/exec-plans/README.md`, `docs/design-docs/core-beliefs.md`

## Architecture

- Three-layer: `src/` (renderer) ↔ `electron/` (main) ↔ `packages/agent/` (agent process)
- IPC: MessagePort (persistent channels: `agentControl`, `config`) + IPC invoke/handle (`db:*`, `gateway:*`, `automation:*`, etc.)
- Database: SQLite via better-sqlite3. Path: `%APPDATA%/DUYA/databases/duya-main.db` (Windows), `~/Library/Application Support/DUYA/...` (macOS), `~/.local/share/DUYA/...` (Linux). Managed by `boot.json`.
- Agent core runs in isolated child\_process. Built separately as workspace package.
- esbuild does NOT type check. Always run `npm run typecheck:all` before committing.
- After significant changes: update [ARCHITECTURE.md](./ARCHITECTURE.md).

## Commands

```bash
# Development
npm run dev                    # Vite dev server only (port 3000)
npm run electron:dev           # Vite + Electron together

# Build & Typecheck
npm run build                  # Production build (Vite)
npm run build:web             # Web frontend only
npm run build:agent           # Build @duya/agent workspace (tsc)
npm run bundle:agent          # Bundle Agent subprocess entry (esbuild)
npm run electron:build         # Build Agent + bundle + Vite + Electron
npm run typecheck:all         # TypeScript check for both src/ and packages/agent — MUST run before commit

# Testing
npm run test                   # Vitest tests
npm run test:watch            # Vitest watch mode
npm run test:coverage         # Tests with coverage
npm run test:bridge           # Bridge-specific tests

# Packaging
npm run electron:pack         # Package current platform
npm run electron:pack:win     # Windows (.exe installer)
npm run electron:pack:mac     # macOS (.dmg)
npm run electron:pack:linux   # Linux (AppImage, .deb, .rpm)

# Agent CLI (standalone)
node packages/agent/dist/cli/index.js [options]
#   -k, --api-key <key>        API key for LLM provider
#   -m, --model <model>        Model to use
#   -u, --base-url <url>       Base URL for API
#   -p, --provider <provider>  LLM provider protocol: anthropic or openai
#   -w, --workspace <dir>      Workspace directory
#   -t, --task <task>          Execute task and exit (non-interactive mode)
#   --print                    Print mode: single query and exit
#   --headless                 Headless mode: read from script file
#   -f, --format <format>      Output format: text, json, markdown
```

## Gates

- Pre-commit: `npm run typecheck:all` MUST pass. esbuild does not type check.
- UI changes: verify with Playwright MCP after implementation. Do not skip.
- No commit of secrets, API keys, credentials.
- Build gate: `npm run electron:build` before push if build output, packaging, or lazy/module boundaries can change.

## Git

- Commits: [Conventional Commits](https://www.conventionalcommits.org/) format. English only.
- Title format: `<type>(<scope>): <description>`
  - `type`: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, `ci`
  - `scope`: optional, e.g. `agent`, `ui`, `electron`, `bridge`, `tool`, `db`
  - `description`: imperative mood, lowercase, no period at end. Max 72 chars.
- Body (when needed): explain **what** and **why**, not **how**. Wrap at 72 chars.
- Breaking change: add `BREAKING CHANGE:` footer or `!` after type/scope.
- Examples:
  - `feat(agent): add streaming timeout config`
  - `fix(ui): resolve message list scroll jump on new messages`
  - `refactor(electron): extract ipc handlers to separate modules`
  - `docs: update AGENTS.md commit message format`
- Atomic: one logical change per commit. Do not mix unrelated fixes.
- No merge commits on `main`: rebase on latest `origin/main` before push.

## Code

- TS strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- Comments: English only. Never write comments in Chinese.
- External boundaries: prefer `zod` or existing schema helpers.
- UI: use CSS variables from `globals.css` (`var(--bg-canvas)`, `var(--text)`, `var(--accent)`). Support both light and dark modes (`data-theme`).
- Follow existing patterns in `src/components/` before creating new ones.
- Use Tailwind + custom CSS classes from `globals.css`.

## Tests

- Vitest. Colocated `*.test.ts`.
- UI verification: Playwright MCP. Start dev server first (`npm run dev`), then use MCP tools.
- Example: `mcp__playwright browser_navigate http://localhost:3000`, `mcp__playwright browser_snapshot`.

## Build System

| Component         | Technology                      | Config                       |
| ----------------- | ------------------------------- | ---------------------------- |
| Frontend          | Vite 6 + React 19 + Zero Router | `vite.config.ts`             |
| Desktop Shell     | Electron 28                     | `electron/main.ts`           |
| Electron Compiler | esbuild                         | `scripts/build-electron.mjs` |
| Packager          | electron-builder                | `electron-builder.yml`       |
| Agent Core        | TypeScript                      | `packages/agent/`            |
| Testing           | Vitest + Playwright             | `vitest.config.ts`           |

### Agent Bundle (MUST FOLLOW)

- Format: CommonJS (`format: 'cjs'`). Output: `packages/agent/bundle/agent-process-entry.js`
- `bundle: true` inlines all runtime dependencies. Only `better-sqlite3` (native) and `BashWorker.js` (worker) remain external.
- Production resolves: primary `resources/agent-bundle/agent-process-entry.js`, fallback paths only for debug.
- Self-contained: no `node_modules` copying in `afterPack`.
- `better-sqlite3`: packaged to `resources/better-sqlite3/`, shared by main and agent. Agent receives `DUYA_BETTER_SQLITE3_PATH` env var.
- `BashWorker.js`: bundled to `resources/agent-bundle/BashTool/`. Worker uses `process.execPath` as Node.js runtime in production.
- Pre-release checks:
  - `release/win-unpacked/resources/agent-bundle/agent-process-entry.js` exists
  - `release/win-unpacked/resources/agent-bundle/BashTool/BashWorker.js` exists
  - `release/win-unpacked/resources/better-sqlite3/build/Release/better_sqlite3.node` exists
  - First packaged chat turn reaches Agent `ready` (no timeout)
  - `app.log` has no `ERR_MODULE_NOT_FOUND`

## Workflow

### Start New Task

1. Read AGENTS.md (this file) ← REQUIRED
2. Check `docs/exec-plans/README.md` for current work status ← REQUIRED
3. Find relevant active plan or create new one
4. Read the plan file to understand current progress
5. Read ARCHITECTURE.md for technical details

### During Implementation

1. Follow the plan's checkboxes and phases
2. Run `npm run typecheck:all` before any commit
3. For UI changes: verify with Playwright MCP
4. Test your changes work correctly

### Complete Task

1. Mark completed checkboxes `[x]` in the plan file
2. If plan fully done:
   - Move plan file to `docs/exec-plans/completed/`
   - Update `docs/exec-plans/README.md` (remove from active, add to completed)
3. If architectural change: update ARCHITECTURE.md
4. Commit with clear English message

## Footguns

- Editing `electron/preload.ts` without rebuilding Electron
- Modifying `packages/agent` exports without rebuilding (`npm run build:agent` / `npm run bundle:agent`)
- Adding to `src/app/api/` routes without verifying path doesn't conflict
- Skipping Playwright verification for UI changes
- Forgetting `npm run typecheck:all` before committing
- NOT checking active plans before starting work ⚠️
- Electron window blank: check DevTools console, verify `http://localhost:3000` reachable

## Docs Structure

| Path                  | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `AGENTS.md`           | This file — main entry point (start here)                   |
| `ARCHITECTURE.md`     | Architecture, database schema, data flows, module APIs      |
| `docs/design-docs/`   | Design decisions and core beliefs                           |
| `docs/exec-plans/`    | Execution plans (active/, completed/, tech-debt-tracker.md) |
| `docs/generated/`     | Auto-generated docs                                         |
| `docs/product-specs/` | Product specifications and onboarding                       |
| `docs/references/`    | Tooling references optimized for LLMs                       |

## Principles

- **Progressive disclosure**: Start small, guide to deeper info
- **Code is truth**: Versioned artifacts in repo are the source of truth
- **Verification first**: Build test/verification tools before the feature
- **Check plans first**: Always verify current work status before starting

