/**
 * link-snapshot-service.ts - Capture static website snapshots for canvas link elements.
 *
 * Uses a hidden Electron BrowserWindow to load the target URL, then captures the
 * rendered page as a PNG. Supports desktop/mobile viewports and both "head" (first
 * viewport) and "full" (entire scrollable page) modes.
 *
 * The captured buffer is returned so the caller can persist it as a project asset.
 */

import { BrowserWindow } from 'electron';
import type { LinkSnapshotMode } from '../../packages/conductor/src/renderer/types/canvas-node';

interface ModeConfig {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  fullPage: boolean;
  maxHeight: number;
}

const MODE_CONFIG: Record<Exclude<LinkSnapshotMode, 'none'>, ModeConfig> = {
  'desktop-head': {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    fullPage: false,
    maxHeight: 800,
  },
  'desktop-full': {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    fullPage: true,
    maxHeight: 12000,
  },
  'mobile-head': {
    width: 375,
    height: 812,
    deviceScaleFactor: 2,
    mobile: true,
    fullPage: false,
    maxHeight: 812,
  },
  'mobile-full': {
    width: 375,
    height: 812,
    deviceScaleFactor: 2,
    mobile: true,
    fullPage: true,
    maxHeight: 12000,
  },
};

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const LOAD_TIMEOUT_MS = 30_000;
const RENDER_DELAY_MS = 1_500;
const RESIZE_DELAY_MS = 500;

interface PageMetrics {
  width: number;
  height: number;
}

export interface LinkSnapshotCapture {
  buffer: Buffer;
  width: number;
  height: number;
}

function getModeConfig(mode: LinkSnapshotMode): ModeConfig {
  const config = MODE_CONFIG[mode as Exclude<LinkSnapshotMode, 'none'>];
  if (!config) {
    throw new Error(`Unsupported snapshot mode: ${mode}`);
  }
  return config;
}

function waitForPageLoad(webContents: Electron.WebContents): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Page load timed out after ${LOAD_TIMEOUT_MS}ms`));
    }, LOAD_TIMEOUT_MS);

    const onFinish = () => {
      cleanup();
      resolve();
    };

    const onFail = (_event: Event, errorCode: number, errorDescription: string) => {
      cleanup();
      reject(new Error(`Failed to load page: ${errorDescription} (${errorCode})`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      webContents.off('did-finish-load', onFinish);
      webContents.off('did-fail-load', onFail);
    };

    webContents.once('did-finish-load', onFinish);
    webContents.once('did-fail-load', onFail);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getScrollableMetrics(webContents: Electron.WebContents): Promise<PageMetrics> {
  const metrics = (await webContents.executeJavaScript(`
    (() => {
      const body = document.body;
      const html = document.documentElement;
      const height = Math.max(
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        html ? html.scrollHeight : 0,
        html ? html.offsetHeight : 0,
        html ? html.clientHeight : 0
      );
      const width = Math.max(
        html ? html.scrollWidth : 0,
        html ? html.clientWidth : 0,
        body ? body.scrollWidth : 0
      );
      return { width, height };
    })()
  `)) as PageMetrics;

  return {
    width: Number.isFinite(metrics.width) ? metrics.width : 0,
    height: Number.isFinite(metrics.height) ? metrics.height : 0,
  };
}

export async function captureWebsiteSnapshot(
  url: string,
  mode: LinkSnapshotMode,
): Promise<LinkSnapshotCapture> {
  const config = getModeConfig(mode);

  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    show: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (config.mobile) {
    win.webContents.setUserAgent(MOBILE_USER_AGENT);
  }

  try {
    await win.loadURL(url);
    await waitForPageLoad(win.webContents);
    await delay(RENDER_DELAY_MS);

    let captureWidth = config.width;
    let captureHeight = config.height;

    if (config.fullPage) {
      const metrics = await getScrollableMetrics(win.webContents);
      captureWidth = Math.max(config.width, Math.min(metrics.width, config.width * 2));
      captureHeight = Math.max(
        config.height,
        Math.min(metrics.height || config.height, config.maxHeight),
      );

      win.setSize(Math.round(captureWidth), Math.round(captureHeight));
      await delay(RESIZE_DELAY_MS);
    }

    const image = await win.webContents.capturePage();
    const buffer = image.toPNG();
    const size = image.getSize();

    return {
      buffer,
      width: size.width,
      height: size.height,
    };
  } finally {
    win.destroy();
  }
}
