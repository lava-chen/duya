# Repository Exploration

Quickly orient in any GitHub repository: structure, code location,
history. Use this skill as the entry point before any deeper GitHub
work — it builds the mental map every later skill depends on.

## When to use

- The user points at a repo they have never opened in chat before.
- You need to find "where does X live in this codebase?".
- A follow-up skill (`issue-to-implementation`, `fix-ci`) needs the
  layout before it can act.

## Process

1. Call `repos.get` to confirm the repo exists and read its default
   branch + description.
2. List the top-level tree with `repos.get_file_contents` on the
   root path. Do not recurse blindly; large repos blow up the response.
3. Identify the entrypoints: `package.json` / `Cargo.toml` / `go.mod` /
   `pyproject.toml` / `README.md`. Read these before reading source.
4. Map the directory structure two levels deep, then narrow to the
   area the user asked about.
5. For history questions, use `repos.list_commits` with a path filter
   rather than `git log` — the MCP server already paginates.

## Tool call patterns

- `repos.get_file_contents(path=".")` first, then drill in by path.
  Never call `list` on a deep path without confirming the parent.
- For "who touched this file?", `repos.list_commits(path="...")` with
  a `sha` of the default branch.
- For branch inventory, `repos.list_branches` is cheap; do not call
  `list_tags` unless release-cutting is on the table.

## Confirmation boundary

All tools in this skill are `read` tier and run automatically. Do not
clone the repo into the workspace just to read it — the MCP server is
faster and avoids leaving artifacts behind.

## Pitfalls

- `repos.get_file_contents` on a directory returns a tree listing, not
  file contents. Read each file separately.
- Binary files are returned base64-encoded; skip them unless the user
  explicitly asked.
- Large monorepos have shallow default branches. Check
  `repos.get.default_branch` before assuming `main`.
