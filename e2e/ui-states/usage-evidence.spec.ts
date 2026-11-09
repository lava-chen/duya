/**
 * LOCAL evidence capture for slice D (not committed).
 *
 * Launches the real Electron app, points it at a loopback Anthropic
 * endpoint, drives ONE real turn through the app's own send path (so the
 * worker pushes a real `composition` snapshot into the renderer store) and
 * then photographs the context-usage surfaces in both themes.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchDuya, closeDuya, invokeApi } from '../helpers';
import { startHeldLoopbackAnthropic } from './loopback-hold';

const NS = 'e2e-usage-breakdown';
const MODEL = 'claude-offline-e2e-usage';
const OUT = path.resolve(__dirname, 'shots');

function log(msg: string): void {
  console.log(`[evidence] ${msg}`);
}

async function shoot(page: Page, name: string): Promise<void> {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log(`screenshot -> ${file}`);
}

/** Dismiss the onboarding modal that covers the shell in a fresh namespace. */
async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const skip = page.locator('button[aria-label="跳过"]');
    if ((await skip.count()) > 0) {
      log('the onboarding modal is up; clicking 跳过 (skip)');
      await skip.first().click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      continue;
    }
    const overlay = page.locator('div.fixed.inset-0.z-50');
    if ((await overlay.count()) === 0) return;
    log('a modal overlay is present; pressing Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
  }
}

/** The composer is a contenteditable div; it stays disabled until the shell settles. */
async function waitForComposer(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector<HTMLElement>('[role="textbox"]');
      return !!el && el.isContentEditable;
    },
    { timeout: 90_000 },
  );
}

/** Flip the theme with the app's OWN sidebar toggle. */
async function flipTheme(page: Page): Promise<void> {
  const before = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  const toggle = page.locator('.theme-toggle').first();
  await toggle.click({ timeout: 20_000 });
  await page.waitForFunction(
    (was) => document.documentElement.getAttribute('data-theme') !== was,
    before,
    { timeout: 20_000 },
  );
  const after = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  log(`theme flipped ${before} -> ${after}`);
}

test('capture the context usage breakdown in light and dark', async () => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });

  const loopback = await startHeldLoopbackAnthropic({
    text: 'Usage breakdown evidence turn.',
    model: MODEL,
    holdMs: 150,
    inputTokens: 1800,
    outputTokens: 64,
  });

  const dua = await launchDuya({ namespace: NS });
  const page = dua.page;
  try {
    // 1. Point the app at the loopback provider, through the app's own IPC.
    const upsert = await invokeApi(page, 'provider.upsertLlm', {
      id: 'e2e-loopback',
      name: 'E2E Loopback',
      category: 'custom',
      apiFormat: 'anthropic',
      auth: { type: 'api-key', apiKey: 'e2e-loopback-not-a-credential' },
      endpoints: { baseUrl: loopback.baseUrl },
      ui: {},
      meta: { createdAt: Date.now(), updatedAt: Date.now(), sortIndex: 0 },
      options: { defaultModel: MODEL, enabled_models: [MODEL] },
    });
    log(`upsertLlm ok=${String((upsert as { ok?: boolean }).ok)}`);
    await invokeApi(page, 'provider.setDefaultLlm', { id: 'e2e-loopback' });

    await page.locator('.welcome-view').getByText('选择项目', { exact: true }).click();
    await page.getByText('New No-Project Chat', { exact: true }).click();
    await page.locator('.welcome-recent .recent-item').first().click({ timeout: 20_000 });

    await page.waitForTimeout(4000);
    await dismissOverlays(page);
    await waitForComposer(page);
    const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (initialTheme !== 'light') await flipTheme(page);
    log(`body before send:\n${await page.evaluate(() => document.body.innerText.slice(0, 600))}`);

    // 2. Send one message through the composer (the app's own send path).
    const composer = page.locator('[role="textbox"]').first();
    await composer.click();
    await composer.fill('Say hello so the context usage has something to show.');
    await composer.press('Enter');
    log('message sent');

    // 3. Wait for the assistant answer (the turn really ran).
    await page.waitForTimeout(20_000);
    await dismissOverlays(page);
    log(`body after the turn:\n${await page.evaluate(() => document.body.innerText.slice(0, 900))}`);

    const ring = page.locator('.context-usage-ring-trigger');
    await ring.waitFor({ state: 'visible', timeout: 60_000 });
    log('the context-usage ring is visible');

    // 4. Light theme: collapsed ring, hover popover, expanded panel, child tree.
    await shoot(page, '01-light-ring');

    await ring.hover();
    await page.waitForTimeout(700);
    const popover = page.locator('.context-composition-popover');
    log(`popover visible=${await popover.isVisible()}`);
    log(`popover text: ${(await popover.innerText()).slice(0, 900)}`);
    await shoot(page, '02-light-hover-popover');

    await ring.click();
    await page.waitForTimeout(900);
    const panel = page.locator('.context-usage-panel-breakdown');
    log(`panel visible=${await panel.isVisible()}`);
    log(`panel text: ${(await panel.innerText()).slice(0, 900)}`);
    await shoot(page, '03-light-panel-open');

    const details = page.locator('.context-usage-breakdown__details').first();
    if ((await details.count()) > 0) {
      await details.evaluate((el) => (el as HTMLButtonElement).click());
      await page.waitForTimeout(500);
      await shoot(page, '04-light-details-expanded');
    }

    // 5. Dark theme through the app's own theme toggle.
    await flipTheme(page);
    await page.waitForTimeout(700);

    const darkRing = page.locator('.context-usage-ring-trigger');
    await darkRing.waitFor({ state: 'visible', timeout: 30_000 });
    await shoot(page, '05-dark-ring');

    await darkRing.hover();
    await page.waitForTimeout(700);
    await shoot(page, '06-dark-hover-popover');

    await darkRing.click();
    await page.waitForTimeout(900);
    await shoot(page, '07-dark-panel-open');

    const darkDetails = page.locator('.context-usage-breakdown__details').first();
    if ((await darkDetails.count()) > 0) {
      await darkDetails.evaluate((el) => (el as HTMLButtonElement).click());
      await page.waitForTimeout(500);
      await shoot(page, '08-dark-details-expanded');
    }

    expect(await page.locator('.context-usage-breakdown__bar').count()).toBeGreaterThan(0);
  } finally {
    await closeDuya(dua.app);
    await loopback.close();
  }
});
