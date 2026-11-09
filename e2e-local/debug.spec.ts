/** LOCAL debug dump (not committed). */
import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchDuya, closeDuya } from '../e2e/helpers';

const OUT = path.resolve(__dirname, 'shots');

async function dump(page: import('@playwright/test').Page, label: string): Promise<void> {
  const info = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[role="textbox"]');
    return {
      text: document.body.innerText.slice(0, 700),
      composerEditable: el ? el.isContentEditable : null,
      composerDisabledAttr: el ? el.getAttribute('contenteditable') : null,
      overlays: document.querySelectorAll('div.fixed.inset-0.z-50').length,
      skipButtons: document.querySelectorAll('button[aria-label="跳过"]').length,
      buttons: Array.from(document.querySelectorAll('button'))
        .map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 25),
    };
  });
  console.log(`[debug:${label}] ` + JSON.stringify(info, null, 2));
}

test('dump the shell', async () => {
  test.setTimeout(180_000);
  fs.mkdirSync(OUT, { recursive: true });
  const dua = await launchDuya({ namespace: 'e2e-usage-debug2' });
  const page = dua.page;
  try {
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(2500);
      const skip = page.locator('button[aria-label="跳过"]');
      if ((await skip.count()) > 0) {
        console.log('[debug] clicking 跳过');
        await skip.first().click({ timeout: 5000 }).catch((e) => console.log('[debug] click failed ' + e));
        await page.waitForTimeout(2000);
        await dump(page, `after-skip-${i}`);
        break;
      }
      await dump(page, `wait-${i}`);
    }
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(5000);
      const editable = await page.evaluate(
        () => document.querySelector<HTMLElement>('[role="textbox"]')?.isContentEditable ?? false,
      );
      console.log(`[debug:poll-${i}] composerEditable=${String(editable)}`);
      if (editable) {
        await dump(page, `editable-${i}`);
        break;
      }
    }
    await page.screenshot({ path: path.join(OUT, 'debug-shell.png') });
    console.log('[debug] screenshot written');
  } finally {
    await closeDuya(dua.app);
  }
});
