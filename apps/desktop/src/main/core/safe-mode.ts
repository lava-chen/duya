import { app, BrowserWindow } from 'electron';
import * as path from 'path';

// =============================================================================
// Safe Mode Window (Defense 2: prevent crash when DB path is invalid)
// =============================================================================

let safeModeWindow: BrowserWindow | null = null;

export function getSafeModeWindow(): BrowserWindow | null {
  return safeModeWindow;
}

export async function createSafeModeWindow(
  reason: string,
  dbPath: string,
  getIconPath: () => string,
): Promise<void> {
  safeModeWindow = new BrowserWindow({
    width: 600,
    height: 450,
    resizable: false,
    title: 'DUYA - Safe Recovery Mode',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const safeModeHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>DUYA - Safe Recovery Mode</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e; color: #e0e0e0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100vh; padding: 40px;
    }
    h1 { color: #ff6b6b; font-size: 24px; margin-bottom: 16px; }
    .reason { background: #2a2a4a; padding: 16px; border-radius: 8px; margin-bottom: 24px; width: 100%; font-size: 14px; word-break: break-all; }
    .path { color: #ffd93d; font-family: monospace; }
    .buttons { display: flex; gap: 12px; }
    button {
      padding: 10px 24px; border: none; border-radius: 6px; cursor: pointer;
      font-size: 14px; font-weight: 500;
    }
    .btn-primary { background: #4ecdc4; color: #1a1a2e; }
    .btn-secondary { background: #555; color: #e0e0e0; }
    button:hover { opacity: 0.9; }
    .status { margin-top: 16px; font-size: 13px; color: #aaa; }
  </style>
</head>
<body>
  <h1>⚠ Database Connection Failed</h1>
  <div class="reason">
    <p>Reason: ${reason}</p>
    <p class="path">Path: ${dbPath}</p>
  </div>
  <div class="buttons">
    <button class="btn-primary" onclick="relocate()">Relocate Database</button>
    <button class="btn-secondary" onclick="resetDefault()">Reset to Default</button>
  </div>
  <div class="status" id="status"></div>
  <script>
    async function relocate() {
      document.getElementById('status').textContent = 'Opening folder picker...';
      var result = await window.electronAPI.dialog.openFolder({
        title: 'Select new database location'
      });
      if (result.canceled) {
        document.getElementById('status').textContent = 'Cancelled.';
        return;
      }
      var newDir = result.filePaths[0];
      if (!newDir) return;

      document.getElementById('status').textContent = 'Relocating database...';
      var relocateResult = await window.electronAPI.safeMode.relocateDatabase(newDir);
      if (relocateResult.success) {
        document.getElementById('status').textContent = 'Relocated! Restarting...';
        setTimeout(function() {
          window.electronAPI.migration.updateBootAndRestart(relocateResult.newPath);
        }, 1000);
      } else {
        document.getElementById('status').textContent = 'Failed: ' + relocateResult.error;
      }
    }

    async function resetDefault() {
      document.getElementById('status').textContent = 'Resetting to default path...';
      var result = await window.electronAPI.safeMode.resetToDefaultPath();
      if (result.success) {
        document.getElementById('status').textContent = 'Reset! Restarting...';
        setTimeout(function() {
          window.electronAPI.migration.updateBootAndRestart(result.newPath);
        }, 1000);
      } else {
        document.getElementById('status').textContent = 'Failed: ' + result.error;
      }
    }
  </script>
</body>
</html>`;

  safeModeWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(safeModeHtml)}`);

  safeModeWindow.on('closed', () => {
    safeModeWindow = null;
  });
}
