---
name: github
description: Use duya against a connected GitHub account via the official GitHub remote MCP endpoint. Inspect repositories, triage pull requests and issues, debug failing CI checks, and prepare code changes for review. Trigger on any mention of GitHub, a repository, pull request, issue, failing CI check, or requests to triage, review, or publish changes. Requires the GitHub app connection to be authorized.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# GitHub

Work with the user's connected GitHub account. High-level operations go
through the official GitHub remote MCP tools, exposed to the agent as
`remote_github_*` (e.g. `remote_github_search_issues`,
`remote_github_list_pull_requests`, `remote_github_get_issue`). These tools
only appear when the GitHub app connection is authorized. Local `git` and `gh`
cover the gaps the remote MCP does not — current-branch discovery, branch
creation, commit and push, `gh auth status`, and Actions log inspection.

## Duya capability binding

- The connector is the official GitHub remote MCP endpoint
  (`https://api.githubcopilot.com/mcp`) managed by duya's app-connection
  system.
- Tools are named `remote_github_<tool>` and are discoverable via
  `tool_search`.
- If no `remote_github_*` tool is available, the GitHub connection is not
  authorized — tell the user to connect GitHub in the app connection settings.

## Connect first

If the `remote_github_*` tools are absent, do not guess. Ask the user to
authorize the GitHub connection (app connection settings → GitHub → Connect),
then retry. Tools appear after the connection is established.

## Operating intent

Resolve the operating context before acting:

1. If the user provides a repository, PR number, issue number, or URL, use
   that.
2. If the request is about "this branch" or "the current PR", resolve local
   git context and use `gh` only as needed to discover the branch PR.
3. If the repository is still ambiguous after local inspection, ask for the
   repo identifier.

## Workflow

1. **Resolve scope.** Identify the repository and item (repo, PR, issue, or
   local checkout) before acting.
2. **Gather context.** Use the `remote_github_*` tools to fetch structured
   PR, issue, or repository data.
3. **Classify the request** before taking action:
   - `repo or PR triage`: summarize PRs, issues, patches, comments, labels,
     reactions, or repository state
   - `review follow-up`: unresolved review threads, requested changes, or
     inline review feedback
   - `CI debugging`: failing checks, Actions logs, or CI root-cause analysis
   - `publish changes`: create or switch branches, stage changes, commit,
     push, and open a draft PR
4. **Split the work source.** Prefer the GitHub MCP tools for PR, issue, and
   repository data. Use local `git` and `gh` for current-branch PR discovery,
   branch creation, commit/push, `gh auth status`, and GitHub Actions log
   inspection — the connector does not expose Actions logs.
5. **Verify.** After a write (comment, label, reaction, PR creation), confirm
   the target and result before finishing.

## Guardrails

- If the repository is not already identifiable from the user request or local
  git context, ask for the repo instead of pretending there is a repo-search
  flow.
- For connector-backed write actions, restate the exact PR, issue, label, or
  reaction target before applying the change.
- Never imply that GitHub Actions logs are available through the connector
  alone; that remains a `gh` workflow.

## Output standards

- For triage requests, return a concise summary of the repository, PR, or
  issue state and the next likely action.
- For writes, report what was changed and the resulting PR, issue, or
  reference.
- If the connection is unauthorized, name that exact gate and ask the user to
  connect GitHub.