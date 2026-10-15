/**
 * Weibo Extractor — single status/post or hot-search list, sourced from the
 * public m.weibo.cn JSON APIs (no browser / login required). On pages that
 * require authentication and expose no data it fails with a clear message.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';
import { publicFetchJson } from '../_shared/public-api.js';

const HOT_CONTAINER_ID = '106003type=25&t=3&disable_hot=1&filter_type=realtimehot';

interface MWeiboUser {
  screen_name?: string;
  id?: number;
  avatar_hd?: string;
}

interface MWeiboRetweeted {
  user?: MWeiboUser;
  text?: string;
  text_raw?: string;
}

interface MWeiboPost {
  idstr?: string;
  mblogid?: string;
  user?: MWeiboUser;
  text?: string;
  text_raw?: string;
  created_at?: string;
  source?: string;
  reposts_count?: number;
  comments_count?: number;
  attitudes_count?: number;
  pic_num?: number;
  pic_ids?: string[];
  pics?: Array<{ url?: string; pid?: string }>;
  isLongText?: boolean;
  retweeted_status?: MWeiboRetweeted;
}

interface MWeiboStatusData {
  data?: MWeiboPost;
}

interface HotItem {
  rank: number;
  word: string;
  heat: string;
  label: string;
}

interface HotCardGroup {
  desc?: string;
  desc_extr?: string;
  icon_desc?: string;
  url?: string;
}

interface HotCard {
  card_group?: HotCardGroup[];
}

interface HotData {
  cards?: HotCard[];
}

interface MWeiboHotData {
  data?: HotData;
}

export class WeiboExtractor extends BaseExtractor {
  name = 'weibo';

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'weibo.com' || host === 'www.weibo.com' || host === 'm.weibo.cn';
  }

  async extract(_cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 20000;
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error('weibo' as PlatformContent['type'], 'Invalid URL');
    }

    const host = parsed.hostname.toLowerCase();
    if (this.isHotUrl(host, parsed.pathname)) {
      return this.extractHot(maxLength);
    }

    const mid = this.extractMid(host, parsed);
    if (!mid) {
      return this.error('weibo' as PlatformContent['type'], 'Unrecognized Weibo URL (expected /status/<id> or /detail/<id>)');
    }
    return this.extractStatus(mid, maxLength);
  }

  private isHotUrl(host: string, pathname: string): boolean {
    const cleanPath = pathname.split('?')[0];
    if (host === 'm.weibo.cn') {
      return cleanPath === '/' || cleanPath === '/hot' || cleanPath === '/p/' || cleanPath.startsWith('/p/');
    }
    return cleanPath === '/hot' || cleanPath.startsWith('/hot/') || cleanPath === '/' || cleanPath.startsWith('/weibo/');
  }

  private extractMid(host: string, parsed: URL): string | null {
    const path = parsed.pathname.split('?')[0];
    const m =
      path.match(/^\/(?:status|detail)\/([A-Za-z0-9]+)(?:[/?#]|$)/) ||
      path.match(/^\/\d+\/([A-Za-z0-9]{8,})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  private async extractHot(maxLength: number): Promise<PlatformContent> {
    // m.weibo.cn hot-search list is the stable public API and works for both
    // weibo.com/hot and m.weibo.cn entry points.
    const api = new URL('https://m.weibo.cn/api/container/getIndex');
    api.searchParams.set('containerid', HOT_CONTAINER_ID);
    api.searchParams.set('title', '微博热搜');
    api.searchParams.set('data_type', '1');

    const res = await publicFetchJson<MWeiboHotData>(api.toString(), { timeoutMs: 15000 });
    if (!res.ok || !res.data) {
      return this.error('weibo' as PlatformContent['type'], res.error || `HTTP ${res.status}`);
    }

    const items: HotItem[] = [];
    for (const card of res.data.data?.cards ?? []) {
      for (const group of card.card_group ?? []) {
        const word = (group.desc ?? '').trim();
        if (!word) continue;
        items.push({
          rank: items.length + 1,
          word,
          heat: (group.desc_extr ?? '').trim(),
          label: (group.icon_desc ?? '').trim(),
        });
      }
    }

    if (items.length === 0) {
      return this.error('weibo' as PlatformContent['type'], 'Weibo hot-search returned no data (possibly blocked by login or anti-spider)');
    }

    const lines: string[] = [];
    lines.push('# 微博热搜');
    lines.push('');
    for (const item of items) {
      const label = item.label ? ` [${item.label}]` : '';
      const heat = item.heat ? ` · 热度 ${item.heat}` : '';
      lines.push(`${item.rank}. ${item.word}${label}${heat}`);
      lines.push(`   https://s.weibo.com/weibo?q=${encodeURIComponent(`#${item.word}#`)}`);
    }

    let text = lines.join('\n');
    if (text.length > maxLength) text = this.truncate(text, maxLength);
    return this.success('weibo' as PlatformContent['type'], text, undefined, { title: '微博热搜' });
  }

  private async extractStatus(mid: string, maxLength: number): Promise<PlatformContent> {
    const api = new URL(`https://m.weibo.cn/status/show`);
    api.searchParams.set('id', mid);

    const res = await publicFetchJson<MWeiboStatusData>(api.toString(), { timeoutMs: 15000 });
    if (!res.ok || !res.data) {
      return this.error('weibo' as PlatformContent['type'], res.error || `HTTP ${res.status}`);
    }

    const post = res.data.data;
    if (!post || (!post.idstr && !post.mblogid && !post.text)) {
      return this.error('weibo' as PlatformContent['type'], 'Weibo post not found — the page may require login or is blocked by anti-spider');
    }

    const user = post.user ?? {};
    const author = user.screen_name ?? '未知用户';
    const body = this.stripHtml(post.text_raw || post.text || '');
    const created = post.created_at ?? '';
    const source = post.source ? this.stripHtml(post.source) : '';

    const lines: string[] = [];
    lines.push(`# ${author}`);
    lines.push('');
    if (body) {
      lines.push(body);
      lines.push('');
    }

    const linesMeta: string[] = [];
    linesMeta.push(`- 作者 ${author}`);
    if (post.idstr) linesMeta.push(`- 微博ID ${post.idstr}`);
    if (created) linesMeta.push(`- 发布时间 ${created}`);
    if (source) linesMeta.push(`- 来源 ${source}`);
    if (post.mblogid) linesMeta.push(`- 链接 https://weibo.com/${user.id ?? ''}/${post.mblogid}`);

    const imageUrls = this.imageUrls(post);
    if (imageUrls.length > 0) {
      linesMeta.push(`- 图片 ${imageUrls.length} 张`);
    }
    lines.push(linesMeta.join('\n'));

    if (imageUrls.length > 0) {
      lines.push('');
      lines.push('### 图片');
      for (const img of imageUrls) lines.push(`- ${img}`);
    }

    lines.push('');
    lines.push('### 数据');
    lines.push(
      `转发 ${post.reposts_count ?? 0} · 评论 ${post.comments_count ?? 0} · 点赞 ${post.attitudes_count ?? 0}`,
    );

    if (post.retweeted_status) {
      const rt = post.retweeted_status;
      const rtUser = rt.user ?? {};
      const rtText = this.stripHtml(rt.text_raw || rt.text || '');
      lines.push('');
      lines.push('### 转发的原微博');
      lines.push(`**${rtUser.screen_name ?? '[已删除]'}**: ${rtText}`);
    }

    let text = lines.join('\n');
    if (text.length > maxLength) text = this.truncate(text, maxLength);
    return this.success('weibo' as PlatformContent['type'], text, undefined, { title: author });
  }

  private imageUrls(post: MWeiboPost): string[] {
    if (Array.isArray(post.pics)) {
      const urls = post.pics
        .map((p) => p.url ?? (p.pid ? `https://wx2.sinaimg.cn/large/${p.pid}.jpg` : ''))
        .filter((u) => u.length > 0);
      if (urls.length > 0) return urls;
    }
    return (post.pic_ids ?? []).map((pid) => `https://wx2.sinaimg.cn/large/${pid}.jpg`);
  }
}

export const weiboExtractor = new WeiboExtractor();