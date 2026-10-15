/**
 * Xiaohongshu (rednote) Content Extractor
 * Extracts note detail (title / author / body / images / stats / tags / time)
 * and user profile (nickname / bio / follower & following counts / recent
 * notes) from xiaohongshu.com pages.
 *
 * The site is an SPA. Parsing prefers the embedded `window.__INITIAL_STATE__`
 * JSON (note detail under `.note` / `.noteDetailMap`, profile under
 * `.user.userPageData` / `.user.notes`) and falls back to OG meta tags and
 * DOM selectors when the in-page JSON is unavailable.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

// 'rednote' is delivered as a custom content type not (yet) present in the
// shared union; cast strictly (without `any`) so extractors keep type-tagging.
const TYPE = 'rednote' as unknown as PlatformContent['type'];

/** Raw note data extracted from the page for later markdown formatting. */
interface NoteData {
  title: string;
  desc: string;
  author: string;
  userId: string;
  time: string;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  tags: string[];
  images: string[];
  imageCount: number;
  securityBlock: boolean;
  loginWall: boolean;
  notFound: boolean;
}

interface ProfileNoteItem {
  id: string;
  title: string;
  type: string;
  likes: number;
}

/** Raw profile data extracted from the page for later markdown formatting. */
interface ProfileData {
  nickname: string;
  desc: string;
  redId: string;
  gender: string;
  followers: number;
  following: number;
  notes: ProfileNoteItem[];
  securityBlock: boolean;
  loginWall: boolean;
}

/**
 * In-page script that extracts note detail. Reads `__INITIAL_STATE__` first,
 * then falls back to OG meta + DOM selectors (mirrors OpenCLI's
 * xiaohongshu/note approach).
 */
const NOTE_EXTRACT_JS = `
  (async () => {
    const bodyText = document.body && document.body.innerText ? document.body.innerText : '';
    const locationHref = window.location.href;
    const path = window.location.pathname || '';

    const loginWall = path.indexOf('/login') === 0 || /登录后查看|请登录/.test(bodyText);
    const notFound = /页面不见了|笔记不存在|无法浏览|出错了/.test(bodyText);
    const securityBlock = /安全限制|访问链接异常|网络异常/.test(bodyText) || /error_code=300017|error_code=300031/.test(locationHref);

    const clean = (el) => (el && el.textContent ? String(el.textContent).replace(/\\s+/g, ' ').trim() : '');
    const str = (v) => (v == null ? '' : String(v).trim());
    const num = (v) => { if (v == null) return 0; const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };

    // --- Prefer in-page JSON ---
    const IS = window.__INITIAL_STATE__;
    let note = null;
    if (IS && typeof IS === 'object') {
      const noteState = IS.note && typeof IS.note === 'object' ? IS.note : null;
      const detailMap = noteState ? noteState.noteDetailMap : null;
      if (detailMap && typeof detailMap === 'object') {
        for (const key in detailMap) {
          const entry = detailMap[key];
          if (!entry || typeof entry !== 'object') continue;
          if (entry.note) { note = entry.note; break; }
          if (!note && Object.keys(entry).length > 0) { note = entry; break; }
        }
      }
      if (note == null && noteState && noteState.note) {
        note = noteState.note;
      }
    }

    if (note && typeof note === 'object') {
      const interact = note.interactInfo || note.interact_info || {};
      const user = note.user || {};
      const imageList = Array.isArray(note.imageList) ? note.imageList : (Array.isArray(note.images) ? note.images : []);
      const tagArr = Array.isArray(note.tagList) ? note.tagList : (Array.isArray(note.tags) ? note.tags : []);
      const tags = tagArr.map((t) => (typeof t === 'object' && t ? String(t.name || '').trim() : String(t == null ? '' : t).trim())).filter((t) => t);
      const images = imageList.map((img) => (img && typeof img === 'object' ? String(img.urlDefault || img.urlPre || img.url || '') : '')).filter((u) => u);
      const time = note.time !== undefined ? str(note.time) : (note.lastUpdateTime !== undefined ? str(note.lastUpdateTime) : '');
      return {
        kind: 'note',
        title: str(note.title) || str(note.displayTitle),
        desc: str(note.desc) || str(note.descStr),
        author: str(note.userName) || str(user.nickname) || str(note.user_name),
        userId: str(user.userId) || str(user.user_id),
        time: time,
        likes: num(interact.likedCount != null ? interact.likedCount : interact.liked_count),
        collects: num(interact.collectedCount != null ? interact.collectedCount : interact.collected_count),
        comments: num(interact.commentCount != null ? interact.commentCount : interact.comment_count),
        shares: num(interact.shareCount != null ? interact.shareCount : interact.share_count),
        tags: tags,
        images: images,
        imageCount: images.length,
        securityBlock: securityBlock,
        loginWall: loginWall,
        notFound: notFound
      };
    }

    // --- OG meta + DOM fallback ---
    const ogTitle = document.querySelector('meta[property="og:title"]') ? document.querySelector('meta[property="og:title"]').getAttribute('content') || '' : '';
    const ogDesc = document.querySelector('meta[property="og:description"]') ? document.querySelector('meta[property="og:description"]').getAttribute('content') || '' : '';
    const ogImage = document.querySelector('meta[property="og:image"]') ? document.querySelector('meta[property="og:image"]').getAttribute('content') || '' : '';

    const domTitle = clean(document.querySelector('#detail-title')) || clean(document.querySelector('.title'));
    const domDesc = clean(document.querySelector('#detail-desc')) || clean(document.querySelector('.desc')) || clean(document.querySelector('.note-text'));
    const domAuthor = clean(document.querySelector('.username')) || clean(document.querySelector('.author-wrapper .name'));
    const domLikes = clean(document.querySelector('.interact-container .like-wrapper .count'));
    const domCollects = clean(document.querySelector('.interact-container .collect-wrapper .count'));
    const domComments = clean(document.querySelector('.interact-container .chat-wrapper .count'));

    const domTags = [];
    document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach((el) => {
      const t = String((el.textContent || '')).trim();
      if (t) domTags.push(t);
    });

    return {
      kind: 'note',
      title: domTitle || ogTitle,
      desc: domDesc || ogDesc,
      author: domAuthor,
      userId: '',
      time: '',
      likes: num(domLikes),
      collects: num(domCollects),
      comments: num(domComments),
      shares: 0,
      tags: domTags,
      images: ogImage ? [ogImage] : [],
      imageCount: ogImage ? 1 : 0,
      securityBlock: securityBlock,
      loginWall: loginWall,
      notFound: notFound
    };
  })()
`;

/**
 * In-page script that extracts user profile from `__INITIAL_STATE__.user`
 * (pageData with basicInfo/interactions, plus notes groups).
 */
const PROFILE_EXTRACT_JS = `
  (async () => {
    const bodyText = document.body && document.body.innerText ? document.body.innerText : '';
    const path = window.location.pathname || '';

    const loginWall = path.indexOf('/login') === 0;
    const securityBlock = /安全限制|访问链接异常/.test(bodyText) || /error_code=300017|error_code=300031/.test(window.location.href);

    const str = (v) => (v == null ? '' : String(v).trim());
    const num = (v) => { if (v == null) return 0; const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };

    const IS = window.__INITIAL_STATE__;
    const user = IS && typeof IS === 'object' && IS.user && typeof IS.user === 'object' ? IS.user : null;
    const pageData = user ? (user.userPageData && user.userPageData._value ? user.userPageData._value : user.userPageData) : null;
    const basic = (pageData && pageData.basicInfo) || {};

    const interactions = Array.isArray(pageData ? pageData.interactions : null) ? pageData.interactions : [];
    const pick = (keys) => {
      for (let i = 0; i < interactions.length; i++) {
        const n = String((interactions[i] && interactions[i].name) || '').toLowerCase();
        for (let k = 0; k < keys.length; k++) {
          if (n.indexOf(keys[k]) > -1) return num(interactions[i].count);
        }
      }
      return 0;
    };
    const followers = pick(['fan', 'follower', '粉丝']);
    const following = pick(['following', 'follows', '关注']);

    const notes = [];
    const seen = {};
    const groups = user ? (user.notes && user.notes._value ? user.notes._value : user.notes) : null;
    if (Array.isArray(groups)) {
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const list = Array.isArray(group) ? group : (group && typeof group === 'object' && Array.isArray(group.notes) ? group.notes : []);
        for (let li = 0; li < list.length; li++) {
          const entry = list[li];
          const card = entry && entry.noteCard ? entry.noteCard : entry;
          if (!card || typeof card !== 'object') continue;
          const id = str(card.noteId || card.note_id || card.id || '');
          if (!id || seen[id]) continue;
          seen[id] = true;
          const interact = card.interactInfo || card.interact_info || {};
          notes.push({
            id: id,
            title: str(card.displayTitle || card.display_title || card.title),
            type: str(card.type),
            likes: num(interact.likedCount != null ? interact.likedCount : interact.liked_count)
          });
        }
      }
    }

    return {
      kind: 'profile',
      nickname: str(basic.nickname),
      desc: str(basic.desc),
      redId: str(basic.redId),
      gender: str(basic.gender),
      followers: followers,
      following: following,
      notes: notes.slice(0, 20),
      securityBlock: securityBlock,
      loginWall: loginWall
    };
  })()
`;

export class RednoteExtractor extends BaseExtractor {
  name = 'rednote';

  private hosts = ['xiaohongshu.com', 'www.xiaohongshu.com', 'rednote.com', 'www.rednote.com'];

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
      return this.error(TYPE, 'Invalid URL');
    }

    try {
      const pathname = parsed.pathname;
      if (/^\/(explore|discovery\/item)\//.test(pathname)) {
        return this.extractNote(cdp, url, options);
      }
      if (/^\/user\/profile\//.test(pathname)) {
        return this.extractProfile(cdp, url);
      }
      return this.error(TYPE, '不支持的页面类型：只支持笔记详情（/explore/、/discovery/item/）和用户主页（/user/profile/）');
    } catch (e) {
      return this.error(TYPE, `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractNote(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    try {
      const result = await cdp.evaluate(NOTE_EXTRACT_JS);
      if (!result || typeof result !== 'object') {
        return this.error(TYPE, 'Unexpected result format from note page');
      }
      const d = result as NoteData;

      if (d.securityBlock) {
        return this.error(TYPE, '小红书笔记被风控拦截（anti-bot / risk control），无法提取内容');
      }
      if (d.loginWall) {
        return this.error(TYPE, '小红书笔记需要登录后才能查看（login required）');
      }
      if (d.notFound) {
        return this.error(TYPE, '笔记不存在或已删除/受限（note not found）');
      }
      if (!d.title && !d.author && !d.desc) {
        return this.error(TYPE, '笔记页面加载后无可见内容，可能已删除或受限');
      }

      return this.success(TYPE, this.buildNoteMarkdown(d, url, options), undefined, {
        title: d.title || '小红书笔记',
      });
    } catch (e) {
      return this.error(TYPE, `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractProfile(cdp: ICDPClient, url: string): Promise<PlatformContent> {
    try {
      const result = await cdp.evaluate(PROFILE_EXTRACT_JS);
      if (!result || typeof result !== 'object') {
        return this.error(TYPE, 'Unexpected result format from profile page');
      }
      const d = result as ProfileData;

      if (d.securityBlock) {
        return this.error(TYPE, '小红书主页被风控拦截（anti-bot / risk control），无法提取内容');
      }
      if (d.loginWall) {
        return this.error(TYPE, '小红书主页需要登录后才能查看（login required）');
      }
      if (!d.nickname) {
        return this.error(TYPE, '未能读取到用户资料，可能已删除或受限');
      }

      return this.success(TYPE, this.buildProfileMarkdown(d, url), undefined, {
        title: d.nickname || '小红书用户主页',
      });
    } catch (e) {
      return this.error(TYPE, `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildNoteMarkdown(d: NoteData, url: string, options?: ExtractionOptions): string {
    const maxLength = options?.maxLength ?? 12000;
    const lines: string[] = [];

    lines.push(`# ${d.title || '小红书笔记'}`);
    lines.push('');

    if (d.author) {
      lines.push(`**作者:** ${d.author}${d.userId ? `（ID: ${d.userId}）` : ''}`);
    }
    if (d.time) {
      lines.push(`**发布时间:** ${d.time}`);
    }
    lines.push(`**图片数量:** ${d.imageCount}`);
    if (d.likes || d.collects || d.comments || d.shares) {
      lines.push(`**赞:** ${d.likes} · **收藏:** ${d.collects} · **评论:** ${d.comments}${d.shares ? ` · **分享:** ${d.shares}` : ''}`);
    }
    lines.push(`**链接:** ${url}`);
    lines.push('');

    if (d.desc) {
      lines.push('---');
      lines.push('');
      lines.push(d.desc);
      lines.push('');
    }

    if (d.tags.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push(`**标签:** ${d.tags.map((t) => `#${t}`).join(' ')}`);
      lines.push('');
    }

    if (d.images.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('**图片链接:**');
      lines.push('');
      for (const img of d.images) {
        lines.push(`- ${img}`);
      }
    }

    let text = lines.join('\n');
    if (text.length > maxLength) {
      text = text.substring(0, maxLength) + '\n\n*[内容已截断]*';
    }
    return text;
  }

  private buildProfileMarkdown(d: ProfileData, url: string): string {
    const lines: string[] = [];

    lines.push(`# ${d.nickname || '小红书用户'}${d.redId ? `（${d.redId}）` : ''}`);
    lines.push('');
    lines.push(`**粉丝:** ${d.followers} · **关注:** ${d.following}`);
    lines.push(`**链接:** ${url}`);
    if (d.desc) {
      lines.push('');
      lines.push(`**简介:** ${d.desc}`);
    }

    if (d.notes.length > 0) {
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('## 最近笔记');
      lines.push('');
      for (const n of d.notes) {
        const label = n.title || '（无标题）';
        const typePart = n.type ? ` [${n.type}]` : '';
        lines.push(`- ${label}${typePart}（赞 ${n.likes}）`);
      }
    }

    return lines.join('\n');
  }
}

export const rednoteExtractor = new RednoteExtractor();