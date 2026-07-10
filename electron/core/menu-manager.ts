import { app, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Set the application menu.
 *
 * macOS requires an application menu: without one Electron shows the default
 * "Electron" menu, standard shortcuts (Cmd+Q, Cmd+W, Cmd+M, Edit menu's
 * copy/paste/select-all) stop working, and the app name in the menu bar is
 * wrong. On Windows/Linux the menu is less critical but still provides
 * keyboard shortcuts for edit operations.
 *
 * We build a minimal menu that covers the essentials: app menu (mac only),
 * Edit menu (text editing shortcuts that route to the renderer), View menu
 * (zoom/devtools), Window menu (minimize/zoom/close), and Help.
 */
export function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // { role: 'appMenu' } is a macOS-only role; on Win/Linux it would render
    // a redundant top-level item, so we only include it on macOS.
    ...(isMac
      ? ([{
          label: app.name || 'DUYA',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    // The Edit menu is essential: without it, Cmd/Ctrl+C, Cmd/Ctrl+V,
    // Cmd/Ctrl+A, and Cmd/Ctrl+Z do not reach renderer text inputs on macOS
    // because the system routes these shortcuts through the Edit menu.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
              },
            ]
          : [{ role: 'selectAll' }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
