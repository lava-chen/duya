/**
 * X (Twitter) Platform Hooks
 * Handles Twitter/X pages (x.com, twitter.com)
 */

import type { PlatformHooks } from '../types.js';

export const twitterHooks: PlatformHooks = {
  name: 'twitter',

  /**
   * Post-navigate hook: Handle login wall, wait for timeline
   */
  async postNavigate(cdp, url) {
    // Check if login is required
    const loginRequired = await cdp.evaluate(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        return text.includes('Log in') && text.includes('to continue');
      })()
    `);

    if (loginRequired) {
      console.warn('[Twitter] Login may be required for full access');
    }

    // Wait for React app to initialize
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkReady = () => {
          // Check for React root or main content area
          const root = document.querySelector('#react-root') || 
                      document.querySelector('[data-testid="primaryColumn"]');
          if (root) {
            resolve('react ready');
          } else {
            setTimeout(checkReady, 500);
          }
        };
        checkReady();
        setTimeout(() => resolve('timeout'), 10000);
      })
    `);

    // Handle cookie consent if present
    await cdp.evaluate(`
      (() => {
        const consentBtn = document.querySelector('button[data-testid="cookiePolicyButton"]') ||
                          document.querySelector('[role="button"][aria-label*="cookie"]');
        if (consentBtn && consentBtn.offsetParent !== null) {
          consentBtn.click();
          return 'cookie consent handled';
        }
        return 'no cookie consent';
      })()
    `);

    // Wait for tweets to load if on timeline
    if (url.includes('/home') || url.includes('/search')) {
      await cdp.evaluate(`
        new Promise((resolve) => {
          const checkTweets = () => {
            const tweets = document.querySelectorAll('[data-testid="tweet"]');
            if (tweets.length > 0) {
              resolve({ tweetsLoaded: tweets.length });
            } else {
              setTimeout(checkTweets, 500);
            }
          };
          checkTweets();
          setTimeout(() => resolve({ tweetsLoaded: 0 }), 5000);
        })
      `);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  },

  /**
   * Pre-snapshot hook: Ensure tweets are loaded
   */
  async preSnapshot(cdp, _url) {
    // Trigger lazy loading by scrolling slightly
    await cdp.evaluate(`
      (() => {
        window.scrollBy(0, 100);
        return 'scrolled';
      })()
    `);

    // Wait for any new tweets to load
    await new Promise(resolve => setTimeout(resolve, 500));

    // Expand collapsed tweets if any
    await cdp.evaluate(`
      (() => {
        const showMore = document.querySelectorAll('[data-testid="tweet-text-show-more-link"]');
        showMore.forEach(btn => {
          if (btn.offsetParent !== null) btn.click();
        });
        return { expanded: showMore.length };
      })()
    `);
  },

  /**
   * Post-click hook: Handle navigation changes
   */
  async postClick(cdp, _url, selector) {
    // Twitter is a SPA, clicking may trigger client-side navigation
    // Wait for content to update
    await new Promise(resolve => setTimeout(resolve, 1000));

    // If clicking a tweet, wait for thread to load
    if (selector.includes('tweet') || selector.includes('status')) {
      await cdp.evaluate(`
        new Promise((resolve) => {
          const checkThread = () => {
            const thread = document.querySelector('[data-testid="tweet"]');
            if (thread) {
              resolve('thread loaded');
            } else {
              setTimeout(checkThread, 500);
            }
          };
          checkThread();
          setTimeout(() => resolve('timeout'), 5000);
        })
      `);
    }
  },

  /**
   * Pre-scroll hook: Handle infinite scroll loading
   */
  async preScroll(cdp, _url) {
    // Check if loading indicator is present
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkLoading = () => {
          const loaders = document.querySelectorAll('[role="progressbar"], .r-1pn2ns4');
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
