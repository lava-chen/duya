import { useEffect } from 'react';

/**
 * Windows fullscreen→windowed glass repaint guard (plan 426 follow-up).
 *
 * The glasschrome surfaces (sidebar, header, hero-card, conductor panel,
 * etc.) are GPU-composited via `backdrop-filter: blur(...)`. When the native
 * window enters and then leaves fullscreen on Windows, Chromium's compositor
 * retiles the window against the (re-applied) Mica material but can leave the
 * `backdrop-filter` layers sampling a stale backdrop — the frosted panes then
 * render blank / stretched / garbled, which reads as "the whole UI broke".
 * The main process can only re-apply the native Mica attribute; it cannot
 * reach into the renderer's composited CSS filter layers.
 *
 * The renderer's fix is to force those layers to rebuild immediately after
 * the transition back to windowed mode: drop `data-glass-repair` on <html>
 * for one frame so globals.css nudges every glass surface's blur to a
 * near-zero value (which forces Chromium to re-sample and rebuild the
 * backdrop), then restore the real blur. The 0.02px-vs-8~22px delta is
 * imperceptible.
 */

const REPAIR_TIMEOUT_MS = 250;

// Whether the singleton listeners have been bound (guards React.StrictMode's
// double-mount against double-binding).
let listenersBound = false;

/** Whether the window was created with a native backdrop requiring the glass
 *  repaint handle (Windows 11 Mica; the macOS vibrancy path does not hit the
 *  fullscreen retile bug but is harmless to include). */
function isGlassBackdrop(): boolean {
  const bt = document.documentElement.getAttribute('data-backdrop');
  return bt === 'mica' || bt === 'vibrancy';
}

/** Force a one-frame re-composite of the glass layers. */
function repairGlass(): void {
  const html = document.documentElement;
  if (html.hasAttribute('data-glass-repair')) return;
  requestAnimationFrame(() => {
    html.setAttribute('data-glass-repair', '1');
    requestAnimationFrame(() => html.removeAttribute('data-glass-repair'));
  });
}

/**
 * Idempotent, module-level singleton: binds the fullscreen/resize listeners
 * for the lifetime of the page. Returns a no-op cleanup so it can be mounted
 * through a React effect without double-binding.
 */
export function initBackdropRepair(): () => void {
  if (typeof document === 'undefined' || !isGlassBackdrop() || listenersBound) {
    return () => {};
  }
  listenersBound = true;

  // Primary trigger: leaving fullscreen (F11 / native Win+Shift+Enter).
  const onFullscreenChange = (): void => {
    if (!document.fullscreenElement) repairGlass();
  };

  // Secondary trigger: window restored into a windowed rect right after a
  // fullscreen session. Debounced so a resize-drag does not thrash repaints.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    if (document.fullscreenElement) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(repairGlass, REPAIR_TIMEOUT_MS);
  };

  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('resize', onResize);

  return () => {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    window.removeEventListener('resize', onResize);
    clearTimeout(resizeTimer);
  };
}

/** React hook mount point for the fullscreen glass repaint guard. */
export function useBackdropRepair(): void {
  useEffect(() => initBackdropRepair(), []);
}