# Code Review Workspace

The Code Review sidebar page lets a user read the diff of the current working tree
without touching Git state.

- Sidebar page: `packages/ui/src/components/layout/panels/CodeReviewPanel.tsx`; register it
  through `packages/ui/src/components/layout/panels/registry.ts` and pass the session working
  directory from `packages/ui/src/components/layout/PanelZone.tsx`.
- Scope is always `HEAD` to the current working tree. It is read-only: never add stage,
  commit, push, reset, or other mutating Git controls here.
- Bridge contract: `git:review` lists porcelain status plus numstat totals; `git:review-diff`
  returns the selected patch. Keep renderer shapes in `packages/ui/src/lib/git-ipc.ts`
  synchronized with `apps/desktop/src/preload/index.ts` and
  `apps/desktop/src/main/ipc/git-handlers.ts`.
- Security boundary: accept only changed, project-relative paths; reject absolute paths,
  traversal, `.git` metadata, and untracked symlinks resolving outside the workspace. Keep
  diff output bounded at 1 MB and retain safe partial output when the child-process buffer is
  exhausted.
- UI contract: changed-file filter/tree, unified diff by default, split diff only in expanded
  mode, optional context folding and wrapping, and hand off the selected file through the
  existing chat attachment event.
- Line comments (plan 572): the toolbar's 预览 toggle renders a single file via
  `code-review-code-viewer.tsx` (`@pierre/diffs`) where hover/click on lines attaches
  comments. Comments live in `packages/ui/src/lib/code-comment-store.ts` (bucketed per
  workspace); the composer strip reads the same store and injects pending ones as a
  `# Code comments:` block on send.
- Verify parser behavior in
  `packages/ui/src/components/layout/panels/code-review-diff.test.ts`, bridge behavior in
  `apps/desktop/src/main/ipc/__tests__/git-handlers.test.ts`, then exercise the panel in a
  real Electron renderer; browser-only Vite cannot validate the preload path.
