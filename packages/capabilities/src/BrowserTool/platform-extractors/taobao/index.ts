/**
 * Taobao Content Extractor
 * Extracts product title, price, images, shop name, sales count,
 * SKU/props and a description summary from an item page via page analysis.
 * Taobao's anti-spider is aggressive, so a login/captcha/slider wall is
 * detected explicitly instead of returning misleading data.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

/**
 * Result shape returned from the in-page evaluation script.
 */
interface TaobaoResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  error?: string;
}

// 'taobao' is not part of the PlatformContentType union yet (types.ts is
// owned by the parent scope), so cast the literal through unknown.
const TAOBAO_TYPE = 'taobao' as unknown as PlatformContent['type'];

export class TaobaoExtractor extends BaseExtractor {
  name = 'taobao';

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    return (
      parsed.hostname === 'taobao.com' ||
      parsed.hostname === 'www.taobao.com' ||
      parsed.hostname === 'item.taobao.com' ||
      parsed.hostname.endsWith('.taobao.com')
    );
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error(TAOBAO_TYPE, 'Invalid URL');
    }

    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (() => {
        const maxLength = ${maxLength};
        const url = ${JSON.stringify(url)};
        const normalize = (v) => (v || '').replace(/\\s+/g, ' ').trim();
        const bodyText = (document.body && document.body.innerText) || '';

        // ---- Title ----
        const titleEl = document.querySelector(
          '[class*="mainTitle--"], [class*="ItemTitle--"], .tb-main-title, [id="J_DetailMeta"] h3'
        );
        const fallbackTitle = normalize((document.title || '').split('-')[0]);
        const title = titleEl ? normalize(titleEl.textContent || '') : fallbackTitle;

        // ---- Price ----
        const pricePattern = /[￥¥]\\s*(\\d+(?:\\.\\d{1,2})?)/g;
        const prices = [];
        let m;
        while ((m = pricePattern.exec(bodyText)) && prices.length < 6) {
          const p = parseFloat(m[1]);
          if (p > 0.1 && p < 100000) prices.push(p);
        }
        const price = prices.length ? '¥' + Math.min.apply(null, prices) : '';

        // ---- Sales count ----
        const salesMatch =
          bodyText.match(/(\\d+万?\\d*\\+?)\\s*人付款/) || bodyText.match(/月销\\s*(\\d+万?\\d*\\+?)/);
        const sales = salesMatch ? salesMatch[0] : '';

        // ---- Shop name ----
        const shopEl = document.querySelector(
          '[class*="ShopName--"], .tb-shop-name, [id="shopExtra"] .slogo-shopname, [class*="shop-nickShopName--"]'
        );
        const shop =
          (shopEl ? normalize(shopEl.textContent || '') : '') ||
          (bodyText.match(/([\\u4e00-\\u9fa5A-Za-z0-9]{2,15}(?:旗舰店|专卖店|企业店|专营店|自营))/) || [])[1] ||
          '';

        // ---- Description summary ----
        const metaDesc =
          document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

        // ---- SKU / props ----
        const props = [];
        if (bodyText.indexOf('颜色分类') >= 0) {
          const s = bodyText.indexOf('颜色分类');
          const section = bodyText
            .substring(s, s + 300)
            .split('\\n')
            .map(function (x) { return x.trim(); })
            .filter(function (l) { return l.length > 2 && l.length < 50; });
          for (let i = 0; i < section.length && props.length < 8; i++) {
            if (section[i] !== '颜色分类') props.push(section[i]);
          }
        }

        // ---- Images ----
        const images = [];
        const imgSeen = {};
        const pushImg = (u) => {
          if (typeof u !== 'string') return;
          const c = u.split('?')[0].replace(/_\\d+x\\d+[^/]*$/, '');
          if (/\\.(jpg|jpeg|png|webp)$/i.test(c) && !imgSeen[c]) {
            imgSeen[c] = 1;
            images.push(c);
          }
        };
        document.querySelectorAll('img[src*="alicdn"], img[data-src*="alicdn"], img[src*="tbimg"]').forEach(
          function (img) {
            if (img.getAttribute('data-src')) pushImg(img.getAttribute('data-src'));
            pushImg(img.getAttribute('src'));
          }
        );
        const scanJson = (o) => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) {
            for (let i = 0; i < o.length; i++) {
              if (typeof o[i] === 'string') pushImg(o[i]);
              else scanJson(o[i]);
            }
            return;
          }
          for (const k in o) {
            const v = o[k];
            if (typeof v === 'string') pushImg(v);
            else if (v && typeof v === 'object') scanJson(v);
          }
        };
        scanJson(window.__GLOBAL_DATA);
        scanJson(window.g_config);

        // ---- Anti-spider wall detection ----
        const captcha =
          /验证码|滑块|滑动验证|人机验证|访问过于频繁|请升级您的浏览器/.test(bodyText);
        if (!title && captcha) {
          return {
            kind: 'error',
            error:
              '淘宝页面被反爬验证(验证码/滑块/登录墙)拦截，未获取到商品数据，请先手动完成验证后再访问。',
            title: ''
          };
        }

        // ---- Build markdown ----
        const itemId = (new URL(location.href) || {}).searchParams
          ? new URL(location.href).searchParams.get('id') || ''
          : '';

        const lines = [];
        lines.push('# ' + (title || fallbackTitle || '淘宝商品'));
        lines.push('');
        if (price) lines.push('**价格:** ' + price);
        if (sales) lines.push('**销量:** ' + sales);
        if (shop) lines.push('**店铺:** ' + shop);
        if (itemId) lines.push('**商品ID:** ' + itemId);
        lines.push('**链接:** ' + url);

        if (images.length) {
          lines.push('');
          lines.push('## 商品图片');
          lines.push('');
          images.slice(0, 9).forEach(function (u) { lines.push('![](' + u + ')'); });
        }

        if (props.length) {
          lines.push('');
          lines.push('## 规格/属性');
          lines.push('');
          props.forEach(function (p) { lines.push('- ' + p); });
        }

        if (metaDesc) {
          lines.push('');
          lines.push('## 商品简介');
          lines.push('');
          lines.push(normalize(metaDesc).slice(0, 800));
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return { kind: 'ok', text: text, title: title };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        const r = result as Partial<TaobaoResult>;
        if (r.kind === 'error') {
          return this.error(TAOBAO_TYPE, r.error || 'Extraction failed');
        }
        return this.success(TAOBAO_TYPE, r.text || '', undefined, { title: r.title });
      }
      return this.error(TAOBAO_TYPE, 'Unexpected result format');
    } catch (e) {
      return this.error(
        TAOBAO_TYPE,
        `Evaluation error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

export const taobaoExtractor = new TaobaoExtractor();