# Pull Request Review

Review a GitHub pull request: read the diff, leave comments, suggest
changes, and approve or request changes. The goal is a focused,
actionable review the author can act on without a back-and-forth.

## When to use

- The user says "review PR #N" or "what do you think of this change?".
- You opened the chat inside a repo with an open PR and the user wants
  a second opinion.
- A `pull_request_review` event fired and Duya is configured to react.

## Process

1. `pull_requests.get` the PR metadata: title, body, base branch,
   head branch, draft state, mergeable state.
2. `pull_requests.get_diff` for the unified diff. If the diff is huge
   (>1 MB), narrow to specific files first via `repos.get_file_contents`
   on the changed paths.
3. Read the diff file-by-file. For each change, ask:
   - Does this fix the issue described in the PR body?
   - Are there missing tests?
   - Are there obvious correctness, security, or performance issues?
4. For each comment, decide:
   - **Inline** — ties the comment to a diff line. Use
     `pull_requests.create_review` with `comments` (preferred when the
     point is line-specific).
   - **Summary** — overall assessment. Put it in the review `body`.
5. Submit the review with one of `APPROVE`, `REQUEST_CHANGES`, or
   `COMMENT`. Default to `COMMENT` when you only have observations;
   reserve `REQUEST_CHANGES` for blocking issues.
6. Do not merge — that's the `destructive` tier and requires separate
   confirmation.

## Tool call patterns

- `pull_requests.get_diff` returns the raw unified diff. Parse hunk
  headers (`@@ ... @@`) to map comments to the right line numbers.
- `pull_requests.list_reviews` shows prior reviews — avoid
  duplicating comments an earlier reviewer already left.
- `pull_requests.list_comments` shows inline review comments; filter
  by `pull_request_review_id` if you only want top-level reviews.

## Confirmation boundary

- Reading PR metadata, diff, existing reviews: `read` tier, automatic.
- Submitting a review (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`):
  `write` tier, confirm. Show the proposed review body and inline
  comments to the user before submitting.
- Merging the PR: `destructive` tier, strong explicit confirmation.
  This skill never merges; hand off to the user or a separate
  approval step.

## Pitfalls

- Comments on outdated diff hunks fail silently. Always check the
  `position` field against the latest diff before submitting.
- Large diffs are easier to triage by file group than by hunk order.
  Group comments by file in the summary body.
- Approving a PR blocks the author's own review request — only approve
  when the user explicitly asked.
