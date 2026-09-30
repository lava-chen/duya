# Harness Comparison Knowledge Base

## Goal

One-time deep research across five agent-harness codebases, producing a
permanent reference under `docs/references/harness-comparison/`. Future work
consults these docs instead of re-exploring the clones.

## Subject repos (pinned at time of writing)

| Repo (under E:\cloned-projects) | Language / stack | Commit |
| ------------------------------- | ---------------- | ------ |
| `openclaw`                      | TypeScript (pnpm workspace, many packages) | `9aa19fef2ff` |
| `pi`                            | TypeScript (packages: agent, ai, tui, server, protocol...) | `b6557f43e` |
| `codex`                         | Rust (`codex-rs`) + TS CLI | `2df6705423` |
| `hermes-agent`                  | Python (`agent/`, `hermes/`, gateway) | `b3aa561faf` |
| `claude-code-haha`              | TypeScript + Ink/React TUI | `76d21dd` |

## Output

`docs/references/harness-comparison/*.md` — one doc per capability dimension.
Every claim carries a source citation (`repo/path/file.ts:line`) plus key code
snippets. Each dimension doc ends with a comparison table.

## Dimensions

- [x] `prompt-and-system-prompt.md` — system prompt assembly, templates
- [x] `tool-system.md` — tool definition, schema validation, registry, exec loop
- [ ] `loop-control.md` — main agent loop, steering, interrupt, retry, compaction triggers
- [x] `context-management.md` — window budgeting, compaction/truncation strategies
- [x] `session-and-persistence.md` — session storage, resume, fork
- [ ] `permission-and-sandbox.md` — permission modes, approval flow, sandboxing
- [x] `streaming-and-events.md` — streaming protocol, event model (SSE/IPC)
- [ ] `subagent-and-delegation.md` — subagents, delegation, parallelism
- [x] `extensions-mcp-skills.md` — MCP, plugins, skills, hooks, extensions
  - plus unplanned extras: `extension-integration.md`, `hooks-system.md`
- [ ] `tui-and-ui.md` — terminal rendering, input handling, interactive UI
- [x] `llm-provider-layer.md` — provider abstraction, multi-protocol adapters
- [ ] `comparison-matrix.md` — feature × harness master table (integration owner)

Also missing vs this checklist: `README.md` (index) and `00-overview.md`
(process model / layering). The directory-level index lives at
`docs/references/index.md`.

## Phases

1. **Setup** — plan + directory skeleton. ✅
2. **Research** — 6 parallel workers, disjoint file ownership:
   - A: overview + prompt
   - B: tool-system + loop-control
   - C: context-management + session-persistence
   - D: permission-sandbox + streaming-events
   - E: subagent-delegation + extensions-mcp-skills
   - F: tui-ui + llm-provider-layer
3. **Integration** — main agent writes README.md + comparison-matrix.md,
   cross-checks citations style consistency.
4. **Commit** — single docs commit.

## Verification

- Every dimension file exists and has per-repo sections with citations.
- Spot-check 3 random citations against the actual source.
- No edits outside `docs/references/harness-comparison/` except this plan.

## Audit status (2026 audit pass)

Full citation audit against the pinned clones completed (~160 citations
checked). All hard factual errors fixed in-place: openclaw built-in tools,
codex EventMsg count (81), codex contributor traits (12), hermes threat-scan
location (`prompt_builder.py`), overflow table (23 providers), VALID_HOOKS
(24), provider file counts, FTS table count. Remaining known gaps: the seven
unchecked dimensions above; minor line-number drift (±2–18 lines) in some pi
citations.
