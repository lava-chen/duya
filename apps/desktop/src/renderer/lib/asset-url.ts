// Asset URL helpers — resolve bundled assets (splash logo, install
// dialog hero, etc.) to a URL the renderer can drop into `<img src>`.
//
// Why this exists: bare paths like `/icon.png` work under the Vite dev
// server but resolve to `file:///icon.png` (the disk root) once the
// Electron renderer is loaded via `file://.../app.asar/dist/index.html`,
// so the image silently 404s in packaged builds. The main-process
// `app:get-asset-url` handler returns a `duya-file://...` URL that the
// protocol handler in main.ts can serve in both dev and prod.

import { useEffect, useState } from "react";

/**
 * React hook: resolve a named bundled asset to a renderable URL.
 *
 * Returns `undefined` while the IPC round-trip is in flight (callers
 * should render nothing or a fallback in that case to avoid a broken
 * `<img>`). Resolves to either a `duya-file://...` URL or `null` when
 * the asset name is unknown / missing.
 */
export function useAssetUrl(
  name: "appIcon" | "appIconSquare" | string,
): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI;
    if (!api?.app?.getAssetUrl) {
      setUrl(null);
      return;
    }
    void api.app.getAssetUrl(name).then((resolved) => {
      if (!cancelled) setUrl(resolved ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);
  return url;
}
