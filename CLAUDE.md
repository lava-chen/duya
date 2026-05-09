# CLAUDE.md

> **IMPORTANT**: This file exists for Claude Code compatibility only.
>
> **For all agent work, start with [AGENTS.md](./AGENTS.md) instead.**

---

This file provides minimal guidance for Claude Code. For complete information, see [AGENTS.md](./AGENTS.md).

## Complete Workflow

### 1. Start New Task

```
a. Read AGENTS.md ← REQUIRED
b. Check docs/exec-plans/README.md for current work status ← REQUIRED
c. Find or create relevant plan
d. Read the plan file
```

### 2. During Implementation

```
a. Follow the plan's phases and checkboxes
b. Run npm run typecheck:all before any commit
c. For UI changes: verify with Playwright MCP
```

### 3. Complete Task

```
a. Mark completed checkboxes [x] in plan
b. If fully done: move to docs/exec-plans/completed/
c. Update docs/exec-plans/README.md
d. Commit with clear message
```

## Commands

```bash
# Development
npm run dev
npm run electron:dev

# Build & Typecheck
npm run build
npm run electron:build
npm run typecheck:all  # MUST run before commit

# CLI
node packages/agent/dist/cli/index.js [options]
```

## Key Rules

1. **Code comments must be in English**
2. **Check active plans before any work** — See AGENTS.md
3. **Run typecheck:all before commit** — MUST pass

## More Info

See [AGENTS.md](./AGENTS.md) for complete documentation.
