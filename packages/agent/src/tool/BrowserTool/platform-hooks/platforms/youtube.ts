/**
 * YouTube Platform Hooks
 * Handles YouTube-specific behaviors like cookie consent, SPA navigation, video loading
 */

import type { PlatformHooks } from '../types.js';

export const youtubeHooks: PlatformHooks = {
  name: 'youtube',

  /**
   * Post-navigate hook: Handle cookie consent, wait for app initialization
   */
  async postNavigate(cdp, url) {
    // Handle YouTube's cookie consent dialog (EU/UK users)
    await cdp.evaluate(`
      (() => {
        // Try multiple selectors for the consent dialog
        const consentSelectors = [
          'button[aria-label="Accept all"]',
          'button[aria-label="Accept the use of cookies and other data for the purposes described"]',
          'form[action*="consent"] button',
          '[aria-label*="Accept"]',
          'button yt-formatted-string:contains("Accept all")',
          // German
          'button[aria-label="Alle akzeptieren"]',
          // French
          'button[aria-label="Tout accepter"]',
        ];
        
        for (const selector of consentSelectors) {
          try {
            const btn = document.querySelector(selector);
            if (btn && btn.offsetParent !== null) {
              btn.click();
              return 'cookie consent accepted';
            }
          } catch {}
        }

        // Try to find and click the "Accept all" button by text content
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          const text = btn.textContent?.toLowerCase() || '';
          if (text.includes('accept all') || text.includes('alle akzeptieren') || 
              text.includes('tout accepter') || text.includes('accept')) {
            if (btn.offsetParent !== null) {
              btn.click();
              return 'cookie consent accepted via text';
            }
          }
        }

        return 'no cookie consent found';
      })()
    `);

    // Wait for ytd-app to be initialized
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkReady = () => {
          const app = document.querySelector('ytd-app');
          if (app && app.offsetParent !== null) {
            resolve('ytd-app ready');
          } else {
            setTimeout(checkReady, 500);
          }
        };
        checkReady();
        setTimeout(() => resolve('timeout'), 10000);
      })
    `);

    // Handle sign-in popup if present
    await cdp.evaluate(`
      (() => {
        const dismissSelectors = [
          'button[aria-label="Dismiss"]',
          'button[aria-label="No thanks"]',
          'yt-button-renderer[dialog-dismiss]',
          'tp-yt-paper-button[dialog-dismiss]',
        ];
        
        for (const selector of dismissSelectors) {
          try {
            const btn = document.querySelector(selector);
            if (btn && btn.offsetParent !== null) {
              btn.click();
              return 'popup dismissed';
            }
          } catch {}
        }
        return 'no popup found';
      })()
    `);

    // Wait for content to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));
  },

  /**
   * Pre-snapshot hook: Ensure video thumbnails and content are loaded
   */
  async preSnapshot(cdp, _url) {
    // Wait for video renderer elements
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkVideos = () => {
          const videos = document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer');
          if (videos.length > 0) {
            resolve({ videoCount: videos.length });
          } else {
            setTimeout(checkVideos, 500);
          }
        };
        checkVideos();
        setTimeout(() => resolve({ videoCount: 0 }), 5000);
      })
    `);

    // Trigger lazy-loaded thumbnails
    await cdp.evaluate(`
      (() => {
        const thumbnails = document.querySelectorAll('yt-img-shadow img, ytd-thumbnail img');
        let loaded = 0;
        for (const img of thumbnails) {
          if (img.complete && img.naturalHeight !== 0) {
            loaded++;
          }
        }
        return { thumbnailsTotal: thumbnails.length, thumbnailsLoaded: loaded };
      })()
    `);

    // Expand description if collapsed (on watch pages)
    await cdp.evaluate(`
      (() => {
        const expandBtn = document.querySelector('#expand, button[aria-label*="more"], tp-yt-paper-button[aria-label*="more"]');
        if (expandBtn && expandBtn.offsetParent !== null) {
          expandBtn.click();
          return 'description expanded';
        }
        return 'no expand button';
      })()
    `);
  },

  /**
   * Post-click hook: Handle SPA navigation, wait for video/player
   */
  async postClick(cdp, url, selector) {
    // YouTube is a SPA, so clicking may trigger client-side navigation
    // Wait for URL to potentially change
    await new Promise(resolve => setTimeout(resolve, 1500));

    // If on a watch page, wait for player
    if (url.includes('/watch') || selector.includes('video') || selector.includes('thumbnail')) {
      await cdp.evaluate(`
        new Promise((resolve) => {
          const checkPlayer = () => {
            const player = document.querySelector('#movie_player, .html5-video-player, ytd-player');
            if (player) {
              resolve('player ready');
            } else {
              setTimeout(checkPlayer, 500);
            }
          };
          checkPlayer();
          setTimeout(() => resolve('timeout'), 10000);
        })
      `);

      // Pause video if auto-playing
      await cdp.evaluate(`
        (() => {
          const video = document.querySelector('video');
          if (video && !video.paused) {
            video.pause();
            return 'video paused';
          }
          return 'video not playing';
        })()
      `);
    }

    // Handle any new popups after click
    await cdp.evaluate(`
      (() => {
        const dismissSelectors = [
          'button[aria-label="Dismiss"]',
          'button[aria-label="No thanks"]',
          'yt-button-renderer[dialog-dismiss]',
        ];
        
        for (const selector of dismissSelectors) {
          try {
            const btn = document.querySelector(selector);
            if (btn && btn.offsetParent !== null) {
              btn.click();
              return 'popup dismissed';
            }
          } catch {}
        }
        return 'no popup';
      })()
    `);
  },

  /**
   * Pre-scroll hook: Handle infinite scroll / load more
   */
  async preScroll(cdp, _url) {
    // Check if we're on a page with infinite scroll (home, search, channel)
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkLoading = () => {
          // YouTube shows a spinner during infinite scroll
          const spinner = document.querySelector('yt-loading-renderer, .yt-spinner, [class*="spinner"]');
          const isLoading = spinner && spinner.offsetParent !== null;
          
          if (!isLoading) {
            resolve('ready');
          } else {
            setTimeout(checkLoading, 500);
          }
        };
        checkLoading();
        setTimeout(() => resolve('timeout'), 5000);
      })
    `);

    // Trigger continuation loading if available
    await cdp.evaluate(`
      (() => {
        const continuation = document.querySelector('yt-continuation-item-renderer, [continuation-item]');
        if (continuation) {
          // Scroll the continuation into view to trigger loading
          continuation.scrollIntoView({ behavior: 'instant', block: 'center' });
          return 'continuation triggered';
        }
        return 'no continuation';
      })()
    `);

    // Small delay for any triggered loading
    await new Promise(resolve => setTimeout(resolve, 500));
  },
};
