/**
 * Xianyu (闲鱼 / Goofish) Item Content Extractor
 * Extracts product detail (title, price, description, images, seller info)
 * from a Goofish item page via in-page evaluation.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

/**
 * 'xianyu' is not (yet) a member of the PlatformContentType union in types.ts.
 * We must emit exactly this string as the content type, so we widen through
 * `unknown` to keep the build TS-strict without modifying types.ts.
 */
const XIANYU = 'xianyu' as unknown as PlatformContent['type'];

/**
 * Structured result returned by the in-page evaluation script.
 */
interface XianyuItemResult {
  kind: 'ok' | 'error';
  code?: string;
  message?: string;
  itemId?: string;
  title?: string;
  description?: string;
  price?: string;
  originalPrice?: string;
  wantCount?: string;
  collectCount?: string;
  browseCount?: string;
  status?: string;
  condition?: string;
  brand?: string;
  category?: string;
  location?: string;
  sellerName?: string;
  sellerId?: string;
  sellerUrl?: string;
  sellerScore?: string;
  replyRatio24h?: string;
  replyInterval?: string;
  imageUrls?: string[];
  itemUrl?: string;
}

const EXTRACT_SCRIPT = `
(async () => {
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();

  const href = String(window.location.href || '');
  const searchParams = new URL(href).searchParams;
  const pathParts = String(window.location.pathname || '').split('/');
  let pathId = '';
  for (let i = 0; i < pathParts.length - 1; i++) {
    const seg = pathParts[i + 1] || '';
    if (pathParts[i] === 'item' && /^\\d+$/.test(seg)) { pathId = seg; break; }
  }
  const itemId = searchParams.get('id') || pathId || '';

  const bodyText = document.body ? (document.body.innerText || '') : '';
  if (/请先登录|登录后|登录闲鱼/.test(bodyText)) {
    return { kind: 'error', code: 'auth-required', itemId: itemId };
  }
  if (/验证码|安全验证|异常访问/.test(bodyText)) {
    return { kind: 'error', code: 'blocked', itemId: itemId };
  }

  const deepFind = (obj, pred, depth) => {
    if (depth > 8 || obj == null || typeof obj !== 'object') return null;
    if (pred(obj)) return obj;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const r = deepFind(obj[i], pred, depth + 1);
        if (r) return r;
      }
      return null;
    }
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const r = deepFind(obj[keys[i]], pred, depth + 1);
      if (r) return r;
    }
    return null;
  };
  const isItem = (v) => !!v && typeof v === 'object' && typeof v.itemId !== 'undefined' && typeof v.title === 'string';
  const isSeller = (v) => !!v && typeof v === 'object' && (typeof v.sellerId !== 'undefined' || typeof v.nick === 'string') && (typeof v.publishCity !== 'undefined' || typeof v.city !== 'undefined');

  let item = null;
  let seller = null;

  // 1) Embedded JSON state / page props
  const sources = [];
  if (typeof window.__INITIAL_STATE__ !== 'undefined') sources.push(window.__INITIAL_STATE__);
  if (typeof window.__NEXT_DATA__ !== 'undefined') sources.push(window.__NEXT_DATA__);
  if (typeof window.__NUXT__ !== 'undefined') sources.push(window.__NUXT__);

  for (let s = 0; s < sources.length && !item; s++) {
    const src = sources[s];
    const it = deepFind(src, isItem, 0);
    if (it) { item = it; seller = deepFind(src, isSeller, 0) || seller; }
  }

  // 2) mtop API fallback (as used by Goofish' own page runtime)
  if (!item && window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function' && itemId) {
    try {
      const response = await window.lib.mtop.request({
        api: 'mtop.taobao.idle.pc.detail',
        data: { itemId: itemId },
        type: 'POST', v: '1.0', dataType: 'json',
        needLogin: false, needLoginPC: false, sessionOption: 'AutoLoginOnly', ecode: 0
      });
      const data = (response && response.data) || {};
      if (data.itemDO && isItem(data.itemDO)) item = data.itemDO;
      if (data.sellerDO && typeof data.sellerDO === 'object') seller = data.sellerDO;
    } catch (e) {
      return { kind: 'error', code: 'mtop-failed', itemId: itemId, message: clean(e && e.message) };
    }
  }

  if (!item) {
    return { kind: 'error', code: 'not-found', itemId: itemId, message: '未在页面中找到商品数据（可能需要登录或页面未加载完成）' };
  }

  const labels = Array.isArray(item.itemLabelExtList) ? item.itemLabelExtList : [];
  const findLabel = (name) => {
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (clean(l && l.propertyText) === name) return clean(l && l.text);
    }
    return '';
  };

  const imageInfos = Array.isArray(item.imageInfos) ? item.imageInfos : [];
  const images = [];
  for (let i = 0; i < imageInfos.length; i++) {
    const u = imageInfos[i] && imageInfos[i].url;
    if (u) images.push(clean(u));
  }

  const price = '¥' + (clean(item.soldPrice || item.defaultPrice || '')).replace(/^¥\\s*$/, '');
  const sellerId = seller ? String(seller.sellerId || '') : '';
  const sellerUrl = sellerId ? 'https://www.goofish.com/personal?userId=' + encodeURIComponent(sellerId) : '';

  return {
    kind: 'ok',
    itemId: clean(item.itemId || itemId),
    title: clean(item.title || ''),
    description: clean(item.desc || ''),
    price: price,
    originalPrice: clean(item.originalPrice || ''),
    wantCount: String(item.wantCnt == null ? '' : item.wantCnt),
    collectCount: String(item.collectCnt == null ? '' : item.collectCnt),
    browseCount: String(item.browseCnt == null ? '' : item.browseCnt),
    status: clean(item.itemStatusStr || ''),
    condition: findLabel('成色'),
    brand: findLabel('品牌'),
    category: findLabel('分类'),
    location: clean((seller && (seller.publishCity || seller.city)) || ''),
    sellerName: clean((seller && (seller.nick || seller.uniqueName)) || ''),
    sellerId: sellerId,
    sellerUrl: sellerUrl,
    sellerScore: clean((seller && seller.xianyuSummary) || ''),
    replyRatio24h: clean((seller && seller.replyRatio24h) || ''),
    replyInterval: clean((seller && seller.replyInterval) || ''),
    imageUrls: images,
    itemUrl: 'https://www.goofish.com/item?id=' + encodeURIComponent(itemId)
  };
})()
`;

export class XianyuExtractor extends BaseExtractor {
  name = 'xianyu';

  private hosts = ['goofish.com', 'taobao.com'];

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    return this.hosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error(XIANYU, '无效的闲鱼链接');
    }

    try {
      const result = await cdp.evaluate(EXTRACT_SCRIPT);
      if (!result || typeof result !== 'object') {
        return this.error(XIANYU, '闲鱼商品页未返回有效数据');
      }

      const r = result as XianyuItemResult;
      if (r.kind === 'error') {
        return this.error(XIANYU, this.mapError(r.code, r.message));
      }
      if (!r.title) {
        return this.error(XIANYU, '未获取到商品标题，可能页面需要登录或商品已下架');
      }

      const markdown = this.buildMarkdown(r, options);
      return this.success(XIANYU, markdown, undefined, { title: r.title });
    } catch (e) {
      return this.error(XIANYU, `提取失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildMarkdown(r: XianyuItemResult, options?: ExtractionOptions): string {
    const descCap = options?.maxLength ?? 12000;
    const lines: string[] = [];

    lines.push(`# ${r.title || '闲鱼商品'}`);
    lines.push('');
    lines.push(`**价格：** ${r.price || '未知'}`);
    if (r.originalPrice) lines.push(`**原价：** ${r.originalPrice}`);
    if (r.condition) lines.push(`**成色：** ${r.condition}`);
    if (r.brand) lines.push(`**品牌：** ${r.brand}`);
    if (r.category) lines.push(`**分类：** ${r.category}`);
    if (r.status) lines.push(`**状态：** ${r.status}`);
    if (r.location) lines.push(`**地区：** ${r.location}`);
    if (r.sellerName || r.sellerUrl) {
      lines.push(`**卖家：** ${r.sellerName || '未知'}${r.sellerUrl ? `（[查看主页](${r.sellerUrl})）` : ''}`);
    }
    if (r.replyRatio24h) lines.push(`**24小时回复率：** ${r.replyRatio24h}`);
    if (r.replyInterval) lines.push(`**回复时长：** ${r.replyInterval}`);
    if (r.sellerScore) lines.push(`**商家信誉：** ${r.sellerScore}`);
    lines.push(`**宝贝ID：** ${r.itemId || '（未提供）'}`);
    if (r.itemUrl) lines.push(`**链接：** ${r.itemUrl}`);

    const counts: string[] = [];
    if (r.wantCount) counts.push(`想要 ${r.wantCount}`);
    if (r.collectCount) counts.push(`收藏 ${r.collectCount}`);
    if (r.browseCount) counts.push(`浏览 ${r.browseCount}`);
    if (counts.length > 0) lines.push(`**数据：** ${counts.join(' · ')}`);

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 描述');
    lines.push('');
    lines.push(this.truncate(r.description || '（无描述）', descCap));
    lines.push('');

    if (r.imageUrls && r.imageUrls.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push(`## 图片（${r.imageUrls.length}）`);
      lines.push('');
      for (const imageUrl of r.imageUrls) lines.push(`- ${imageUrl}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private mapError(code?: string, message?: string): string {
    switch (code) {
      case 'auth-required':
        return '闲鱼商品详情需要已登录的浏览器会话（请先登录 goofish.com）';
      case 'blocked':
        return '闲鱼页面被验证码或风险控制拦截';
      case 'not-found':
        return message || '未在页面中找到商品数据';
      case 'mtop-failed':
        return message || '闲鱼商品详情接口调用失败';
      default:
        return message || '提取失败';
    }
  }
}

export const xianyuExtractor = new XianyuExtractor();