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
- Electron main: `electron/` (Main Process + Agent Server + Gateway)
- Build scripts: `scripts/` (esbuild configs)
- Docs: `docs/{design-docs,exec-plans,generated,product-specs,references}/`
- Scoped guides: `docs/exec-plans/README.md`, `docs/design-docs/core-beliefs.md`

## Architecture

- **HTTP+SSE 三层分离**：Main Process ↔ Agent Server (HTTP+SSE) ↔ Worker Processes
- **IPC**: IPC invoke/handle (`db:*`, `gateway:*`, `automation:*`, `logger:*`, etc.) + Agent Server HTTP endpoints
- **MessagePort**: 仅用于 config/toolExec/toolStream 三通道，不含 agentControl
- **Database**: SQLite via better-sqlite3. Path: `%APPDATA%/DUYA/databases/duya-main.db` (Windows), `~/Library/Application Support/DUYA/...` (macOS), `~/.local/share/DUYA/...` (Linux). Managed by `boot.json`.
- **Agent core** runs in isolated child_process. Built separately as workspace package.
- **Logging**: Structured logger (`electron/logging/logger.ts`), level `WARN` by default, console output only for WARN+. See [Logging](#logging).
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
- Release tag: `package.json:version` MUST match the tag being pushed (see Git → Release Tag).

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

### Release Tag

`package.json` `version` is the **source of truth** for the released
artifact. `electron-builder` reads the version from `package.json`,
not from the git tag. If `package.json:version` still points to a
previously-released version, `electron-builder --publish always`
will skip creating the new release and exit 0 (silent no-op).

- **MUST bump `package.json` `version` in the same commit as the release tag.**
- Pre-tag checklist:
  1. Pick the next version (see [How to recommend a tag](#how-to-recommend-a-tag) below).
  2. Update `package.json` `version` (e.g. `0.1.3-beta.2` → `0.1.3-beta.3`).
  3. Commit the bump before tagging (`chore(release): bump version to <X>`).
  4. Tag the bump commit, not an earlier one.
  5. `git push origin <branch>` then `git push origin v<X>`.
  6. The CI release workflow is the only thing that should ever create a GitHub Release.
- If a tag is pushed without the corresponding `package.json` bump, the release will fail silently (workflow job shows `success`, but no Release is created on GitHub). Always verify the Release exists with `gh release view <tag>` after a release run.

#### How to recommend a tag

When the user asks "what tag should I cut?" (or "打 tag 时根据规则自己推荐一个最合适的 tag"), follow this procedure. Do not silently pick a number — always **show the recommendation, the reasoning, and any detected breaking changes, and ask the user to confirm before tagging**.

1. **Collect the candidate set.**
   - `git tag --list 'v*' --sort=-v:refname | head -5` — most recent tags.
   - `git log <last-tag>..HEAD --oneline` — commits since the last tag.
   - `cat package.json | grep '"version"'` — current declared version.
   - The current `package.json` `version` is the **floor**: the next tag must be `>=` it.

2. **Classify every commit** since the last tag with the highest applicable Conventional-Commit type:
   - `BREAKING CHANGE:` footer or `!` after type/scope → **MAJOR**
   - `feat:` → **MINOR**
   - `fix:`, `refactor:`, `perf:`, `docs:`, `test:`, `build:`, `ci:`, `chore:` → **PATCH**
   - `revert:` is treated as the type of the reverted commit.

3. **Apply semver, project-specific overrides below**, then pick the highest.

4. **Recommend** the version, the bump type, and one-line evidence
   (e.g. *"3 `feat:`, 12 `fix:`, 0 `BREAKING CHANGE`. Recommend
   `0.1.5` (MINOR)."*). Wait for user confirmation before tagging.

##### Semver rules for duya

`0.x` is pre-1.0, so MAJOR bumps are not yet meaningful — use
MINOR to signal "anything beyond fixes." This matches the existing
trajectory (`0.1.1` → `0.1.2` → `0.1.3-beta.*` → `0.1.4`).

| Highest commit type | Current `0.x` | Next tag (default)                                       |
| ------------------- | ------------- | -------------------------------------------------------- |
| `BREAKING CHANGE`   | `0.1.x`       | bump MINOR (e.g. `0.1.4` → `0.2.0`)                      |
| `feat`              | `0.1.x`       | bump MINOR (e.g. `0.1.4` → `0.1.5`)                      |
| `fix` / others      | `0.1.x`       | bump PATCH (e.g. `0.1.4` → `0.1.4` already; new tag is `0.1.4` is invalid — bump PATCH once you have at least one fix: `0.1.4` → `0.1.5` is wrong for fix-only; correct shape is to enter `1.0` first, but for `0.x` treat PATCH-only the same as MINOR, i.e. `0.1.4` → `0.1.5`) |
| anything            | `1.x.y`       | standard semver (MAJOR/MINOR/PATCH as above)             |

**Pre-release (`-beta.N`) decision** — default to a stable release,
not a beta, unless any of the following are true:
- The user asked for a beta explicitly.
- The last shipped tag was itself a beta and the packaged build
  has not yet been smoke-tested.
- A `feat:` landed that touches the packaging / install path
  (`electron:pack`, `electron-builder`, `electron:build`) and a
  packaged smoke test is still pending.
- A `BREAKING CHANGE` landed against a public CLI / IPC surface
  and we want early adopters to test before promoting to stable.

If any of the above, recommend e.g. `0.1.5-beta.1` (increment `.N`
from the most recent `-beta.M` on the same MINOR line; reset `.N` to
`1` when MINOR advances).

##### Confirmation template

Show the user this block and wait for `ok` / a different number:

```
Recommended tag:  v0.1.5
  - reason:      3 feat(agent/electron/cli), 12 fix/refactor, 0 BREAKING
  - current:     0.1.4  (package.json)
  - last tag:    v0.1.4 (2026-06-09, 41 commits ago)
  - pre-release: no — packaged smoke not pending, no beta requested

Confirm to:  1) bump package.json → 0.1.5
             2) chore(release) commit
             3) git tag -a v0.1.5 -F docs/release-notes/v0.1.5.md
             4) push branch + tag
```

##### Tag message

Annotated tag, body from `docs/release-notes/v<X>.md` (one bullet
per headline change, no prose). Example:

```bash
git tag -a v0.1.5 -F docs/release-notes/v0.1.5.md
git push origin master v0.1.5
```

The release-notes file is the only place where the changelog lives
in long form. Do not duplicate it into the tag body.

## Code

- TS strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- Comments: English only. Never write comments in Chinese.
- External boundaries: prefer `zod` or existing schema helpers.
- UI: use CSS variables from `globals.css` (`var(--bg-canvas)`, `var(--text)`, `var(--accent)`). Support both light and dark modes (`data-theme`).
- Follow existing patterns in `src/components/` before creating new ones.
- Use Tailwind + custom CSS classes from `globals.css`.

## Logging

### System

Use the structured logger from `electron/logging/logger.ts`. **Never use `console.log/warn/error`** directly.

```typescript
import { initLogger, getLogger, LogComponent } from '../logging/logger';

// Module-level singleton (call once per module)
const logger = initLogger({ level: 'WARN' });

// Or get existing instance
const logger = getLogger();
```

### Levels

| Level | Console | File | When to use |
|-------|---------|------|-------------|
| `DEBUG` | No | Yes | Detailed diagnostics (query params, loop iterations, etc.) |
| `INFO`  | Yes | Yes | Significant events: server start, task completion, user actions |
| `WARN`  | Yes | Yes | Unexpected but recoverable (config missing, fallback triggered) |
| `ERROR` | Yes | Yes | Operation failed but app can continue |
| `FATAL` | Yes | Yes | App cannot continue, needs immediate attention |

**Default level is `WARN`**. INFO+ goes to console; DEBUG only to file.

### Component Tag

Always pass a `component` string (use `LogComponent` constants) so logs are filterable:

```typescript
logger.info('Agent process started', { pid: process.pid }, LogComponent.AgentProcess);
```

### What to Log

- **INFO**: Boot events, user-initiated actions, significant state changes, task milestones
- **WARN**: Missing config with fallback, retry attempts, degraded behavior
- **ERROR**: Failures that affect user but app continues, caught exceptions with context
- **DEBUG**: Query parameters, loop counters, raw data samples, detailed control flow

### What NOT to Log

- Database query results (unless debugging a specific issue — use DEBUG)
- Large objects or arrays
- User input or message content
- File paths or data that could contain user info
- `console.log` debugging artifacts left in code

### Performance

Use `logger.time()` and `logger.timeAsync()` for tracking operation duration:

```typescript
const end = logger.time('document parse');
// ... work ...
end(); // Logs: "document parse completed" with duration in ms

await logger.timeAsync('gateway request', async () => {
  return await fetch(url);
});
```

### File Output

Logs written to `%APPDATA%/DUYA/logs/app.log`, rotated daily, retained 7 days. Use `LOG_LEVEL=DEBUG` env var to enable verbose console output for debugging.

## Tests

DUYA uses a three-layer testing strategy. Pick the layer that matches the
question you're asking.

### 1. Unit tests (Vitest, fast, no Electron)

- **Runner**: `vitest` 3.x. Config: `vitest.config.ts`.
- **Location**:
  - `src/**/*.test.ts` / `*.test.tsx` — colocated with frontend code
  - `packages/*/tests/**/*.test.ts` — colocated with workspace package code
  - `electron/ipc/__tests__/*.test.ts` — IPC handler unit tests
- **Run**: `npm run test`, `npm run test:watch`, `npm run test:coverage`,
  `npm run test:bridge` (scoped to the bridge module).
- **IPC handler test pattern** (critical): see
  `electron/ipc/__tests__/url-safety.test.ts` (pure function) and
  `electron/ipc/__tests__/logger-handlers.test.ts` (mocked module).
  - All mock state must live inside `vi.hoisted(() => ({ ... }))` so the
    `vi.mock` factory (also hoisted) and the test bodies share one singleton.
  - `vi.mock` paths are **relative to the test file**, not the source file.
    From `electron/ipc/__tests__/foo.test.ts`, the logger module is
    `'../../logging/logger'`, not `'../logging/logger'`.
  - For a stable `getLogger()` mock, return `mocks.logger` from the
    factory — not a fresh object each call (otherwise
    `mockReturnValueOnce` calls are lost between tests).

### 2. E2E tests (Playwright `_electron`, real binary)

- **Runner**: `@playwright/test` driving the real Electron main process
  via the `_electron` API. See `e2e/playwright.config.ts`.
- **Location**: `e2e/smoke/smoke.spec.ts`, `e2e/ipc/*.spec.ts`.
- **Run**: `npm run test:e2e`, `npm run test:e2e:smoke`, `npm run test:e2e:ipc`.
- **Requires**: `npm run electron:build` first (produces `dist-electron/`).
  The Vite dev server is auto-started by Playwright's `webServer` config
  (`reuseExistingServer: true` lets you run `npm run dev` in parallel).
- **Isolation**: each spec passes a unique `--duya-namespace=<name>` so
  its userData (and SQLite DB) is fresh. `DUYA_TEST=1` enables
  test-mode hooks (single-instance bypass, no DevTools, etc.).
- **Pattern**: `helpers.ts` exports `launchDuya({ namespace })` and
  `invokeApi(page, 'settings.get', 'key')` which calls into
  `window.electronAPI` in the renderer. `closeDuya()` force-kills the
  process tree on Windows if the graceful close times out.

### 3. UI verification (Playwright MCP, dev server only)

- For interactive UI smoke checks during development. Start the Vite
  dev server first (`npm run dev`), then use MCP tools.
- Example: `mcp__playwright browser_navigate http://localhost:3000`,
  `mcp__playwright browser_snapshot`.

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

