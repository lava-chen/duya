import { expect, test, type Page } from '@playwright/test';
import { closeDuya, invokeApi, launchDuya, type DuyaApp } from '../helpers';

interface ConductorCanvas {
  id: string;
  layoutConfig: Record<string, unknown>;
}

interface CanvasElement {
  id: string;
  elementKind: string;
  position: { x: number; y: number; w: number; h: number; zIndex: number; rotation: number };
}

interface ConductorSnapshot {
  canvas: ConductorCanvas;
  elements: CanvasElement[];
}

async function openConductor(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('duya-onboarding-completed', 'true'));
  await page.reload();
  await page.waitForFunction(
    () => typeof (window as unknown as { electronAPI?: unknown }).electronAPI !== 'undefined',
    { timeout: 30_000 },
  );
  await page.getByTestId('nav-conductor').click();
}

async function firstCanvasId(page: Page): Promise<string> {
  await expect.poll(async () => {
    const canvases = await invokeApi<ConductorCanvas[]>(page, 'conductor.listCanvases');
    return canvases.length;
  }).toBeGreaterThan(0);
  const canvases = await invokeApi<ConductorCanvas[]>(page, 'conductor.listCanvases');
  return canvases[0].id;
}

async function clearCanvas(page: Page, canvasId: string): Promise<void> {
  const snapshot = await invokeApi<ConductorSnapshot | null>(page, 'conductor.snapshot', canvasId);
  for (const element of snapshot?.elements ?? []) {
    await invokeApi(page, 'conductor.action', {
      action: 'element.delete',
      elementId: element.id,
      canvasId,
    });
  }
}

async function createNativeElement(
  page: Page,
  canvasId: string,
  nodeType: string,
  position: CanvasElement['position'],
  content: Record<string, unknown>,
): Promise<string> {
  const result = await invokeApi<{ success: boolean; elementId: string }>(page, 'conductor.action', {
    action: 'element.create_native',
    canvasId,
    nodeType,
    position,
    content,
    style: {},
  });
  expect(result.success).toBe(true);
  return result.elementId;
}

async function createDocumentElement(page: Page, canvasId: string): Promise<string> {
  const result = await invokeApi<{ success: boolean; elementId: string }>(page, 'conductor.action', {
    action: 'element.create',
    canvasId,
    elementKind: 'native/document',
    position: { x: 1, y: 1, w: 6, h: 4, zIndex: 1, rotation: 0 },
    config: { title: 'Project brief', markdown: '# Project brief\n\nA finite-layout document.' },
  });
  expect(result.success).toBe(true);
  return result.elementId;
}

test('finite mode shows only document widgets, text, and media', async () => {
  const app: DuyaApp = await launchDuya({
    namespace: 'cond-finite-widget-layout',
    previewMode: true,
  });
  try {
    const { page } = app;
    await openConductor(page);
    const canvasId = await firstCanvasId(page);
    await clearCanvas(page, canvasId);

    await createDocumentElement(page, canvasId);
    await createNativeElement(
      page,
      canvasId,
      'table',
      { x: 8, y: 1, w: 5, h: 4, zIndex: 2, rotation: 0 },
      { title: 'Milestones', headers: ['Item', 'Status'], rows: [['Alpha', 'Done']] },
    );
    const linkId = await createNativeElement(
      page,
      canvasId,
      'link',
      { x: 2, y: 7, w: 4, h: 1, zIndex: 3, rotation: 0 },
      { linkType: 'url', url: 'https://example.com', title: 'Example', expanded: false },
    );
    const textId = await createNativeElement(
      page,
      canvasId,
      'text',
      { x: 1, y: 10, w: 4, h: 2, zIndex: 4, rotation: 0 },
      { text: 'Freeform text' },
    );
    const imageId = await createNativeElement(
      page,
      canvasId,
      'image',
      { x: 6, y: 10, w: 4, h: 3, zIndex: 5, rotation: 0 },
      {
        url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="60"%3E%3Crect width="80" height="60" fill="%237c3aed"/%3E%3C/svg%3E',
        alt: 'Sample media',
      },
    );
    const fileId = await createNativeElement(
      page,
      canvasId,
      'file',
      { x: 1, y: 14, w: 5, h: 2, zIndex: 6, rotation: 0 },
      { fileName: 'notes.pdf', mimeType: 'application/pdf' },
    );
    const shapeId = await createNativeElement(
      page,
      canvasId,
      'shape',
      { x: 8, y: 16, w: 3, h: 2, zIndex: 7, rotation: 0 },
      { shape: 'rounded', text: 'Canvas-only shape' },
    );

    await expect.poll(async () => {
      const snapshot = await invokeApi<ConductorSnapshot | null>(page, 'conductor.snapshot', canvasId);
      return snapshot?.elements.length ?? 0;
    }).toBe(7);

    // Reload the renderer so the assertion exercises snapshot hydration in
    // addition to the live conductor bridge update path.
    await openConductor(page);

    const before = await invokeApi<ConductorSnapshot>(page, 'conductor.snapshot', canvasId);
    const originalLinkPosition = before.elements.find((element) => element.id === linkId)?.position;
    expect(originalLinkPosition).toBeTruthy();

    const mainView = page.getByTestId('conductor-main-view');
    const toggle = mainView.locator('.canvas-presentation-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle.getByRole('button', { name: 'Document' })).toBeVisible();
    await toggle.getByRole('button', { name: 'Document' }).click();

    await expect(mainView.locator('.finite-canvas-area')).toBeVisible();
    await expect(mainView.locator('.finite-widget-item')).toHaveCount(3);
    await expect(mainView.locator('.finite-freeform-item')).toHaveCount(3);
    await expect(mainView.locator(`[data-finite-widget-id="${linkId}"]`)).toBeVisible();
    await expect(mainView.locator(`[data-native-element-id="${textId}"]`)).toBeVisible();
    await expect(mainView.locator(`[data-native-element-id="${imageId}"]`)).toBeVisible();
    await expect(mainView.locator(`[data-native-element-id="${fileId}"]`)).toBeVisible();
    await expect(mainView.locator(`[data-native-element-id="${shapeId}"]`)).toHaveCount(0);
    await expect(mainView.locator('.canvas-toolbar')).toHaveCount(0);

    const handle = mainView.locator(`[data-finite-widget-id="${linkId}"] .finite-widget-drag-handle`);
    const box = await handle.boundingBox();
    expect(box).toBeTruthy();
    if (!box) throw new Error('Link widget drag handle has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 70, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => {
      const snapshot = await invokeApi<ConductorSnapshot>(page, 'conductor.snapshot', canvasId);
      const finiteLayout = snapshot.canvas.layoutConfig.finiteWidgetLayout as
        | { items?: Record<string, unknown> }
        | undefined;
      return Boolean(finiteLayout?.items?.[linkId]);
    }).toBe(true);

    const after = await invokeApi<ConductorSnapshot>(page, 'conductor.snapshot', canvasId);
    expect(after.elements.find((element) => element.id === linkId)?.position).toEqual(originalLinkPosition);

    await toggle.getByRole('button', { name: 'Canvas' }).click();
    await expect(mainView.locator('.finite-canvas-area')).toHaveCount(0);
    await expect(mainView.locator('.conductor-canvas-surface')).toBeVisible();
    await expect(mainView.locator(`[data-native-element-id="${shapeId}"]`)).toBeVisible();
    await expect(mainView.locator('.canvas-toolbar')).toBeVisible();
  } finally {
    await closeDuya(app.app);
  }
});
