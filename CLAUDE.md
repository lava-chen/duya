# CLAUDE.md

> Claude Code reads this file automatically. **The authoritative guide is
> [AGENTS.md](./AGENTS.md) — read that one.**

This file used to be a full copy of `AGENTS.md`. That gave the repo two agent
handbooks that drifted apart and answered the same question differently (wrong
build commands, wrong DB path, wrong Electron version). It is now a pointer.

## Where to look

| You want | Read |
| --- | --- |
| The map, commands, gates, git workflow, footguns | [AGENTS.md](./AGENTS.md) |
| **Which package to open for a symptom** | [ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md) |
| One specific package's responsibility + debug entries | `packages/<pkg>/AGENTS.md` |
| Design and data flows | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| What is being worked on right now | [docs/exec-plans/README.md](./docs/exec-plans/README.md) |

## If a path here looks wrong

Do not patch this file. Patch `AGENTS.md` (or the package's own `AGENTS.md`)
and keep this one as a pointer. A second copy is how the drift started.
