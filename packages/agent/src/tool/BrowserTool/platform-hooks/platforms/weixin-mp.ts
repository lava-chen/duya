/**
 * WeChat Official Account (微信公众号) Platform Hooks
 * Handles WeChat article pages (mp.weixin.qq.com)
 */

import type { PlatformHooks } from '../types.js';

export const weixinMpHooks: PlatformHooks = {
  name: 'weixin-mp',

  /**
   * Post-navigate hook: Handle anti-bot verification, wait for content
   */
  async postNavigate(cdp, url) {
    // Check for anti-bot verification page
    const accessIssue = await cdp.evaluate(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        const normalizedText = text.replace(/\\s+/g, ' ').trim();
        if (/环境异常/.test(normalizedText) &&
            /(完成验证后即可继续访问|去验证)/.test(normalizedText)) {
          return 'environment verification required';
        }
        const html = document.documentElement.innerHTML;
        if (/secitptpage\\/verify\\.html/.test(html) || /id=["']js_verify["']/.test(html)) {
          return 'environment verification required';
        }
        return '';
      })()
    `);

    if (accessIssue === 'environment verification required') {
      throw new Error('WeChat anti-bot verification required. Please open the article in browser and complete verification manually.');
    }

    // Wait for article content to load
    await cdp.evaluate(`
      new Promise((resolve) => {
        const checkContent = () => {
          const content = document.querySelector('#js_content') || 
                         document.querySelector('#img-content');
          if (content && content.textContent.trim().length > 0) {
            resolve('content loaded');
          } else {
            setTimeout(checkContent, 500);
          }
        };
        checkContent();
        setTimeout(() => resolve('timeout'), 10000);
      })
    `);

    // Handle lazy-loaded images
    await cdp.evaluate(`
      (() => {
        document.querySelectorAll('img[data-src]').forEach(img => {
          const dataSrc = img.getAttribute('data-src');
          if (dataSrc) img.setAttribute('src', dataSrc);
        });
        return 'images handled';
      })()
    `);

    // Remove noise elements
    await cdp.evaluate(`
      (() => {
        ['script', 'style', '.qr_code_pc', '.reward_area', '.rich_media_tool'].forEach(sel => {
          document.querySelectorAll(sel).forEach(el => el.remove());
        });
        return 'noise removed';
      })()
    `);

    await new Promise(resolve => setTimeout(resolve, 500));
  },

  /**
   * Pre-snapshot hook: Ensure content is ready
   */
  async preSnapshot(cdp, _url) {
    // Ensure images are loaded
    await cdp.evaluate(`
      (() => {
        document.querySelectorAll('img[data-src]').forEach(img => {
          const dataSrc = img.getAttribute('data-src');
          if (dataSrc) img.setAttribute('src', dataSrc);
        });
        return 'images ready';
      })()
    `);

    // Expand collapsed content if any
    await cdp.evaluate(`
      (() => {
        const readMore = document.querySelector('.read-more, .show-more, [class*="expand"]');
        if (readMore && readMore.offsetParent !== null) {
          readMore.click();
          return 'expanded';
        }
        return 'no expand needed';
      })()
    `);
  },

  /**
   * Post-click hook: Handle any dynamic content
   */
  async postClick(cdp, _url, selector) {
    // Handle image click (open image viewer)
    if (selector.includes('img')) {
      // Wait for image viewer to open
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  },
};
