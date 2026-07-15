import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, type DuyaApp } from '../helpers';

test('debug wheel listener on canvas-area', async () => {
  const app = await launchDuya({ namespace: 'cond-panzoom-debug' });
  try {
    const { page } = app;
    try {
      await page.waitForSelector('[data-testid="nav-conductor"]', { timeout: 20_000 });
      await page.click('[data-testid="nav-conductor"]', { timeout: 5_000 }).catch(() => {});
    } catch {}

    const canvasArea = page.locator('.canvas-area').first();
    await expect(canvasArea).toBeVisible({ timeout: 10_000 });

    // Inject a global flag and re-bind a logging listener alongside the app's listener.
    await canvasArea.evaluate((el) => {
      (window as any).__wheelCaptureFired = false;
      (window as any).__wheelBubbleFired = false;
      (window as any).__wheelDetails = null;
      el.addEventListener('wheel', (e) => {
        (window as any).__wheelCaptureFired = true;
        (window as any).__wheelDetails = {
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          deltaY: e.deltaY,
          cancelable: e.cancelable,
          defaultPrevented: e.defaultPrevented,
          targetTag: (e.target as HTMLElement)?.tagName,
        };
      }, { passive: false, capture: true });
      el.addEventListener('wheel', (e) => {
        (window as any).__wheelBubbleFired = true;
      }, { passive: false, capture: false });
    });

    await canvasArea.dispatchEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await page.waitForTimeout(200);

    const report = await page.evaluate(() => ({
      captureFired: (window as any).__wheelCaptureFired,
      bubbleFired: (window as any).__wheelBubbleFired,
      details: (window as any).__wheelDetails,
      transform: (window as any).canvasTransformState,
      handled: (window as any).__canvasAreaWheelHandled,
      wheelLog: (window as any).__canvasAreaWheelLog,
    }));

    // eslint-disable-next-line no-console
    console.log('DEBUG WHEEL REPORT', JSON.stringify(report, null, 2));
    expect(report.captureFired).toBe(true);
    expect(report.bubbleFired).toBe(true);
  } finally {
    await closeDuya(app.app);
  }
});
