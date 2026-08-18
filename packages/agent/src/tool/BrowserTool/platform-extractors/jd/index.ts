/**
 * JD.com Product Content Extractor
 * Extracts product details (title, SKU, price, shop, main image, specs, reviews)
 * from an JD item page via in-page evaluate. Price and review data are best-effort;
 * if they are not available in the initial DOM/AJAX, they are omitted rather than
 * failing the whole extraction.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions, PlatformContentType } from '../types.js';

interface JdResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class JdExtractor extends BaseExtractor {
  name = 'jd';

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    return parsed.hostname === 'item.jd.com' || parsed.hostname.endsWith('.item.jd.com');
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const type = 'jd' as PlatformContentType;
    const parsed = this.parseUrl(url);
    const skuMatch = parsed?.pathname.match(/item\.jd\.com\/(\d+)\.html/i);
    const sku = skuMatch?.[1] || '';
    if (!sku) {
      return this.error(type, 'Invalid JD item URL - expected item.jd.com/<sku>.html');
    }

    try {
      const maxLength = options?.maxLength ?? 12000;
      const script = `
        (async () => {
          const maxLength = ${maxLength};
          const sku = ${JSON.stringify(sku)};
          const pageUrl = ${JSON.stringify(url)};

          const normImg = (u) => {
            const raw = String(u || '');
            if (!raw) return '';
            let s = raw.trim();
            if (s.startsWith('//')) s = 'https:' + s;
            return /^https?:\\/\\//.test(s) ? s : '';
          };

          const lines = [];
          let title = '';
          let shop = '';
          let price = '';
          let mainImage = '';
          let rating = '';
          let commentCount = '';
          const specs = [];

          const href = location.href;
          const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          const pageText = (document.title || '') + '\\n' + bodyText;
          const isLoginPage = /passport\\.jd\\.com|\\/login\\.aspx/.test(href) || /欢迎登录|京东登录/.test(document.title || '');
          const hasSecurityChallenge = /risk_handler|安全验证|安全校验|完成安全验证|滑块|captcha|访问过于频繁|验证中心|京东验证/.test(href + '\\n' + pageText);
          const hasProductMarker = !!document.querySelector('.product-title, .sku-name, .sku-title, #spec-list, #J-detail, #SPXQ-title, [class*="_gallery_"], #parameter2');
          if (isLoginPage || hasSecurityChallenge) {
            return { kind: 'error', detail: 'JD page is blocked by login/security verification' };
          }
          if (!hasProductMarker) {
            return { kind: 'error', detail: 'JD product page was not loaded' };
          }

          title = document.querySelector('.sku-name')?.textContent?.trim()
                   || document.querySelector('.product-title')?.textContent?.trim()
                   || document.querySelector('.sku-title')?.textContent?.trim()
                   || document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
                   || (document.title.split('-')[0] || '').trim();

          const hrefMatch = location.href.match(/item\\.jd\\.com\\/(\\d+)\\.html/i);
          const resolvedSku = hrefMatch ? hrefMatch[1] : sku;

          shop = document.querySelector('.J-shop-name')?.textContent?.trim()
                 || document.querySelector('.shop-name')?.textContent?.trim()
                 || document.querySelector('.shop-area .name')?.textContent?.trim()
                 || document.querySelector('[class*="shop"] [class*="name"]')?.textContent?.trim()
                 || '京东自营';

          // Main image: og:image first, then detected gallery images.
          mainImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim() || '';
          if (!mainImage) {
            const galleryRoot = document.querySelector('._gallery_116km_1')
              || document.querySelector('[class*="_gallery_"]')
              || document.querySelector('.preview-wrap')
              || document.querySelector('#spec-img')?.parentElement;
            if (galleryRoot) {
              const imgs = galleryRoot.querySelectorAll('img');
              for (let i = 0; i < imgs.length; i++) {
                const src = normImg(imgs[i].currentSrc || imgs[i].src || imgs[i].getAttribute('data-src'));
                if (src) { mainImage = src; break; }
              }
            }
          }
          if (!mainImage) {
            const firstImg = document.querySelector('img[src*="360buyimg.com"]');
            mainImage = firstImg ? normImg(firstImg.currentSrc || firstImg.src) : '';
          }
          if (mainImage && mainImage.indexOf('360buyimg.com') === -1) {
            mainImage = '';
          }

          // Specs: parameter table + selected spec list.
          const paramRoot = document.querySelector('#parameter2') || document.querySelector('.Ptable') || document.querySelector('.attrs');
          if (paramRoot) {
            const items = paramRoot.querySelectorAll('li, .parameter, .p-parameter-item');
            for (let i = 0; i < items.length; i++) {
              const text = (items[i].textContent || '').split(':');
              const m = (items[i].textContent || '').replace(/\\s+/g, ' ').trim().match(/^([^：:]{1,20})\\s*[：:]\\s*(.+)$/);
              if (m && m[1] && m[2] && m[1].trim() && m[2].trim()) {
                specs.push(m[1].trim() + ': ' + String(m[2]).trim());
              } else if (text[0] && text[1]) {
                specs.push(text[0].trim() + ': ' + text.slice(1).join(':').trim());
              }
            }
          }

          // Price: AJAX p.3.cn best effort, then DOM fallback.
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 3000);
            const resp = await fetch('https://p.3.cn/prices/mgets?skuIds=J_' + encodeURIComponent(resolvedSku) + '&type=1', {
              credentials: 'include',
              signal: ctrl.signal
            });
            clearTimeout(timer);
            if (resp.ok) {
              const arr = await resp.json();
              const entry = Array.isArray(arr) ? arr.find(function (e) { return e && typeof e === 'object'; }) : null;
              for (const k of ['p', 'op', 'm']) {
                const v = entry ? entry[k] : null;
                if (v && v !== '-1.00') { price = String(v); break; }
              }
            }
          } catch (e) {}

          if (!price) {
            const priceEl = document.querySelector('.price.jd-price') || document.querySelector('.p-price strong') || document.querySelector('[class*="price"] [class*="num"]');
            const pm = (priceEl ? priceEl.textContent : '') || '';
            const dm = pm.replace(/\\s+/g, '').match(/(?:¥|￥)?(\\d{2,7}(?:\\.\\d{1,2})?)/);
            if (dm) price = dm[1];
          }

          // Reviews: rating + comment count from body text (best effort).
          const ratingMatch = pageText.match(/(\\d\\.\\d)\\s*[分分评分]/) || pageText.match(/评分[：:]?\\s*(\\d\\.\\d)/);
          if (ratingMatch) rating = ratingMatch[1] + ' 分';
          const countMatch = pageText.match(/(\\d[\\d,，.]*万?)\\s*[条名]*\\s*(?:评价|好评|用户评价|评论)/);
          if (countMatch) commentCount = countMatch[1];

          lines.push('# ' + title);
          lines.push('');
          lines.push('**店铺:** ' + shop);
          lines.push('**SKU:** ' + resolvedSku);
          if (price) lines.push('**价格:** ¥' + price);
          if (mainImage) lines.push('**主图:** ' + mainImage);
          lines.push('**URL:** ' + pageUrl);
          lines.push('');

          if (specs.length > 0) {
            lines.push('---');
            lines.push('');
            lines.push('## 规格参数');
            lines.push('');
            for (const s of Array.from(new Set(specs)).slice(0, 30)) {
              if (s && s.indexOf(':') > 0) lines.push('- ' + s);
            }
            lines.push('');
          }

          if (rating || commentCount) {
            lines.push('---');
            lines.push('');
            lines.push('## 用户评价');
            lines.push('');
            if (rating) lines.push('- 评分: ' + rating);
            if (commentCount) lines.push('- 评价数: ' + commentCount + ' 条');
            lines.push('');
          }

          let text = lines.join('\\n');
          if (text.length > maxLength) {
            text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
          }

          return { kind: 'ok', text: text, title: title };
        })()
      `;

      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        const jdResult = result as JdResult;
        if (jdResult.kind === 'ok') {
          return this.success(type, jdResult.text || '', undefined, { title: jdResult.title });
        }
        return this.error(type, jdResult.detail || 'extraction failed');
      }
      return this.error(type, 'Unexpected result format');
    } catch (e) {
      return this.error(type, `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const jdExtractor = new JdExtractor();