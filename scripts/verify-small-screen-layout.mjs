import { chromium } from 'playwright';

const BASE_URL = process.env.DUYA_DEV_URL || 'http://127.0.0.1:3001';

async function measure(page) {
  return await page.evaluate(() => {
    const main = document.querySelector('.app-main-wrapper');
    const panel = document.querySelector('.panel-zone');
    const workspace = document.querySelector('.app-workspace-row');
    const sidebar = document.querySelector('.app-sidebar');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      workspace: workspace?.getBoundingClientRect() ?? null,
      main: main?.getBoundingClientRect() ?? null,
      panel: panel?.getBoundingClientRect() ?? null,
      sidebar: sidebar?.getBoundingClientRect() ?? null,
      panelClasses: panel?.className ?? null,
      panelDataPageId: panel?.getAttribute('data-page-id') ?? null,
    };
  });
}

async function openFakePanel(page, pageId = 'files', width = 300) {
  await page.evaluate(({ pageId, width }) => {
    const panel = document.querySelector('.panel-zone');
    if (!panel) {
      window.__duyaPanelInjectError = 'panel not found';
      return;
    }
    panel.classList.remove('panel-zone-closed');
    panel.classList.add('panel-zone-open');
    panel.setAttribute('data-page-id', pageId);
    panel.style.setProperty('--panel-zone-width', `${width}px`);
    panel.style.setProperty('--panel-content-width', `${width}px`);
    const inner = panel.querySelector('.sidebar-panel-inner');
    if (inner) inner.style.width = `${width}px`;
    window.__duyaPanelInjectError = null;
  }, { pageId, width });
  const err = await page.evaluate(() => window.__duyaPanelInjectError);
  return err === null;
}

async function testViewport(page, width, height = 800) {
  await page.setViewportSize({ width, height });
  // Wait for layout to settle
  await page.waitForTimeout(300);
  const state = await measure(page);
  return state;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  try {
    console.log(`Navigating to ${BASE_URL}...`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Inject a fake panel so we can test layout without relying on DB threads.
    const panelExists = await page.evaluate(() => !!document.querySelector('.panel-zone'));
    console.log('PanelZone exists before inject:', panelExists);
    const injected = await openFakePanel(page, 'files', 300);
    if (!injected) throw new Error('PanelZone not found');

    console.log('\n--- layout measurements ---');
    const cases = [1280, 1200, 1100, 1000, 940, 900, 800, 760, 720];
    for (const w of cases) {
      const s = await testViewport(page, w);
      const mainW = s.main?.width ?? 0;
      const panelW = s.panel?.width ?? 0;
      const workspaceW = s.workspace?.width ?? 0;
      const floating = s.panelClasses?.includes('panel-zone-open') && !(s.panelClasses?.includes('panel-zone-expanded'));
      console.log(
        `viewport=${w} workspace=${workspaceW.toFixed(0)} chat=${mainW.toFixed(0)} panel=${panelW.toFixed(0)} pageId=${s.panelDataPageId} classes=${s.panelClasses}`
      );
    }

    // Assertion: chat should never be squeezed below 420px while panel is docked.
    // Docked means panel-zone-open is present and position is not absolute.
    const assertDocked = async (viewportWidth, expectedChatMin) => {
      await testViewport(page, viewportWidth);
      const s = await page.evaluate(() => {
        const main = document.querySelector('.app-main-wrapper');
        const panel = document.querySelector('.panel-zone');
        const cs = window.getComputedStyle(panel);
        return {
          chatWidth: main?.getBoundingClientRect().width ?? 0,
          panelPosition: cs.position,
          panelClass: panel?.className ?? '',
        };
      });
      const ok = s.chatWidth >= expectedChatMin - 1; // allow 1px rounding
      console.log(`assert ${viewportWidth}px: chat=${s.chatWidth.toFixed(0)}px position=${s.panelPosition} ${ok ? 'OK' : 'FAIL'}`);
      return ok;
    };

    console.log('\n--- assertions ---');
    let allOk = true;
    allOk = (await assertDocked(1280, 420)) && allOk;
    allOk = (await assertDocked(1100, 420)) && allOk;
    allOk = (await assertDocked(1000, 420)) && allOk;

    // At very small widths the panel may float; verify chat still >= 420.
    allOk = (await assertDocked(720, 420)) && allOk;

    // Test browser-specific breakpoint (460 + 420 = 880 workspace).
    console.log('\n--- browser panel breakpoint ---');
    await openFakePanel(page, 'browser', 460);
    for (const w of [1280, 1200, 1144, 1143, 1100, 1000]) {
      await testViewport(page, w);
      const s = await page.evaluate(() => {
        const main = document.querySelector('.app-main-wrapper');
        const panel = document.querySelector('.panel-zone');
        const cs = window.getComputedStyle(panel);
        return {
          chatWidth: main?.getBoundingClientRect().width ?? 0,
          panelPosition: cs.position,
        };
      });
      const workspace = w - 264; // sidebar + resizer
      const expectedDocked = workspace >= 880;
      const ok = expectedDocked ? s.panelPosition === 'relative' : s.panelPosition === 'absolute';
      console.log(`browser viewport=${w} workspace=${workspace} chat=${s.chatWidth.toFixed(0)} position=${s.panelPosition} ${ok ? 'OK' : 'FAIL'}`);
      allOk = ok && allOk;
    }

    await browser.close();
    process.exit(allOk ? 0 : 1);
  } catch (err) {
    console.error(err);
    await browser.close();
    process.exit(1);
  }
}

main();
