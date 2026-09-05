# Plan 413 — IPC path-safety hardening (P0 from security audit)

## Background

`electron/services/security.ts` covers S001–S012 but does not audit IPC
handlers that take external paths. Five handlers accept a renderer-supplied
path and operate on the host filesystem with no root-anchor validation:

| Handler | File | Issue |
|---|---|---|
| `files:delete` | `electron/ipc/files-handlers.ts:267` | recursive `rmdirSync(resolvedPath)` on any directory |
| `files:rename` | `electron/ipc/files-handlers.ts:293` | `renameSync` on any file/folder |
| `files:browse` | `electron/ipc/files-handlers.ts:149` | `readdirSync` on any directory |
| `files:preview` standalone | `electron/ipc/files-handlers.ts:174` | bypasses root check via `options.standalone` |
| `db:relocateDatabase` | `electron/ipc/db-handlers.ts:153` | `copyFileSync` to arbitrary `newDir` |

All five are exposed to the renderer via `electron/preload.ts:2075-2079` and
would be reachable from any compromised renderer (XSS, malicious skill,
rogue extension). All five already have a ready-to-use analogue that DOES
validate: `git-handlers.ts:202 resolveReviewPath` and
`services/computer-use-capture-store.ts:43 SAFE_SEGMENT_RE`.

## Checklist

- [ ] Make `rootPath` required on `files:browse / files:delete / files:rename`; reject when missing or invalid; gate with `isInsideRoot` (already exists in `files-handlers.ts:62`).
- [ ] Tighten `files:preview` standalone mode: require `realpathSync` chain to stay inside `app.getPath('home')` so it cannot escape user-writable areas, and keep the existing size cap.
- [ ] Restrict `db:relocateDatabase` `newDir` to a sub-directory of `app.getPath('userData')` (or its parent); reject symbolic links.
- [ ] Update `electron/preload.ts` `FilesAPI` to require `rootPath` on `browse / delete / rename`; update 4 renderer callers (`FileTreePanel`, `ExtensionsPage`, `SkillsSection`, `DocumentCreateDialog`).
- [ ] Update tests in `electron/ipc/__tests__/files-handlers.test.ts` to cover: rejection without `rootPath`, rejection when target is outside `rootPath`, acceptance when target is inside.
- [ ] Add tests for `db:relocateDatabase` new-dir validation.
- [ ] Add audit entries S013 (IPC handler path validation) and S014 (relocate destination whitelist) to `electron/services/security.ts` so future regressions get caught.
- [ ] Update `ARCHITECTURE.md` IPC-security section to record the root-anchor contract.

## Verification

- `npm run typecheck:all` (or at minimum typecheck of `electron/` + `src/`).
- `npx vitest run electron/ipc/__tests__/files-handlers.test.ts` and any new test files.
- Manual: launch the desktop app, open FileTreePanel against a workspace, attempt to browse/delete a path outside the workspace, attempt to relocate the DB to `/tmp` (should fail).

## Out of scope (separate plans)

- Extracting a shared `path-safety.ts` module — consider after the rule stabilizes.
- IPC handlers that take paths but already validate (git, hooks, memory, computer-use) — already covered.
- Renderer-side second confirm dialog before destructive ops — UX improvement, separate plan.
