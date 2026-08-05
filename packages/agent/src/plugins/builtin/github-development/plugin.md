---
name: github-development
description: GitHub repository, issue, PR, review, CI, and release workflows
version: 0.1.0
author: DUYA Team
---

# GitHub Development Plugin

End-to-end GitHub development workflow: explore repositories, turn Issues
into pull requests, review PRs, diagnose failing CI, and ship release
notes. Bundles the official GitHub MCP server plus five skills that
codify how Duya drives GitHub from chat.

## What this plugin adds

- MCP server `github` (stdio) — wraps the official `github-mcp-server`
  image (ghcr.io/github/github-mcp-server) run via Docker so the agent
  can call `repos.*`, `issues.*`, `pull_requests.*`, `actions.*`, and
  `releases.*` tools. Requires Docker to be installed and running.
- Five skills:
  - `repository-exploration` — quick orientation in any repo: structure,
    code location, history.
  - `issue-to-implementation` — read an Issue, locate the code, implement,
    open a PR.
  - `pull-request-review` — review a PR diff, leave comments, suggest
    changes.
  - `fix-ci` — read failing Actions logs, localize, fix, push.
  - `release-notes` — generate release notes from a milestone or tag.
- Four workflow templates (YAML drafts, activated when Plan 311 lands):
 implement-issue, review-current-pr, analyze-ci-failure,
 generate-release-notes.

## Authentication

The GitHub MCP server supports two credential modes:

1. **GitHub App installation token** (preferred) — short-lived,
   scoped to the repositories the App is installed on. Rotate
   automatically. This is the only mode that survives in production.
2. **OAuth user token** — acceptable for interactive sessions; still
   preferred over a long-lived PAT.
3. **Personal Access Token (PAT)** — supported as a fallback for local
   stdio, but **not recommended**. Never store a long-lived PAT in
   plugin configuration; if a PAT is unavoidable, scope it tightly and
   rotate it daily.

Long-lived PATs are explicitly discouraged. When the Remote MCP transport
lands (Plan 313 Phase 2a), this plugin will migrate to GitHub's official
remote endpoint and drop the stdio PAT path entirely. Until then, the
stdio fallback is documented as transitional.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Read-only actions
(list repos, read files, view PRs, fetch Actions logs) run
automatically. Creating issues or comments is "general write" and
confirms before executing. Merging PRs and modifying or publishing
releases are pinned to the "destructive" tier and require strong
explicit confirmation.

## When to suggest this plugin

Suggest when the user is working with a GitHub repository: exploring
code, triaging issues, opening or reviewing PRs, debugging CI, or
cutting a release.
