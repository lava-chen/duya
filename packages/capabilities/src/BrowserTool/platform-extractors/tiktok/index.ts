/**
 * TikTok Content Extractor
 * Best-effort extraction of single videos (/video/, /reel/, /photo/) and user
 * profiles (/@user) from the anti-bot JS SPA. Relies primarily on the embedded
 * rehydration JSON (window.__UNIVERSAL_DATA_FOR_REHYDRATION__ and friends),
 * falling back to og:* meta tags when the page is rendered out of reach
 * (login / geo / anti-bot wall).
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

/**
 * 'tiktok' is not yet part of the PlatformContentType union. We keep the tag
 * literal here so it stays DRY and exactly 'tiktok' without touching types.ts.
 */
const TIKTOK_TYPE = 'tiktok' as PlatformContent['type'];

interface TikTokResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

// Browser-side helper bundle, pasted into each page-evaluate IIFE so the JSON
// walking helpers run in the live SPA document (cookies + msToken forwarded by
// the browser). Ported from OpenCLI clis/tiktok/utils.js.
const BROWSER_HELPERS = `
function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, maxLength ?? 500);
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatCount(value) {
  if (value === null || value === undefined) return '0';
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
  return String(value);
}

function findUniversalData() {
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const script of scripts) {
    const text = script.textContent || '';
    if (!text || text.length < 32) continue;
    const trimmed = text.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) continue;
    if (
      !text.includes('webapp.user-detail') &&
      !text.includes('webapp.recommend-feed') &&
      !text.includes('ItemModule') &&
      !text.includes('itemList') &&
      !text.includes('itemStruct') &&
      !text.includes('userInfo')
    ) {
      continue;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      // TikTok keeps several JSON-like script tags; keep scanning.
    }
  }
  return null;
}

function walkObjects(root, visit) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (visit(current) === true) return true;
    if (Array.isArray(current)) {
      for (const value of current) stack.push(value);
      continue;
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return false;
}

function metaContent(selector) {
  const el = document.querySelector(selector);
  return el ? el.getAttribute('content') || '' : '';
}
`;

export class TikTokExtractor extends BaseExtractor {
  name = 'tiktok';

  private hosts = ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];

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
      return this.error(TIKTOK_TYPE, 'Invalid TikTok URL');
    }

    try {
      // Single video: /@user/video/<id>, /@user/reel/<id>, /@user/photo/<id>
      const videoMatch = parsed.pathname.match(/^\/@([A-Za-z0-9._-]+)\/(video|reel|photo)\/(\d+)\/?$/);
      if (videoMatch) {
        return this.extractVideo(cdp, url, videoMatch[3], options);
      }

      // User profile: /@user
      if (parsed.pathname.match(/^\/@[A-Za-z0-9._-]+\/?$/)) {
        const username = parsed.pathname.replace(/^\/@/, '').replace(/\/$/, '');
        return this.extractProfile(cdp, url, username, options);
      }

      return this.error(TIKTOK_TYPE, 'Unsupported TikTok page type');
    } catch (e) {
      return this.error(TIKTOK_TYPE, `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractVideo(
    cdp: ICDPClient,
    url: string,
    videoId: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const targetId = ${JSON.stringify(videoId)};
        const targetUrl = ${JSON.stringify(url)};

        ${BROWSER_HELPERS}

        function findVideoItem(root, id) {
          let found = null;
          walkObjects(root, (node) => {
            if (Array.isArray(node)) return false;
            const nodeId = String(node.id || node.item_id || node.video_id || '');
            if (nodeId === id && (node.author || node.authorInfo || node.video || node.stats)) {
              found = node;
              return true;
            }
            return false;
          });
          return found;
        }

        function buildMarkdown(info) {
          const lines = [];
          const title = info.title || 'TikTok Video';
          lines.push('# ' + title);
          lines.push('');
          if (info.authorLink) {
            lines.push('**Author:** [' + info.authorName + '](' + info.authorLink + ')');
          } else {
            lines.push('**Author:** ' + (info.authorName || 'Unknown'));
          }
          if (info.verified) {
            lines.push('**Verified:** Yes');
          }
          if (info.plays !== null) {
            lines.push('**Plays:** ' + formatCount(info.plays));
          }
          if (info.likes !== null) {
            lines.push('**Likes:** ' + formatCount(info.likes));
          }
          if (info.comments !== null) {
            lines.push('**Comments:** ' + formatCount(info.comments));
          }
          if (info.shares !== null) {
            lines.push('**Shares:** ' + formatCount(info.shares));
          }
          if (info.music) {
            lines.push('**Music:** ' + info.music);
          }
          lines.push('**URL:** ' + targetUrl);
          if (info.cover) {
            lines.push('');
            lines.push('![cover](' + info.cover + ')');
          }
          if (info.desc) {
            lines.push('');
            lines.push('---');
            lines.push('');
            lines.push('## Description');
            lines.push('');
            lines.push(info.desc);
          }
          let text = lines.join('\\n');
          if (text.length > maxLength) {
            text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
          }
          return { text: text, title: title };
        }

        const info = {
          title: '',
          authorName: '',
          authorLink: '',
          verified: false,
          plays: null,
          likes: null,
          comments: null,
          shares: null,
          music: '',
          cover: '',
          desc: ''
        };

        const universal = findUniversalData();
        const item = findVideoItem(universal, targetId);

        if (item) {
          const author = item.author || item.authorInfo || {};
          const stats = item.stats || {};
          const video = item.video || {};
          const music = item.music || item.musicInfo || {};
          const uniqueId = String(author.uniqueId || author.unique_id || '').replace(/^@+/, '');
          info.authorName = cleanText(author.nickname || author.nickName || author.uniqueId || author.unique_id || '', 80) || uniqueId;
          if (uniqueId) {
            info.authorLink = 'https://www.tiktok.com/@' + encodeURIComponent(uniqueId);
          }
          info.verified = Boolean(author.verified || author.is_verified || author.custom_verify);
          info.plays = asNumber(stats.playCount ?? stats.play_count ?? stats.viewCount);
          info.likes = asNumber(stats.diggCount ?? stats.digg_count ?? stats.likeCount);
          info.comments = asNumber(stats.commentCount ?? stats.comment_count);
          info.shares = asNumber(stats.shareCount ?? stats.share_count);
          info.desc = cleanText(item.desc || item.title || item.description, 500);
          info.cover = String(video.cover || video.originCover || video.dynamicCover || video.coverUrl || item.cover || '');
          const musicTitle = cleanText(music.title || music.musicName || '', 120);
          const musicArtist = cleanText(music.artistName || music.authorName || music.author || '', 80);
          if (musicTitle) {
            info.music = musicArtist ? musicTitle + ' — ' + musicArtist : musicTitle;
          }
          info.title = cleanText(document.title.replace(/ - TikTok$/, ''), 200) || (info.desc ? info.desc.substring(0, 120) : 'TikTok Video');
        } else {
          // Rehydration JSON unavailable — fall back to og:* meta tags.
          info.title = cleanText(metaContent('meta[property="og:title"]'), 200);
          info.desc = cleanText(metaContent('meta[property="og:description"]'), 500);
          info.cover = metaContent('meta[property="og:image"]') || metaContent('meta[property="og:video"]');
          if (!info.title && !info.desc) {
            return {
              kind: 'error',
              detail: 'Unable to extract video data - TikTok is likely showing a login/geo/anti-bot wall.'
            };
          }
        }

        return { kind: 'ok', text: buildMarkdown(info).text, title: info.title };
      })()
    `;

    return this.evaluateResult(cdp, script);
  }

  private async extractProfile(
    cdp: ICDPClient,
    url: string,
    username: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const targetUsername = ${JSON.stringify(username)};
        const targetUsernameLower = targetUsername.toLowerCase();
        const targetUrl = ${JSON.stringify(url)};

        ${BROWSER_HELPERS}

        function findProfileUser(root) {
          let found = null;
          walkObjects(root, (node) => {
            if (Array.isArray(node)) return false;
            const user = node && (node.userInfo && node.userInfo.user || node.user);
            if (!user || typeof user !== 'object') return false;
            const uniqueId = String(user.uniqueId || user.unique_id || '').toLowerCase();
            if (uniqueId === targetUsernameLower && (user.secUid || user.sec_uid)) {
              found = user;
              return true;
            }
            return false;
          });
          return found;
        }

        function collectProfileItems(root, secUid) {
          if (!root) return [];
          const out = [];
          walkObjects(root, (node) => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
            const item = node.itemStruct || node.item || node;
            const id = item.id || item.item_id || item.video_id;
            const author = item.author || item.authorInfo || {};
            const authorName = String(author.uniqueId || author.unique_id || '').toLowerCase();
            const authorSecUid = String(author.secUid || author.sec_uid || '').trim();
            if (id && (authorName === targetUsernameLower || (secUid && authorSecUid === secUid))) {
              out.push(item);
            }
            return false;
          });
          return out;
        }

        function normalizeVideo(item) {
          const id = String(item.id || item.item_id || item.video_id || '').trim();
          const author = item.author || item.authorInfo || {};
          const authorName = String(author.uniqueId || author.unique_id || '').replace(/^@+/, '');
          if (!id) return null;
          return {
            id: id,
            title: cleanText(item.desc || item.title || '', 200),
            url: authorName
              ? 'https://www.tiktok.com/@' + encodeURIComponent(authorName) + '/video/' + encodeURIComponent(id)
              : ''
          };
        }

        function buildMarkdown(info, rows) {
          const lines = [];
          const displayName = info.nickname || info.uniqueId || targetUsername;
          const header = info.uniqueId ? displayName + ' (@' + info.uniqueId + ')' : displayName;
          lines.push('# ' + header);
          lines.push('');
          lines.push('**Profile:** ' + targetUrl);
          if (info.verified) {
            lines.push('**Verified:** Yes');
          }
          if (info.followers !== null) {
            lines.push('**Followers:** ' + formatCount(info.followers));
          }
          if (info.following !== null) {
            lines.push('**Following:** ' + formatCount(info.following));
          }
          if (info.likes !== null) {
            lines.push('**Likes:** ' + formatCount(info.likes));
          }
          if (info.videos !== null) {
            lines.push('**Videos:** ' + formatCount(info.videos));
          }
          lines.push('');
          if (info.bio) {
            lines.push('## Bio');
            lines.push('');
            lines.push(info.bio);
            lines.push('');
          }
          if (rows.length) {
            lines.push('---');
            lines.push('');
            lines.push('## Recent Videos (' + rows.length + ')');
            lines.push('');
            for (const v of rows) {
              lines.push('**' + (v.title || '[Untitled Video]') + '**');
              if (v.url) lines.push(v.url);
              lines.push('');
            }
          } else {
            lines.push('*No recent videos found - TikTok may require login or scroll-to-load.*');
          }
          let text = lines.join('\\n');
          if (text.length > maxLength) {
            text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
          }
          return { text: text, title: header };
        }

        const info = {
          nickname: '',
          uniqueId: targetUsername,
          secUid: '',
          bio: '',
          verified: false,
          followers: null,
          following: null,
          likes: null,
          videos: null
        };

        const universal = findUniversalData();
        const user = findProfileUser(universal);
        if (user) {
          const stats = user.stats || (user.userInfo && user.userInfo.stats) || {};
          info.nickname = cleanText(user.nickname || user.nickName || user.name, 80);
          info.uniqueId = String(user.uniqueId || user.unique_id || info.uniqueId).replace(/^@+/, '');
          info.secUid = String(user.secUid || user.sec_uid || '');
          info.bio = cleanText(user.signature || '', 300);
          info.verified = Boolean(user.verified || user.is_verified || user.custom_verify);
          info.followers = asNumber(stats.followerCount ?? stats.follower_count);
          info.following = asNumber(stats.followingCount ?? stats.following_count);
          info.likes = asNumber(stats.heartCount ?? stats.heart_count ?? stats.like_count);
          info.videos = asNumber(stats.videoCount ?? stats.video_count);
        }

        if (!info.nickname) {
          // Rehydration JSON unavailable — derive what we can from og meta tags.
          info.nickname = cleanText(metaContent('meta[property="og:title"]'), 200)
            .replace(/\\s*\\(@[^)]*\\)\\s*$/, '')
            .replace(/\\s*\\| TikTok$/, '');
          info.bio = info.bio || cleanText(metaContent('meta[name="description"]'), 300);
          info.uniqueId = targetUsername;
          info.secUid = user ? info.secUid : '';
        }

        const rawItems = collectProfileItems(universal, info.secUid);
        const seen = new Set();
        const rows = [];
        for (const item of rawItems) {
          const row = normalizeVideo(item);
          if (!row || seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push(row);
          if (rows.length >= 20) break;
        }

        const md = buildMarkdown(info, rows);
        return { kind: 'ok', text: md.text, title: md.title };
      })()
    `;

    return this.evaluateResult(cdp, script);
  }

  private async evaluateResult(cdp: ICDPClient, script: string): Promise<PlatformContent> {
    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        const typed = result as TikTokResult;
        if (typed.kind === 'ok') {
          return this.success(TIKTOK_TYPE, typed.text || '', undefined, { title: typed.title });
        }
        return this.error(TIKTOK_TYPE, typed.detail || 'Extraction failed');
      }
      return this.error(TIKTOK_TYPE, 'Unexpected result format from page evaluation');
    } catch (e) {
      return this.error(TIKTOK_TYPE, `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const tiktokExtractor = new TikTokExtractor();