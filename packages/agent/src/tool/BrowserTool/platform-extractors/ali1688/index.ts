/**
 * 1688 Offer Page Extractor
 * Extracts offer title, price tiers, MOQ, sales count, seller/shop and image
 * data from detail.1688.com/offer/<offerId>.html by reading the embedded
 * `window.context` JSON model (via cdp.evaluate) plus DOM fallbacks.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

// 'ali1688' is not (yet) a member of the PlatformContentType union; keep the
// literal but assert so the contract stays strictly typed without touching types.ts.
const TYPE = 'ali1688' as PlatformContent['type'];

// ── Page payload shapes ─────────────────────────────────────────────────

interface SellerInfo {
  companyName?: string;
  memberId?: string;
  winportUrl?: string;
  sellerWinportUrlMap?: { defaultUrl?: string; indexUrl?: string };
}

interface PriceTier {
  beginAmount?: unknown;
  price?: string;
}

interface TradeInfo {
  unit?: string;
  priceDisplay?: string;
  beginAmount?: unknown;
  saleCount?: unknown;
  offerIDatacenterSellInfo?: Record<string, unknown>;
  offerPriceModel?: { currentPrices?: PriceTier[] };
}

interface GalleryInfo {
  mainImage?: unknown[];
  offerImgList?: unknown[];
  wlImageInfos?: Array<{ fullPathImageURI?: string }>;
}

interface ServiceItem {
  serviceName?: string;
  agreeDeliveryHours?: number;
}

interface ShippingInfo {
  protectionInfos?: ServiceItem[];
  buyerProtectionModel?: ServiceItem[];
  deliveryLimitText?: string;
  logisticsText?: string;
}

interface ItemPayload {
  href?: string;
  title?: string;
  bodyText?: string;
  offerTitle?: string;
  offerId?: string;
  seller?: SellerInfo | null;
  trade?: TradeInfo | null;
  gallery?: GalleryInfo | null;
  shipping?: ShippingInfo | null;
  services?: ServiceItem[];
}

// ── Normalized view ─────────────────────────────────────────────────────

interface NormAttr {
  key: string;
  value: string;
}

interface NormTier {
  quantity_text: string;
  price_text: string;
}

interface NormItem {
  offerId: string;
  title: string;
  priceText: string;
  moqText: string;
  salesText: string;
  sellerName: string;
  shopUrl: string;
  originPlace: string;
  deliveryDays: string;
  attributes: NormAttr[];
  priceTiers: NormTier[];
  services: string[];
  images: string[];
}

// ── Captcha / login wall detection ──────────────────────────────────────

const WALL_URL_MARKERS = ['/_____tmd_____/punish'];
const WALL_TEXT_PATTERNS = [
  '请拖动下方滑块完成验证',
  '请按住滑块，拖动到最右边',
  '通过验证以确保正常访问',
  '验证码拦截',
  '访问验证',
  '滑动验证',
];
const LOGIN_TEXT_PATTERNS = [
  '请登录',
  '登录后',
  '账号登录',
  '手机登录',
  '立即登录',
  '扫码登录',
  '请先完成登录',
  '请先登录后查看',
];

// ── Text / numeric helpers ──────────────────────────────────────────────

function cleanText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function cleanMultilineText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim();
    if (!normalized) return null;
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function uniqueNonEmpty(values: unknown[]): string[] {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function reduceWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Field extraction helpers (ported from OpenCLI clis/1688) ────────────

function extractOfferId(input: string): string {
  const normalized = cleanText(input);
  if (!normalized) return '';
  return (
    normalized.match(/^\d{6,}$/)?.[0] ??
    normalized.match(/\/offer\/(\d{6,})\.html/i)?.[1] ??
    normalized.match(/[?&]offerId=(\d{6,})/i)?.[1] ??
    ''
  );
}

function parsePriceText(text: string): { text: string; currency: string } {
  const normalized = cleanText(text);
  const matches = normalized.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];
  const values = matches.map((value) => Number.parseFloat(value.replace(/,/g, ''))).filter((value) => Number.isFinite(value));
  const currency = normalized.includes('¥') || normalized.includes('元') ? 'CNY' : '';
  if (values.length === 0) return { text: normalized, currency };
  if (values.length === 1) return { text: `¥${values[0]}`, currency: currency || 'CNY' };
  return { text: `¥${values[0]}-${values[values.length - 1]}`, currency: currency || 'CNY' };
}

function parseMoqText(text: string): string {
  const normalized = normalizeNumericText(cleanText(text));
  const match =
    normalized.match(/(\d+(?:\.\d+)?)\s*(件|个|套|箱|包|双|台|把|只|pcs|piece|pieces)?\s*起批/i) ??
    normalized.match(/≥\s*(\d+(?:\.\d+)?)/);
  return match ? match[0] : normalized;
}

function normalizeNumericText(text: string): string {
  return text
    .replace(/([¥$€])\s+(?=\d)/g, '$1')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')
    .replace(/\s*([~-])\s*/g, '$1')
    .trim();
}

function normalizePriceTiers(rawTiers: PriceTier[], unit: string): NormTier[] {
  return (rawTiers ?? [])
    .map((tier) => {
      const quantityMin = toNumber(tier.beginAmount);
      const priceText = cleanText(tier.price);
      if (!priceText) return null;
      return {
        quantity_text: quantityMin !== null ? `${quantityMin}${unit || ''}` : '',
        price_text: priceText.startsWith('¥') ? priceText : `¥${priceText}`,
      };
    })
    .filter((tier): tier is NormTier => tier !== null);
}

function normalizeVisibleAttributes(raw: unknown): NormAttr[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .filter(([key, value]) => key !== 'sellPointModel' && cleanText(key) !== '' && cleanText(value) !== '')
    .map(([key, value]) => ({ key: cleanText(key), value: cleanText(value) }));
}

const CHINA_PROVINCES = [
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
  '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
];

function extractLocation(text: string): string {
  const normalized = cleanMultilineText(text);
  const primaryRegion = normalized.split(/送至|发往/)[0] ?? normalized;
  for (const line of primaryRegion.split('\n')) {
    const compact = cleanText(line);
    if (!compact || compact.length > 16) continue;
    if (CHINA_PROVINCES.some((location) => compact.startsWith(location))) return compact;
  }
  const pattern = new RegExp(`(${CHINA_PROVINCES.join('|')})[\\u4e00-\\u9fa5]{0,8}`);
  return primaryRegion.match(pattern)?.[0] ?? '';
}

function extractSalesText(bodyText: string): string {
  const match = bodyText.match(/(?:全网销量|已售)\s*\d+(?:\.\d+)?\+?\s*[件套个单]?/);
  return match ? cleanText(match[0]) : '';
}

function extractMoqText(bodyText: string, beginAmount: unknown, unit: string): string {
  const lineMatch = bodyText.match(/\d+(?:\.\d+)?\s*(件|个|套|箱|包|双|台|把|只|pcs|piece|pieces)\s*起批/i);
  if (lineMatch) return lineMatch[0];
  const moqValue = toNumber(beginAmount);
  if (moqValue !== null) return `${moqValue}${unit || ''}起批`;
  return '';
}

function extractDeliveryDaysText(bodyText: string, services: ServiceItem[], shipping?: ShippingInfo | null): string {
  const shippingText = cleanText(shipping?.deliveryLimitText) || cleanText(shipping?.logisticsText);
  if (shippingText) return shippingText;
  const textMatch = bodyText.match(/\d+\s*(?:小时|天)(?:内)?发货/);
  if (textMatch) return textMatch[0];
  const hourMatch = (services ?? []).find((service) => typeof service.agreeDeliveryHours === 'number');
  if (hourMatch?.agreeDeliveryHours !== undefined) {
    return `${hourMatch.agreeDeliveryHours}小时内发货`;
  }
  return '';
}

function collectServices(payload: ItemPayload): ServiceItem[] {
  const combined = [
    ...(Array.isArray(payload.services) ? payload.services : []),
    ...(Array.isArray(payload.shipping?.protectionInfos) ? payload.shipping.protectionInfos : []),
    ...(Array.isArray(payload.shipping?.buyerProtectionModel) ? payload.shipping.buyerProtectionModel : []),
  ];
  const seen = new Set<string>();
  const result: ServiceItem[] = [];
  for (const service of combined) {
    const key = cleanText(service.serviceName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(service);
  }
  return result;
}

function collectImages(gallery?: GalleryInfo | null): string[] {
  const images = uniqueNonEmpty([
    ...(Array.isArray(gallery?.mainImage) ? gallery.mainImage : []),
    ...(Array.isArray(gallery?.offerImgList) ? gallery.offerImgList : []),
    ...((gallery?.wlImageInfos ?? []).map((item) => item.fullPathImageURI ?? '')),
  ]);
  // Resolve protocol-relative URLs.
  return images.map((image) => (image.startsWith('//') ? `https:${image}` : image));
}

function isWall(payload: ItemPayload): boolean {
  const href = cleanText(payload.href).toLowerCase();
  const title = cleanText(payload.title);
  const body = cleanMultilineText(payload.bodyText);
  if (WALL_URL_MARKERS.some((marker) => href.includes(marker))) return true;
  return (
    WALL_TEXT_PATTERNS.some((pattern) => title.includes(pattern) || body.includes(pattern)) ||
    LOGIN_TEXT_PATTERNS.some((pattern) => title.includes(pattern) || body.includes(pattern))
  );
}

export class Ali1688Extractor extends BaseExtractor {
  name = 'ali1688';

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== '1688.com' && !host.endsWith('.1688.com')) return false;
    return /\/offer\/\d{6,}(?:\.html)?/i.test(parsed.pathname);
  }

  async extract(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed || !/^https?:\/\//i.test(url)) {
      return this.error(TYPE, 'Invalid 1688 URL');
    }

    try {
      const payload = await this.readPayload(cdp);

      // Anti-spider wall (login / slider challenge) with no product context.
      if (isWall(payload)) {
        return this.error(
          TYPE,
          '1688 showed a verification/login wall and no product data was exposed. ' +
            'Open a clean detail.1688.com offer page in the shared browser and finish any slider challenge before retrying.'
        );
      }

      const offerId = cleanText(payload.offerId) || extractOfferId(cleanText(payload.href));
      if (!offerId) {
        return this.error(TYPE, '1688 offer page did not expose product context (missing offer id).');
      }

      const item = this.normalize(payload, offerId);
      if (!item) {
        return this.error(TYPE, '1688 offer page exposed no readable product fields.');
      }

      const text = this.buildMarkdown(item, url, options?.maxLength);
      return this.success(TYPE, text, undefined, {
        title: item.title,
        offerId: item.offerId,
        price: item.priceText,
        moq: item.moqText,
        seller: item.sellerName,
      });
    } catch (e) {
      return this.error(TYPE, `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async readPayload(cdp: ICDPClient): Promise<ItemPayload> {
    const script = `(() => {
      const root = window.context ?? {};
      const model = root?.result?.global?.globalData?.model ?? null;
      const toJson = (value) => {
        try { return JSON.parse(JSON.stringify(value ?? null)); }
        catch { return null; }
      };
      return {
        href: window.location.href || '',
        title: document.title || '',
        bodyText: document.body ? document.body.innerText || '' : '',
        offerTitle: model?.offerTitleModel?.subject ?? '',
        offerId: model?.tradeModel?.offerId ?? '',
        seller: toJson(model?.sellerModel),
        trade: toJson(model?.tradeModel),
        gallery: toJson(root?.result?.data?.gallery?.fields ?? null),
        shipping: toJson(root?.result?.data?.shippingServices?.fields ?? null),
        services: toJson(Array.isArray(model?.services) ? model.services : (root?.result?.data?.shippingServices?.fields?.protectionInfos ?? [])),
      };
    })()`;
    const result = await cdp.evaluate(script);
    return (result as ItemPayload) ?? {};
  }

  private normalize(payload: ItemPayload, offerId: string): NormItem | null {
    const bodyText = cleanMultilineText(payload.bodyText);
    const seller = payload.seller ?? null;
    const trade = payload.trade ?? null;
    const unit = cleanText(trade?.unit);

    const sellerName = cleanText(seller?.companyName);
    const sellerUrlRaw = cleanText(
      seller?.winportUrl ??
      seller?.sellerWinportUrlMap?.defaultUrl ??
      seller?.sellerWinportUrlMap?.indexUrl
    );
    const shopUrl = this.canonicalizeShopUrl(sellerUrlRaw);

    const priceDisplay = cleanText(trade?.priceDisplay);
    const priceParsed = parsePriceText(priceDisplay ? `¥${priceDisplay}` : bodyText);
    const moqText = parseMoqText(extractMoqText(bodyText, trade?.beginAmount, unit));
    const salesText = toNumber(trade?.saleCount) !== null
      ? `已售${toNumber(trade?.saleCount)}+${unit || ''}`
      : extractSalesText(bodyText);

    const services = collectServices(payload);
    const serviceBadges = uniqueNonEmpty(services.map((service) => cleanText(service.serviceName)));
    const attributes = normalizeVisibleAttributes(trade?.offerIDatacenterSellInfo);
    const priceTiers = normalizePriceTiers(trade?.offerPriceModel?.currentPrices ?? [], unit);

    const title =
      cleanText(payload.offerTitle) ||
      cleanText(payload.title).replace(/\s*-\s*阿里巴巴$/, '').trim() ||
      firstNonEmptyLine(bodyText);

    if (!title && !priceParsed.text && !moqText && !sellerName) return null;

    return {
      offerId,
      title,
      priceText: priceParsed.text,
      moqText,
      salesText,
      sellerName,
      shopUrl,
      originPlace: extractLocation(bodyText),
      deliveryDays: extractDeliveryDaysText(bodyText, services, payload.shipping),
      attributes,
      priceTiers,
      services: serviceBadges,
      images: collectImages(payload.gallery),
    };
  }

  private canonicalizeShopUrl(input: string): string {
    const memberId = cleanText(input).match(/\bb2b-[a-z0-9]+\b/i)?.[0];
    if (memberId) return `https://winport.m.1688.com/page/index.html?memberId=${memberId}`;
    try {
      const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      const host = url.hostname.toLowerCase();
      if (!host.endsWith('.1688.com')) return '';
      const [subdomain] = host.split('.');
      if (!subdomain || ['www', 'detail', 's', 'winport', 'work', 'air', 'dj'].includes(subdomain)) return '';
      return `https://${host}`;
    } catch {
      return '';
    }
  }

  private buildMarkdown(item: NormItem, url: string, maxLength?: number): string {
    const lines: string[] = [];
    lines.push(`# ${item.title}`);
    lines.push('');

    if (item.priceText) {
      lines.push(`**价格:** ${item.priceText}`);
    }
    if (item.priceTiers.length > 0) {
      lines.push('');
      lines.push('**价格阶梯**');
      lines.push('');
      lines.push('| 起购量 | 单价 |');
      lines.push('| --- | --- |');
      for (const tier of item.priceTiers) {
        const qty = tier.quantity_text || '-';
        lines.push(`| ${qty} | ${tier.price_text} |`);
      }
    }
    if (item.moqText) {
      lines.push('');
      lines.push(`**最小起订 (MOQ):** ${item.moqText}`);
    }
    if (item.salesText) {
      lines.push(`**销量:** ${item.salesText}`);
    }
    if (item.originPlace) {
      lines.push(`**发货地:** ${item.originPlace}`);
    }
    if (item.deliveryDays) {
      lines.push(`**发货时效:** ${item.deliveryDays}`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');

    if (item.shopUrl) {
      lines.push(`**店铺:** [${item.sellerName || '查看店铺'}](${item.shopUrl})`);
    } else if (item.sellerName) {
      lines.push(`**店铺:** ${item.sellerName}`);
    }
    if (item.images.length > 0) {
      lines.push('');
      lines.push(`**商品图 (${item.images.length} 张)**`);
      lines.push('');
      item.images.slice(0, 5).forEach((image) => lines.push(`- ${image}`));
      if (item.images.length > 5) lines.push(`- … 等共 ${item.images.length} 张`);
    }

    const sellingPoints = item.services.filter((service) => !service.startsWith('48小时') && !service.startsWith('72小时'));
    if (sellingPoints.length > 0) {
      lines.push('');
      lines.push('### 服务与卖点');
      lines.push('');
      sellingPoints.slice(0, 8).forEach((point) => lines.push(`- ${point}`));
    }

    if (item.attributes.length > 0) {
      lines.push('');
      lines.push('### 商品参数');
      lines.push('');
      lines.push('| 属性 | 值 |');
      lines.push('| --- | --- |');
      item.attributes.forEach((attr) => lines.push(`| ${attr.key} | ${attr.value} |`));
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`**来源:** ${url}`);

    let text = reduceWhitespace(lines.join('\n'));
    if (maxLength && text.length > maxLength) text = this.truncate(text, maxLength);
    return text;
  }
}

function firstNonEmptyLine(text: string): string {
  return text.split('\n').map((line) => cleanText(line)).find(Boolean) ?? '';
}

export const ali1688Extractor = new Ali1688Extractor();