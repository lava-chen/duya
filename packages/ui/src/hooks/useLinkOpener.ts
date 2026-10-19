// useLinkOpener — decides whether a web link opens in the system default
// browser or in DUYA's built-in side-panel browser, based on the
// `browser.open_links_in_external_browser` config.toml setting.

import { useCallback } from 'react';
import {
  setLinkOpener,
  useLinkOpenerValue,
} from '@/stores/link-opener-store';

function isSafeWebUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function openInDuyaBrowser(url: string): void {
  window.dispatchEvent(
    new CustomEvent('duya:open-browser-panel', {
      detail: { url },
    }),
  );
}

function openInSystemBrowser(url: string): void {
  if (window.electronAPI?.shell?.openExternal) {
    void window.electronAPI.shell.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function useLinkOpener(): {
  openLinksInExternalBrowser: boolean;
  openLink: (url: string) => void;
  setOpenLinksInExternalBrowser: (value: boolean) => void;
} {
  const openLinksInExternalBrowser = useLinkOpenerValue();

  const openLink = useCallback(
    (url: string) => {
      if (!isSafeWebUrl(url)) return;
      if (openLinksInExternalBrowser) {
        openInSystemBrowser(url);
      } else {
        openInDuyaBrowser(url);
      }
    },
    [openLinksInExternalBrowser],
  );

  const setOpenLinksInExternalBrowser = useCallback((value: boolean) => {
    setLinkOpener(value);
  }, []);

  return { openLinksInExternalBrowser, openLink, setOpenLinksInExternalBrowser };
}
