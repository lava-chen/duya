/**
 * Bilibili Platform Hooks
 * Handles Bilibili-specific behaviors like login popups, infinite scroll, video cards
 */

import type { PlatformHooks } from '../types.js';

export const bilibiliHooks: PlatformHooks = {
  name: 'bilibili',

  /**
   * Post-navigate hook: Handle login popup, wait for video cards
   */
  async postNavigate(cdp, url) {
    // Wait for Bilibili app container to be ready
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkReady = () => {
          const app = document.querySelector('#app') || document.querySelector('.bili-app');
          if (app) {
            resolve('ready');
          } else {
            setTimeout(checkReady, 500);
          }
        };
        checkReady();
        // Timeout after 10 seconds
        setTimeout(() => resolve('timeout'), 10000);
      })
    `);

    // Close login popup if present
    await cdp.evaluate(`
      (() => {
        const closeButtons = document.querySelectorAll(
          '.login-tip-close, .close-btn, .bili-mini-close, [class*="close"][class*="login"]'
        );
        for (const btn of closeButtons) {
          if (btn.offsetParent !== null) btn.click();
        }
        // Also try to close modal overlays
        const overlays = document.querySelectorAll('.login-panel, .bili-mini-mask');
        for (const overlay of overlays) {
          const closeBtn = overlay.querySelector('.close, .close-btn, [class*="close"]');
          if (closeBtn) closeBtn.click();
        }
        return 'login popup handled';
      })()
    `);

    // Handle cookie consent if present
    await cdp.evaluate(`
      (() => {
        const consentBtn = document.querySelector('.cookie-consent-btn, .agree-btn, [class*="consent"]');
        if (consentBtn && consentBtn.offsetParent !== null) {
          consentBtn.click();
          return 'cookie consent handled';
        }
        return 'no cookie consent';
      })()
    `);

    // Wait a bit for any animations to complete
    await new Promise(resolve => setTimeout(resolve, 800));
  },

  /**
   * Pre-snapshot hook: Ensure video cards are loaded
   */
  async preSnapshot(cdp, _url) {
    // Wait for video cards to be present
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkCards = () => {
          const cards = document.querySelectorAll('.video-card, .bili-video-card, .feed-card');
          if (cards.length > 0) {
            resolve({ videoCards: cards.length });
          } else {
            setTimeout(checkCards, 500);
          }
        };
        checkCards();
        setTimeout(() => resolve({ videoCards: 0 }), 5000);
      })
    `);

    // Handle any lazy-loaded images
    await cdp.evaluate(`
      (() => {
        const lazyImages = document.querySelectorAll('img[data-src], img[data-lazy-src]');
        for (const img of lazyImages) {
          const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
          if (dataSrc) img.setAttribute('src', dataSrc);
        }
        return { lazyImagesHandled: lazyImages.length };
      })()
    `);
  },

  /**
   * Post-click hook: Handle navigation changes, wait for content
   */
  async postClick(cdp, _url, selector) {
    // If clicking a video card, wait for video page to load
    if (selector.includes('video') || selector.includes('card')) {
      await cdp.evaluate(`
        new Promise((resolve) => {
          const checkVideo = () => {
            const player = document.querySelector('.bilibili-player, .video-player, #player');
            if (player) {
              resolve('video player loaded');
            } else {
              setTimeout(checkVideo, 500);
            }
          };
          checkVideo();
          setTimeout(() => resolve('timeout waiting for video player'), 10000);
        })
      `);
    }

    // General wait for SPA navigation
    await new Promise(resolve => setTimeout(resolve, 1000));
  },

  /**
   * Pre-scroll hook: Handle infinite scroll loading
   */
  async preScroll(cdp, _url) {
    // Check if there's a loading indicator and wait for it to disappear
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkLoading = () => {
          const loaders = document.querySelectorAll('.loading, .load-more, [class*="loading"], [class*="load"]');
          const isLoading = Array.from(loaders).some(el => el.offsetParent !== null);
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
  },
};
