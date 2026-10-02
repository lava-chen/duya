/**
 * Renderer-level acceptance tests for Plan 582's UI track (G6 / G8 / G9).
 *
 * The IPC specs in this directory drive `window.electronAPI` directly, which
 * means they never touch the sidebar, the row menu, the confirm dialog or the
 * toast — i.e. every change Plan 582 made to the renderer was unverified.
 * These tests close that gap: same real Electron launch, but the assertions
 * are about what the user actually sees.
 *
 * What they pin down:
 *
 *   1. G9 — archiving is confirm-then-act, the dialog names the thread that
 *      was clicked, and Cancel is a TRUE no-op (nothing is archived, no row
 *      moves). Before the fix the menu item archived straight away.
 *   2. G9/G6 — confirming archives the thread, and the row lands in the
 *      Archived section carrying the `archived` class rather than vanishing.
 *   3. G6 — the archive section exposes a count and a "Restore all" action,
 *      and that action empties the section (empty sections are hidden entirely).
 *   4. G8 — the archive section is ordered by the shared recency comparator,
 *      NOT by the order the threads happened to be archived in. That is the
 *      actual G8 fix: this section used to render in raw `listArchived` order,
 *      so picking a different sort left it untouched.
 *   5. G8 — the chat header no longer advertises `Ctrl+Alt+R` / `Ctrl+Alt+S`.
 *      Those labels shipped with no handler anywhere in the repo, so they were
 *      a promise the app did not keep.
 *
 * One launch for the whole file (`mode: 'serial'`): Electron start-up is
 * ~10-30s and racing several launches against `webServer` is flaky.
 *
 * ── Why the renderer is primed by hand rather than by driving the UI ──────
 *
 * `e2e/helpers.ts` looks like it dismisses onboarding for us, but the guard
 * is `if (process.env.DUYA_TEST === '1')` read from the *Playwright runner*
 * process, while `DUYA_TEST=1` is only injected into the *Electron child*
 * env. Nothing exports it in the runner, so that block never runs and the
 * app comes up on the onboarding wizard. Left unhandled it does not merely
 * cover the sidebar: the conversation store never reaches `isHydrated`, so
 * `loadFromDatabase()` is never called and no thread row is ever rendered.
 *
 * The fix here mirrors `e2e/ipc/file-workspace.spec.ts`, the one spec in
 * this repo that already renders the shell successfully: seed localStorage
 * (`duya-onboarding-completed` + a `duya-conversations` blob) and reload.
 * `lastSyncAt: 0` is load-bearing twice over — it makes the store hydrate
 * from the seeded state, and it defeats the 30s staleness short-circuit in
 * `loadFromDatabase`, so the reload really re-reads SQLite.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchDuya, closeDuya, invokeApi, userDataRootFor, type DuyaApp } from '../helpers';

let dua: DuyaApp;

const ARCHIVED_SECTION = '.sidebar-section-kind-archived';
const ARCHIVE_CONFIRM = '[data-testid="archive-confirm"]';
const ARCHIVE_CONFIRM_OK = '[data-testid="archive-confirm-ok"]';
const RESTORE_ALL = '[data-testid="archive-restore-all"]';

const stamp = Date.now();

/** One seeded session, tracked by both id (DB assertions) and title (DOM). */
interface Seed {
  id: string;
  title: string;
}

const g9Cancel: Seed = { id: `ui-g9-cancel-${stamp}`, title: `G9 cancel ${stamp}` };
const g9Confirm: Seed = { id: `ui-g9-confirm-${stamp}`, title: `G9 confirm ${stamp}` };
const g6Second: Seed = { id: `ui-g6-second-${stamp}`, title: `G6 second ${stamp}` };
const g8Oldest: Seed = { id: `ui-g8-oldest-${stamp}`, title: `G8 oldest ${stamp}` };
const g8Middle: Seed = { id: `ui-g8-middle-${stamp}`, title: `G8 middle ${stamp}` };
const g8Newest: Seed = { id: `ui-g8-newest-${stamp}`, title: `G8 newest ${stamp}` };

/** A `db:session:get` row, as the renderer receives it. */
interface SessionRow {
  id: string;
  title: string;
  status: string;
  archived_at: number | null;
  archived_path: string | null;
}

/** The sidebar row for a thread title. */
function row(title: string) {
  return dua.page.locator(`.thread-item[title="${title}"]`);
}

/**
 * Wait until the app shell is actually interactive.
 *
 * Two traps this guards, both of which otherwise show up as a mysterious
 * "element not found" 15 seconds later:
 *
 *   - A Vite dev server owned by a *different* checkout. `playwright.config`
 *     reuses whatever already answers on :3000, and a tree whose workspace
 *     packages do not resolve serves a page whose React tree never mounts.
 *     `electronAPI` is still injected (the preload is per-webContents, not
 *     per-URL), so the usual "wait for the bridge" check passes happily.
 *   - The boot splash, a full-viewport `z-index: 99999` overlay. It swallows
 *     clicks on the sidebar even after the rows exist in the DOM.
 */
async function waitForInteractiveShell(): Promise<void> {
  await dua.page.waitForFunction(
    () => typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined',
    { timeout: 30_000 },
  );
  await dua.page.waitForFunction(
    () => {
      const overlay = document.querySelector('vite-error-overlay');
      if (overlay) {
        const text = (overlay.shadowRoot?.textContent ?? '').slice(0, 500);
        throw new Error(
          `Vite error overlay is covering the app, so React never mounted.\n${text}\n` +
            'This usually means a dev server from another checkout owns :3000 — ' +
            'e2e/playwright.config.ts reuses whatever already listens there.',
        );
      }
      return !!document.querySelector('.app-sidebar');
    },
    { timeout: 60_000 },
  );
  // Nothing may cover the sidebar while we click rows.
  await dua.page.waitForFunction(
    () => {
      const splash = document.querySelector('#duya-boot-splash');
      if (!splash) return true;
      const style = getComputedStyle(splash);
      return (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        splash.hasAttribute('data-hidden')
      );
    },
    { timeout: 60_000 },
  );
}

/**
 * Switch the sidebar to the "Work" tab.
 *
 * `app-sidebar.tsx` keeps the work/bots split in plain component state
 * (`useState<SidebarTab>("bots")` — it is not persisted), so on a cold
 * namespace the app comes up on the Bots tab. Every section this file
 * asserts on, the project tree and the archive roster included, only
 * renders under the Work tab. The tablist has no test id, so it is
 * addressed by its accessible name.
 */
async function showWorkTab(): Promise<void> {
  const workTab = dua.page.getByRole('tab', { name: 'Work' });
  await expect(workTab).toBeVisible();
  if ((await workTab.getAttribute('aria-selected')) !== 'true') {
    await workTab.click();
  }
  await expect(workTab).toHaveAttribute('aria-selected', 'true');
}

/** Open a row's `⋯` menu and click one of its items by visible label. */
async function openRowMenuAndPick(title: string, itemLabel: string): Promise<void> {
  const target = row(title);
  await target.hover();
  await target.locator('button.thread-item-menu-btn').click();
  // The menu is portaled to document.body, so it is not inside the row.
  const item = dua.page
    .locator('.sidebar-project-menu-item')
    .filter({ hasText: itemLabel })
    .first();
  await expect(item).toBeVisible();
  await item.click();
}

/** Archive a row through the real menu + confirm dialog. */
async function archiveThroughUi(title: string): Promise<void> {
  await openRowMenuAndPick(title, 'Archive Thread');
  const dialog = dua.page.locator(ARCHIVE_CONFIRM);
  await expect(dialog).toBeVisible();
  await dialog.locator(ARCHIVE_CONFIRM_OK).click();
  await expect(dialog).toBeHidden();
}

/**
 * Expand the Archived section if it is collapsed.
 *
 * The section renders collapsed by default and `SidebarSectionItem` only
 * mounts `.sidebar-section-body` while expanded — which includes the
 * "Restore all" row, because `app-sidebar` passes it as *children*, not
 * through the always-rendered `trailing` slot.
 */
async function expandArchivedSection(): Promise<void> {
  const section = dua.page.locator(ARCHIVED_SECTION);
  await expect(section).toHaveCount(1);
  if ((await section.getAttribute('data-section-collapsed')) === 'true') {
    await section.locator('.sidebar-section-header').click();
  }
  await expect(section.locator('.sidebar-section-body')).toBeVisible();
}

/** Titles rendered inside the Archived section, in DOM order. */
async function archivedRowTitles(): Promise<string[]> {
  await expandArchivedSection();
  return dua.page
    .locator(`${ARCHIVED_SECTION} .thread-item.archived`)
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('title') ?? ''));
}

async function rowOf(id: string): Promise<SessionRow> {
  return invokeApi<SessionRow>(dua.page, 'thread.get', id);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const namespace = 'ui-archive-582';
  // Same trap as the IPC specs: a namespace's `config.toml` persists in
  // `~/.duya/test-namespaces/<ns>/` and pins an absolute `database_path`, so
  // whichever checkout ran it first owns it. This spec owns this namespace.
  fs.rmSync(path.join(os.homedir(), '.duya', 'test-namespaces', namespace, 'config.toml'), {
    force: true,
  });
  fs.rmSync(userDataRootFor(namespace), { recursive: true, force: true });

  dua = await launchDuya({ namespace });

  // Pin the locale so the label assertions below are deterministic instead of
  // depending on whatever the host machine's language resolves to.
  await invokeApi(dua.page, 'settingsDb.set', 'locale', 'en');

  // Seed every thread up front, in one pass. `recency_at` is stamped from the
  // clock, so the G8 trio is created with deliberate gaps — otherwise three
  // creates inside the same millisecond tie, and the ordering assertion below
  // would be asserting tie-break behaviour instead of the sort itself.
  for (const seed of [g9Cancel, g9Confirm, g6Second, g8Oldest, g8Middle, g8Newest]) {
    await invokeApi(dua.page, 'thread.create', { id: seed.id, title: seed.title });
    await dua.page.waitForTimeout(25);
  }

  await dua.page.evaluate(() => {
    window.localStorage.setItem('duya-onboarding-completed', 'true');
    window.localStorage.setItem(
      'duya-conversations',
      JSON.stringify({
        state: {
          currentView: 'chat',
          settingsTab: 'general',
          activeThreadId: null,
          collapsedProjects: [],
          expandedThreads: [],
          // Defeats the 30s staleness short-circuit in `loadFromDatabase`.
          lastSyncAt: 0,
        },
        version: 0,
      }),
    );
  });

  await dua.page.reload({ waitUntil: 'domcontentloaded' });
  await waitForInteractiveShell();
  await showWorkTab();

  for (const seed of [g9Cancel, g9Confirm, g6Second, g8Oldest, g8Middle, g8Newest]) {
    await expect(row(seed.title)).toBeVisible();
  }
});

test.afterAll(async () => {
  if (dua) await closeDuya(dua.app);
});

test('G9: archiving asks first, and Cancel changes nothing', async () => {
  await openRowMenuAndPick(g9Cancel.title, 'Archive Thread');

  // The dialog names the row that was clicked, so the user can tell which
  // conversation they are about to file away.
  const dialog = dua.page.locator(ARCHIVE_CONFIRM);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(g9Cancel.title);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Cancel is a real no-op: the row never left, and the DB was never touched.
  const r = await rowOf(g9Cancel.id);
  expect(r.status).toBe('active');
  expect(r.archived_at).toBeNull();
  await expect(row(g9Cancel.title)).toBeVisible();
  await expect(dua.page.locator(ARCHIVED_SECTION)).toHaveCount(0);
});

test('G9+G6: confirming archives the thread and it appears under Archived', async () => {
  await archiveThroughUi(g9Confirm.title);

  const r = await rowOf(g9Confirm.id);
  expect(r.status).toBe('archived');
  expect(r.archived_at).not.toBeNull();

  // The row is in the Archived section, carrying the `archived` class the
  // dimmed styling keys off — not silently dropped from the sidebar.
  await expect(row(g9Confirm.title)).toHaveCount(0);
  await expandArchivedSection();
  const archivedRow = dua.page.locator(
    `${ARCHIVED_SECTION} .thread-item[title="${g9Confirm.title}"]`,
  );
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow).toHaveClass(/\barchived\b/);
});

test('G6: the archive section counts its rows and offers Restore all', async () => {
  await archiveThroughUi(g6Second.title);

  const section = dua.page.locator(ARCHIVED_SECTION);
  await expandArchivedSection();

  // g9Confirm (above) plus this one — g9Cancel was cancelled, so never counted.
  await expect(section).toContainText('2 archived');
  await expect(section.locator(RESTORE_ALL)).toBeVisible();

  // "Restore all" is the reversible direction, and it clears the whole roster
  // in one action instead of one row-menu round trip per session.
  await section.locator(RESTORE_ALL).click();

  // Empty sections are hidden entirely, so the section disappearing IS the
  // assertion that the archive is empty again.
  await expect(dua.page.locator(ARCHIVED_SECTION)).toHaveCount(0);
  for (const seed of [g9Confirm, g6Second]) {
    const r = await rowOf(seed.id);
    expect(r.status).toBe('active');
    expect(r.archived_path).toBeNull();
  }
});

test('G8: the archive section is ordered by recency, not by archive order', async () => {
  // Archive in an order that is deliberately NOT the recency order.
  for (const seed of [g8Oldest, g8Newest, g8Middle]) {
    await archiveThroughUi(seed.title);
  }

  // Recency DESC => newest, middle, oldest. An unsorted section would render
  // them oldest, newest, middle — i.e. the order they were archived in.
  const order = await archivedRowTitles();
  const relative = order
    .map((t) =>
      t === g8Newest.title ? 0 : t === g8Middle.title ? 1 : t === g8Oldest.title ? 2 : -1,
    )
    .filter((n) => n >= 0);
  expect(relative).toEqual([0, 1, 2]);
});

test('G8: the chat header no longer advertises shortcuts that do not exist', async () => {
  // Activate a session so the chat header is actually on screen — asserting
  // on an absent element would pass for the wrong reason.
  await row(g9Cancel.title).click();
  const header = dua.page.locator('.chat-header');
  await expect(header).toBeVisible();

  // Ctrl+Alt+R / Ctrl+Alt+S were rendered as labels on a menu that has never
  // had a handler anywhere in the repo. Whatever the header renders now, it
  // must not claim a chord the app does not handle.
  const text = (await header.innerText()) || '';
  expect(text).not.toMatch(/Ctrl\s*\+\s*Alt\s*\+\s*[RS]/i);
});
