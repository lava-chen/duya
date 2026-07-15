import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

interface ConductorCanvas {
  id: string;
  name: string;
  description: string | null;
}

async function getCanvasId(page: any): Promise<string> {
  const list = await invokeApi<ConductorCanvas[]>(page, 'conductor.listCanvases');
  expect(list.length).toBeGreaterThan(0);
  return list[0].id;
}

async function deleteAllElements(page: any, canvasId: string): Promise<void> {
  interface Snap { elements: Array<{ id: string }> }
  const snap = await invokeApi<Snap | null>(page, 'conductor.snapshot', canvasId);
  if (!snap) return;
  for (const el of snap.elements ?? []) {
    await invokeApi(page, 'conductor.action', {
      action: 'element.delete',
      elementId: el.id,
      canvasId,
    });
  }
}

test.describe.serial('Conductor pan and zoom', () => {
  let app: DuyaApp;
  let canvasId: string;

  test.beforeAll(async () => {
    app = await launchDuya({ namespace: 'cond-panzoom' });
    const { page } = app;
    // Dismiss onboarding overlay so the main UI (and canvas) is interactive.
    // Onboarding reads localStorage; mark it complete and reload so the main UI mounts.
    await page.evaluate(() => {
      localStorage.setItem('duya-onboarding-completed', 'true');
    });
    await page.reload();
    await page.waitForFunction(
      () => typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined',
      { timeout: 30_000 },
    );
    // open conductor panel via nav button if present
    try {
      await page.waitForSelector('[data-testid="nav-conductor"]', { timeout: 20_000 });
      await page.click('[data-testid="nav-conductor"]', { timeout: 5_000 }).catch(() => {});
    } catch {
      // fallback: panel might already be open
    }
    canvasId = await getCanvasId(page);
    await deleteAllElements(page, canvasId);
  });

  test.afterAll(async () => {
    if (app) await closeDuya(app.app);
  });

  test('canvas responds to Ctrl+wheel zoom', async () => {
    const { page } = app;
    const canvasArea = page.locator('.canvas-area').first();
    await expect(canvasArea).toBeVisible({ timeout: 10_000 });

    // Ensure at least one element so overlay is present
    await invokeApi(page, 'conductor.action', {
      action: 'element.create_native',
      canvasId,
      nodeType: 'sticky',
      position: { x: 10, y: 10, w: 3, h: 3, zIndex: 0, rotation: 0 },
      content: { text: 'zoom probe', color: 'yellow', fontSize: 14 },
      style: {},
    });
    await page.waitForTimeout(300);

    const before = await canvasArea.evaluate(() => {
      // @ts-ignore
      return (window as any).canvasTransformState || { zoom: 1, panX: 0, panY: 0 };
    });

    await canvasArea.dispatchEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
    });
    await page.waitForTimeout(200);

    const after = await canvasArea.evaluate(() => {
      // @ts-ignore
      return (window as any).canvasTransformState || { zoom: 1, panX: 0, panY: 0 };
    });

    const wheelLog = await canvasArea.evaluate(() => (window as any).__canvasAreaWheelLog);
    // eslint-disable-next-line no-console
    console.log('PAN-ZOOM WHEEL REPORT', JSON.stringify({ before, after, wheelLog }, null, 2));

    expect(after.zoom).toBeGreaterThan(before.zoom + 0.05);
  });

  test('canvas responds to middle-button drag pan', async () => {
    const { page } = app;
    const canvasArea = page.locator('.canvas-area').first();
    await expect(canvasArea).toBeVisible({ timeout: 10_000 });

    const box = await canvasArea.boundingBox();
    expect(box).toBeTruthy();
    const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

    const before = await canvasArea.evaluate(() => {
      // @ts-ignore
      return (window as any).canvasTransformState || { zoom: 1, panX: 0, panY: 0 };
    });

    // Inject a global mousedown logger to verify the middle-click reaches the page.
    await page.evaluate(() => {
      (window as any).__globalMouseDownLog = [];
      window.addEventListener('mousedown', (e) => {
        (window as any).__globalMouseDownLog.push({
          button: e.button,
          clientX: e.clientX,
          clientY: e.clientY,
          targetTag: (e.target as HTMLElement)?.tagName,
          targetClass: (e.target as HTMLElement)?.className,
        });
      }, { once: false });
    });

    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(start.x + 80, start.y + 60, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(200);

    const after = await canvasArea.evaluate(() => {
      // @ts-ignore
      return (window as any).canvasTransformState || { zoom: 1, panX: 0, panY: 0 };
    });

    const panLog = await canvasArea.evaluate(() => (window as any).__canvasAreaPanLog);
    const mouseDownLog = await canvasArea.evaluate(() => (window as any).__canvasAreaMouseDownLog);
    const globalMouseDownLog = await canvasArea.evaluate(() => (window as any).__globalMouseDownLog);
    // eslint-disable-next-line no-console
    console.log('PAN DRAG REPORT', JSON.stringify({ start, before, after, panLog, mouseDownLog, globalMouseDownLog }, null, 2));

    const dx = after.panX - before.panX;
    const dy = after.panY - before.panY;
    expect(Math.hypot(dx, dy)).toBeGreaterThan(30);
  });
});
