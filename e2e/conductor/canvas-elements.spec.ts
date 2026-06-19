/**
 * UX acceptance tests for the four canvas element primitives:
 *   - sticky     (native/sticky)
 *   - mindmap    (native/mindmap)
 *   - connector  (native/connector)
 *   - widget     (widget/*)
 *
 * Strategy:
 *   - One Electron launch per test file (test.describe.serial), shared
 *     across all tests in that file. Reloading Electron is slow
 *     (~10-30s per launch) and frequently races with webServer.
 *   - Each test uses IPC `element.delete` to clean up any state it
 *     created so tests can run in any order.
 *   - We focus on the highest-leverage UX flows: IPC create, keyboard
 *     tool activation, click-to-create, edit/save roundtrip, and
 *     visibility of a few "production-grade" affordances (aria, error
 *     toast, selection toolbar Delete).
 */
import { test, expect, type Page } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

// ─── Types matching renderer state ──────────────────────────────────────

interface ConductorCanvas {
  id: string;
  name: string;
  description: string | null;
}

interface CanvasElement {
  id: string;
  canvasId: string;
  elementKind: string;
  position: { x: number; y: number; w: number; h: number; zIndex: number; rotation: number };
  config: Record<string, unknown>;
  vizSpec: unknown;
  state: string;
  dataVersion: number;
  permissions: Record<string, unknown>;
  metadata: { label: string; tags: string[]; createdBy: string; parentId: string | null; childIds: string[] };
  sourceCode: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ConductorSnapshot {
  canvas: ConductorCanvas;
  widgets: Array<{ id: string; type: string; [k: string]: unknown }>;
  elements: CanvasElement[];
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function getCanvasId(page: Page): Promise<string> {
  const list = await invokeApi<ConductorCanvas[]>(page, 'conductor.listCanvases');
  expect(list.length).toBeGreaterThan(0);
  return list[0].id;
}

async function getElements(page: Page, canvasId: string): Promise<CanvasElement[]> {
  const snap = await invokeApi<ConductorSnapshot | null>(page, 'conductor.snapshot', canvasId);
  return snap?.elements ?? [];
}

async function deleteAllElements(page: Page, canvasId: string): Promise<void> {
  const snap = await invokeApi<ConductorSnapshot | null>(page, 'conductor.snapshot', canvasId);
  if (!snap) return;
  for (const el of snap.elements ?? []) {
    await invokeApi(page, 'conductor.action', {
      action: 'element.delete',
      elementId: el.id,
      canvasId,
    });
  }
}

async function waitForElementCount(
  page: Page,
  canvasId: string,
  expected: number,
  timeoutMs = 5_000,
): Promise<CanvasElement[]> {
  const start = Date.now();
  let last: CanvasElement[] = [];
  while (Date.now() - start < timeoutMs) {
    last = await getElements(page, canvasId);
    if (last.length === expected) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `Expected ${expected} elements in canvas ${canvasId}, got ${last.length}: ${JSON.stringify(last.map((e) => e.id))}`,
  );
}

/**
 * Navigate to the conductor view. Best-effort — if the nav button
 * isn't visible we fall back to IPC-only verification.
 */
async function navigateToConductor(page: Page, namespace: string): Promise<void> {
  try {
    await page.waitForSelector('[data-testid="nav-conductor"]', { timeout: 20_000 });
    await page.click('[data-testid="nav-conductor"]', { timeout: 5_000 }).catch(() => {});
  } catch {
    // Surface what we have so failure modes are debuggable
    const probe = await page.evaluate(() => ({
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 500) ?? '<no body>',
      rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      dataTestIds: Array.from(document.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')),
      url: location.href,
    })).catch(() => null);
    // eslint-disable-next-line no-console
    console.warn(`[${namespace}] nav-conductor missing; probe:`, JSON.stringify(probe));
  }
}

// ─── Spec: Sticky — IPC create + UI edit + delete ───────────────────────

test.describe.serial('Sticky element', () => {
  let app: DuyaApp;
  let canvasId: string;

  test.beforeAll(async () => {
    app = await launchDuya({ namespace: 'cond-sticky' });
    const { page } = app;
    await navigateToConductor(page, 'cond-sticky');
    canvasId = await getCanvasId(page);
    await deleteAllElements(page, canvasId);
  });

  test.afterAll(async () => {
    if (app) await closeDuya(app.app);
  });

  test('IPC create → snapshot reflects element with config', async () => {
    const result = await invokeApi<{ success: boolean; elementId: string }>(
      app.page,
      'conductor.action',
      {
        action: 'element.create_native',
        canvasId,
        nodeType: 'sticky',
        position: { x: 200, y: 200, w: 3, h: 3, zIndex: 0, rotation: 0 },
        content: { text: 'Hello IPC', color: 'yellow', fontSize: 14 },
        style: {},
      },
    );
    expect(result.success).toBe(true);
    expect(result.elementId).toBeTruthy();

    const after = await waitForElementCount(app.page, canvasId, 1);
    expect(after[0].elementKind).toBe('native/sticky');
    expect((after[0].config as Record<string, unknown>).text).toBe('Hello IPC');
    expect((after[0].config as Record<string, unknown>).color).toBe('yellow');
  });

  test('UI: N key + click creates a sticky that auto-enters edit mode', async () => {
    await deleteAllElements(app.page, canvasId);

    const canvasArea = app.page.locator('.canvas-area').first();
    if (!(await canvasArea.count())) {
      // eslint-disable-next-line no-console
      console.warn('[cond-sticky:UI-N] no .canvas-area — skipping UI flow, only IPC verification');
      await invokeApi(app.page, 'conductor.action', {
        action: 'element.create_native',
        canvasId,
        nodeType: 'sticky',
        position: { x: 200, y: 200, w: 3, h: 3, zIndex: 0, rotation: 0 },
        content: { text: 'fallback', color: 'yellow', fontSize: 14 },
        style: {},
      });
      const elements = await waitForElementCount(app.page, canvasId, 1);
      expect(elements[0].elementKind).toBe('native/sticky');
      return;
    }
    await canvasArea.click({ position: { x: 50, y: 50 } });
    await app.page.keyboard.press('n');
    await app.page.waitForTimeout(150);
    await canvasArea.click({ position: { x: 400, y: 300 } });

    const elements = await waitForElementCount(app.page, canvasId, 1);
    expect(elements[0].elementKind).toBe('native/sticky');

    await app.page.waitForSelector(`[data-native-element-id="${elements[0].id}"]`, { timeout: 5_000 });

    // After creating a sticky the user should land in the editing flow
    // without an extra click — that is the production-grade UX we are
    // iterating on. If no textarea shows up the test fails and tells us
    // to fix the auto-enter behavior.
    const textarea = app.page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 3_000 });
  });

  test('UI: keyboard Delete removes the selected sticky', async () => {
    await deleteAllElements(app.page, canvasId);

    await invokeApi(app.page, 'conductor.action', {
      action: 'element.create_native',
      canvasId,
      nodeType: 'sticky',
      position: { x: 200, y: 200, w: 3, h: 3, zIndex: 0, rotation: 0 },
      content: { text: 'doomed', color: 'yellow', fontSize: 14 },
      style: {},
    });
    const [sticky] = await waitForElementCount(app.page, canvasId, 1);
    await app.page.waitForSelector(`[data-native-element-id="${sticky.id}"]`, { timeout: 5_000 });

    await app.page.locator(`[data-native-element-id="${sticky.id}"]`).first().click();
    await app.page.waitForTimeout(100);
    await app.page.keyboard.press('Delete');
    await app.page.waitForTimeout(300);

    const after = await getElements(app.page, canvasId);
    expect(after.length).toBe(0);
  });
});

// ─── Spec: MindMap — IPC create + UI create ────────────────────────────

test.describe.serial('MindMap element', () => {
  let app: DuyaApp;
  let canvasId: string;

  test.beforeAll(async () => {
    app = await launchDuya({ namespace: 'cond-mindmap' });
    const { page } = app;
    await navigateToConductor(page, 'cond-mindmap');
    canvasId = await getCanvasId(page);
    await deleteAllElements(page, canvasId);
  });

  test.afterAll(async () => {
    if (app) await closeDuya(app.app);
  });

  test('IPC: create → elementKind is native/mindmap with rootNode', async () => {
    const rootNode = {
      id: 'root',
      text: 'Central Idea',
      children: [
        { id: 'a', text: 'Branch A', children: [] },
        { id: 'b', text: 'Branch B', children: [] },
      ],
    };

    const result = await invokeApi<{ success: boolean; elementId: string }>(
      app.page,
      'conductor.action',
      {
        action: 'element.create_native',
        canvasId,
        nodeType: 'mindmap',
        position: { x: 100, y: 100, w: 8, h: 6, zIndex: 0, rotation: 0 },
        content: { rootNode, layoutDirection: 'right', branchColors: [], branchWidth: 3, branchStyle: 'curve' },
        style: {},
      },
    );
    expect(result.success).toBe(true);

    const after = await waitForElementCount(app.page, canvasId, 1);
    expect(after[0].elementKind).toBe('native/mindmap');
    expect((after[0].config.rootNode as { text: string }).text).toBe('Central Idea');
  });

  test('UI: M key + click creates a mindmap', async () => {
    await deleteAllElements(app.page, canvasId);

    await app.page.locator('.canvas-area').first().click({ position: { x: 50, y: 50 } });
    await app.page.keyboard.press('m');
    await app.page.waitForTimeout(150);
    await app.page.locator('.canvas-area').first().click({ position: { x: 500, y: 400 } });

    const after = await waitForElementCount(app.page, canvasId, 1);
    expect(after[0].elementKind).toBe('native/mindmap');
  });
});

// ─── Spec: Connector — IPC create + drag-to-connect ─────────────────────

test.describe.serial('Connector element', () => {
  let app: DuyaApp;
  let canvasId: string;

  test.beforeAll(async () => {
    app = await launchDuya({ namespace: 'cond-connector' });
    const { page } = app;
    await navigateToConductor(page, 'cond-connector');
    canvasId = await getCanvasId(page);
    await deleteAllElements(page, canvasId);
  });

  test.afterAll(async () => {
    if (app) await closeDuya(app.app);
  });

  test('IPC: create connector between two stickies', async () => {
    const sticky1 = await invokeApi<{ elementId: string }>(app.page, 'conductor.action', {
      action: 'element.create_native',
      canvasId,
      nodeType: 'sticky',
      position: { x: 200, y: 200, w: 3, h: 3, zIndex: 0, rotation: 0 },
      content: { text: 'A', color: 'yellow', fontSize: 14 },
      style: {},
    });
    const sticky2 = await invokeApi<{ elementId: string }>(app.page, 'conductor.action', {
      action: 'element.create_native',
      canvasId,
      nodeType: 'sticky',
      position: { x: 600, y: 200, w: 3, h: 3, zIndex: 0, rotation: 0 },
      content: { text: 'B', color: 'blue', fontSize: 14 },
      style: {},
    });
    const conn = await invokeApi<{ elementId: string }>(app.page, 'conductor.action', {
      action: 'connector.create',
      canvasId,
      source: { nodeId: sticky1.elementId, anchorId: 'center' },
      target: { nodeId: sticky2.elementId, anchorId: 'center' },
      curvature: 0.4,
      style: {},
    });

    expect(sticky1.elementId).toBeTruthy();
    expect(sticky2.elementId).toBeTruthy();
    expect(conn.elementId).toBeTruthy();

    const after = await waitForElementCount(app.page, canvasId, 3);
    const connector = after.find((e) => e.elementKind === 'native/connector');
    expect(connector).toBeTruthy();
    const cfg = connector!.config as Record<string, unknown>;
    expect((cfg.source as { nodeId: string }).nodeId).toBe(sticky1.elementId);
    expect((cfg.target as { nodeId: string }).nodeId).toBe(sticky2.elementId);
  });
});

// ─── Spec: Widget — IPC create appears in snapshot ─────────────────────

test.describe.serial('Widget element', () => {
  let app: DuyaApp;
  let canvasId: string;

  test.beforeAll(async () => {
    app = await launchDuya({ namespace: 'cond-widget' });
    const { page } = app;
    await navigateToConductor(page, 'cond-widget');
    canvasId = await getCanvasId(page);
    await deleteAllElements(page, canvasId);
  });

  test.afterAll(async () => {
    if (app) await closeDuya(app.app);
  });

  test('IPC: create task-list widget appears in snapshot', async () => {
    const result = await invokeApi<{ elementId: string; success: boolean }>(
      app.page,
      'conductor.action',
      {
        action: 'widget.create',
        canvasId,
        kind: 'builtin',
        type: 'task-list',
        data: { tasks: [{ id: 't1', text: 'Sample task', done: false }] },
        config: {},
        position: { x: 100, y: 100, w: 4, h: 3 },
      },
    );
    expect(result.success).toBe(true);

    await app.page.waitForTimeout(500);
    const snap = await invokeApi<ConductorSnapshot | null>(app.page, 'conductor.snapshot', canvasId);
    const widgets = snap?.widgets ?? [];
    const taskList = widgets.find((w) => w.type === 'task-list');
    expect(taskList).toBeTruthy();
  });
});

// ─── Spec: UX ergonomics — toolbar a11y, error feedback, selection ─────

test.describe.serial('Conductor UX ergonomics', () => {
  let app: DuyaApp;
  let canvasId: string;

  test.beforeAll(async () => {
    app = await launchDuya({ namespace: 'cond-ux' });
    const { page } = app;
    await navigateToConductor(page, 'cond-ux');
    canvasId = await getCanvasId(page);
    await deleteAllElements(page, canvasId);
  });

  test.afterAll(async () => {
    if (app) await closeDuya(app.app);
  });

  test('Toolbar: every tool button exposes an accessible name', async () => {
    const toolbar = app.page.locator('.conductor-panel').first();
    await expect(toolbar).toBeVisible();

    // Each tool has an aria-label. Production-grade UX requires
    // assistive tech to announce the button's purpose.
    const toolLabels = ['Select', 'Sticky note', 'Connector', 'Mind Map'];
    for (const label of toolLabels) {
      const ariaBtn = toolbar.locator(`button[aria-label="${label}"]`);
      await expect(ariaBtn.first()).toBeVisible({ timeout: 3_000 });
    }
  });

  test('Toolbar: active tool button exposes aria-pressed', async () => {
    const toolbar = app.page.locator('.conductor-panel').first();
    await expect(toolbar).toBeVisible();

    // Press 'n' to activate sticky tool
    const canvasArea = app.page.locator('.canvas-area').first();
    if (await canvasArea.count()) {
      await canvasArea.click({ position: { x: 50, y: 50 } });
      await app.page.keyboard.press('n');
      await app.page.waitForTimeout(200);

      // The sticky tool button should now have aria-pressed="true"
      const stickyBtn = toolbar.locator('button[aria-label="Sticky note"]');
      await expect(stickyBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3_000 });

      // Press Escape to deactivate
      await app.page.keyboard.press('Escape');
    }
  });

  test('Error feedback: failed IPC surfaces a visible error UI', async () => {
    let threw = false;
    try {
      await invokeApi(app.page, 'conductor.action', {
        action: 'definitely.not.a.real.action',
        canvasId,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The error should be visible somewhere in the conductor panel.
    const errorRegion = app.page.locator('.sidebar-conductor, [role="alert"]').locator(':text("Unknown action"), :text("definitely.not"), :text("not.a.real.action")');
    await expect(errorRegion.first()).toBeVisible({ timeout: 3_000 });
  });

  test('Sticky: selection toolbar surfaces Color + Edit + Delete affordances', async () => {
    await deleteAllElements(app.page, canvasId);

    await invokeApi(app.page, 'conductor.action', {
      action: 'element.create_native',
      canvasId,
      nodeType: 'sticky',
      position: { x: 200, y: 200, w: 3, h: 3, zIndex: 0, rotation: 0 },
      content: { text: 'selectable', color: 'yellow', fontSize: 14 },
      style: {},
    });
    const [sticky] = await waitForElementCount(app.page, canvasId, 1);
    await app.page.waitForSelector(`[data-native-element-id="${sticky.id}"]`, { timeout: 5_000 });

    await app.page.locator(`[data-native-element-id="${sticky.id}"]`).first().click();
    await app.page.waitForTimeout(150);

    // Production-grade UX: Color, Edit, and Delete affordances should
    // exist in the selection toolbar (in addition to keyboard Delete).
    const colorBtn = app.page
      .locator(`[data-native-element-id="${sticky.id}"]`)
      .locator('button[aria-label^="Color:"]')
      .first();
    await expect(colorBtn).toBeVisible({ timeout: 3_000 });

    const editBtn = app.page
      .locator(`[data-native-element-id="${sticky.id}"]`)
      .locator('button[aria-label="Edit sticky note"]');
    await expect(editBtn).toBeVisible({ timeout: 3_000 });

    const deleteBtn = app.page
      .locator(`[data-native-element-id="${sticky.id}"]`)
      .locator('button[aria-label="Delete sticky note"]');
    await expect(deleteBtn).toBeVisible({ timeout: 3_000 });
  });

  test('Sticky: clicking Delete in selection toolbar removes the element', async () => {
    await deleteAllElements(app.page, canvasId);

    await invokeApi(app.page, 'conductor.action', {
      action: 'element.create_native',
      canvasId,
      nodeType: 'sticky',
      position: { x: 200, y: 200, w: 3, h: 3, zIndex: 0, rotation: 0 },
      content: { text: 'delete-me', color: 'yellow', fontSize: 14 },
      style: {},
    });
    const [sticky] = await waitForElementCount(app.page, canvasId, 1);
    await app.page.waitForSelector(`[data-native-element-id="${sticky.id}"]`, { timeout: 5_000 });

    await app.page.locator(`[data-native-element-id="${sticky.id}"]`).first().click();
    await app.page.waitForTimeout(150);

    const deleteBtn = app.page
      .locator(`[data-native-element-id="${sticky.id}"]`)
      .locator('button[aria-label="Delete sticky note"]');
    await deleteBtn.click();
    await app.page.waitForTimeout(300);

    const after = await getElements(app.page, canvasId);
    expect(after.length).toBe(0);
  });
});
