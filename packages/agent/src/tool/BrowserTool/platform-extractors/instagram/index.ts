/**
 * Instagram Content Extractor
 * Extracts single posts (photo/video/carousel) and user profiles by parsing
 * the embedded `shortcode_media` / profile JSON inside script tags, with og:
 * meta fallback. Instagram is a JS/SPA with heavy anti-bot controls, so we
 * read in-page state rather than hitting public HTTP APIs.
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type {
  PlatformContent,
  PlatformContentType,
  ExtractionOptions,
} from '../types.js';

/** In-page extraction result for a single post page. */
interface InstaPostResult {
  ok: boolean;
  error?: string;
  loginWall?: boolean;
  title?: string;
  shortcode?: string;
  username?: string;
  fullName?: string;
  caption?: string;
  likeCount?: number;
  commentCount?: number;
  takenAt?: string;
  mediaKind?: string;
  media?: string[];
  video?: string[];
  ogImage?: string;
}

/** In-page extraction result for a profile page. */
interface InstaProfileResult {
  ok: boolean;
  error?: string;
  loginWall?: boolean;
  username?: string;
  fullName?: string;
  bio?: string;
  followers?: number;
  following?: number;
  posts?: number;
  verified?: boolean;
  recent?: Array<{ shortcode: string; caption: string }>;
  ogTitle?: string;
  ogDescription?: string;
}

/** In-page extraction result for a story page. */
interface InstaStoryResult {
  ok: boolean;
  error?: string;
  loginWall?: boolean;
  media?: string[];
  video?: string[];
  ogImage?: string;
  ogTitle?: string;
}

const INSTAGRAM_INDEX = 'instagram' as PlatformContentType;
const POST_SEGMENTS = ['p', 'reel', 'reels', 'tv'];
const NON_PROFILE_SEGMENTS = new Set([
  'about',
  'accounts',
  'developers',
  'direct',
  'explore',
  'graphql',
  'help',
  'legal',
  'login',
  'maps',
  'oembed',
  'p',
  'policies',
  'reel',
  'reels',
  'session',
  'signup',
  'stories',
  'tags',
  'tv',
]);

export class InstagramExtractor extends BaseExtractor {
  name = 'instagram';

  matches(url: string): boolean {
    const parsed = this.parseUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'instagram.com' || host.endsWith('.instagram.com')) return true;
    // Cover direct reel / reels / tv / stories segment URLs on instagram hosts.
    const segments = parsed.pathname.split('/').filter(Boolean);
    const first = (segments[0] || '').toLowerCase();
    return host.endsWith('instagram.com') && /^(?:reel|reels|tv|stories)$/.test(first);
  }

  async extract(
    cdp: ICDPClient,
    url: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      return this.error(INSTAGRAM_INDEX, 'Invalid URL');
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const first = (segments[0] || '').toLowerCase();
    const isPost = POST_SEGMENTS.includes(first) && segments.length >= 2;
    const isStory = first === 'stories' && segments.length >= 3;

    try {
      if (isPost) {
        return await this.extractPost(cdp, url, options);
      }
      if (isStory) {
        return await this.extractStory(cdp, url, segments[1] || '', options);
      }
      if (!NON_PROFILE_SEGMENTS.has(first) && /^[\w._]+$/.test(first)) {
        return await this.extractProfile(cdp, url, options);
      }
      return this.error(INSTAGRAM_INDEX, 'Unsupported Instagram page: ' + parsed.pathname);
    } catch (e) {
      return this.error(
        INSTAGRAM_INDEX,
        `Extraction failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async extractPost(
    cdp: ICDPClient,
    url: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (() => {
        const matchEnd = (s, start) => {
          let depth = 0;
          let inStr = false;
          for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
              if (c === '\\\\') i++;
              else if (c === '"') inStr = false;
            } else {
              if (c === '{') depth++;
              else if (c === '}') {
                depth--;
                if (depth === 0) return i;
              } else if (c === '"') inStr = true;
            }
          }
          return -1;
        };

        const scripts = Array.prototype.map.call(
          document.querySelectorAll('script'),
          function (s) { return s.textContent || ''; }
        );

        const meta = (selector) => {
          const el = document.querySelector(selector);
          return el ? (el.getAttribute('content') || '') : '';
        };
        const ogTitle = meta('meta[property="og:title"]');
        const ogImage = meta('meta[property="og:image"]');
        const ogDescription = meta('meta[property="og:description"]');

        const hasLoginForm = !!document.querySelector(
          'input[name="username"], input[name="password"]'
        );
        const bodyText = (document.body && document.body.innerText) || '';
        const loginWall = hasLoginForm ||
          /log\\s+in\\s+to\\s+(see|like|view|read)/i.test(bodyText) ||
          /please\\s+log\\s+in\\s+to\\s+continue/i.test(bodyText);

        // Read the embedded shortcode_media object from __additionalDataLoaded /
        // _sharedData JSON inside a script tag.
        let media = null;
        for (let i = 0; i < scripts.length; i++) {
          const t = scripts[i];
          const ki = t.indexOf('"shortcode_media"');
          if (ki === -1) continue;
          const start = t.indexOf('{', ki);
          if (start === -1) continue;
          const end = matchEnd(t, start);
          if (end === -1) continue;
          try {
            const obj = JSON.parse(t.slice(start, end + 1));
            if (obj && typeof obj === 'object' && (obj.shortcode || obj.display_url)) {
              media = obj;
              break;
            }
          } catch (e) {}
        }

        if (!media) {
          if (loginWall) {
            return { ok: false, loginWall: true, error: 'Instagram requires login to view this post.' };
          }
          if (!ogTitle) {
            return { ok: false, error: 'Could not extract post data from this page.' };
          }
          // Minimal og: meta fallback.
          return {
            ok: true,
            shortcode: '',
            title: ogTitle,
            caption: ogDescription,
            mediaKind: 'photo',
            media: ogImage ? [ogImage] : [],
            video: [],
            ogImage: ogImage,
            error: 'Partial data: only og: meta was available on this page.'
          };
        }

        const edges = (media.edge_media_to_caption && media.edge_media_to_caption.edges) || [];
        const caption = (edges[0] && edges[0].node && edges[0].node.text) || '';
        const owner = media.owner || {};
        const likeCount = (media.edge_media_preview_like && media.edge_media_preview_like.count) || 0;
        const commentCount = (media.edge_media_to_comment && media.edge_media_to_comment.count) || 0;
        const takenAt = media.taken_at_timestamp
          ? new Date(media.taken_at_timestamp * 1000).toISOString()
          : '';

        const mediaUrls = [];
        const videoUrls = [];
        const childEdges = (media.edge_sidecar_to_children && media.edge_sidecar_to_children.edges) || [];
        if (childEdges.length > 0) {
          for (let j = 0; j < childEdges.length; j++) {
            const node = childEdges[j] && childEdges[j].node;
            if (!node) continue;
            if (node.is_video) {
              if (node.video_url) videoUrls.push(node.video_url);
              if (node.display_url) mediaUrls.push(node.display_url);
            } else if (node.display_url) {
              mediaUrls.push(node.display_url);
            }
          }
        } else if (media.is_video) {
          if (media.video_url) videoUrls.push(media.video_url);
        }
        if (media.display_url && mediaUrls.indexOf(media.display_url) === -1) {
          mediaUrls.push(media.display_url);
        }
        if (mediaUrls.length === 0 && ogImage) mediaUrls.push(ogImage);

        const mediaKind = childEdges.length > 0 ? 'carousel' : (media.is_video ? 'video' : 'photo');

        return {
          ok: true,
          shortcode: media.shortcode || '',
          username: owner.username || '',
          fullName: owner.full_name || '',
          caption: caption,
          likeCount: likeCount,
          commentCount: commentCount,
          takenAt: takenAt,
          mediaKind: mediaKind,
          media: mediaUrls,
          video: videoUrls,
          title: caption ? caption.replace(/\\n/g, ' ').substring(0, 80) : (ogTitle || (media.shortcode ? 'Instagram post' : '')),
          ogImage: ogImage
        };
      })()
    `;

    try {
      const raw = await cdp.evaluate(script);
      if (raw && typeof raw === 'object' && 'ok' in raw) {
        const result = raw as InstaPostResult;
        if (!result.ok) {
          return this.error(
            INSTAGRAM_INDEX,
            result.error || 'Unexpected failure extracting Instagram post'
          );
        }
        const text = this.renderPostMarkdown(result, url, maxLength);
        return this.success(INSTAGRAM_INDEX, text, undefined, {
          title: result.title || 'Instagram post',
        });
      }
      return this.error(INSTAGRAM_INDEX, 'Unexpected result format from page');
    } catch (e) {
      return this.error(
        INSTAGRAM_INDEX,
        `Evaluation error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async extractProfile(
    cdp: ICDPClient,
    url: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (() => {
        const matchEnd = (s, start) => {
          let depth = 0;
          let inStr = false;
          for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
              if (c === '\\\\') i++;
              else if (c === '"') inStr = false;
            } else {
              if (c === '{') depth++;
              else if (c === '}') {
                depth--;
                if (depth === 0) return i;
              } else if (c === '"') inStr = true;
            }
          }
          return -1;
        };

        const enclosingObject = (text, ki) => {
          let prev = text.lastIndexOf('{', ki);
          while (prev !== -1) {
            const end = matchEnd(text, prev);
            if (end > ki) {
              try { return JSON.parse(text.slice(prev, end + 1)); } catch (e) { return null; }
            }
            prev = text.lastIndexOf('{', prev - 1);
          }
          return null;
        };

        const scripts = Array.prototype.map.call(
          document.querySelectorAll('script'),
          function (s) { return s.textContent || ''; }
        );

        const meta = (selector) => {
          const el = document.querySelector(selector);
          return el ? (el.getAttribute('content') || '') : '';
        };
        const ogTitle = meta('meta[property="og:title"]');
        const ogDescription = meta('meta[property="og:description"]');

        const hasLoginForm = !!document.querySelector(
          'input[name="username"], input[name="password"]'
        );
        const bodyText = (document.body && document.body.innerText) || '';
        const loginWall = hasLoginForm ||
          /log\\s+in\\s+to\\s+(see|like|view|read)/i.test(bodyText) ||
          /this\\s+account\\s+is\\s+private/i.test(bodyText);

        // Find the profile user object (has biography + edge_owner_to_timeline_media).
        let user = null;
        for (let i = 0; i < scripts.length; i++) {
          const t = scripts[i];
          if (t.indexOf('"biography"') === -1 || t.indexOf('"edge_owner_to_timeline_media"') === -1) continue;
          const obj = enclosingObject(t, t.indexOf('"biography"'));
          if (
            obj &&
            typeof obj === 'object' &&
            typeof obj.username === 'string' &&
            typeof obj.edge_followed_by === 'object'
          ) {
            user = obj;
            break;
          }
        }

        if (!user) {
          if (loginWall) {
            return { ok: false, loginWall: true, error: 'Instagram requires login to view this profile.' };
          }
          if (!ogTitle) {
            return { ok: false, error: 'Could not extract profile data from this page.' };
          }
          return {
            ok: true,
            username: '',
            fullName: ogTitle,
            bio: '',
            followers: 0,
            following: 0,
            posts: 0,
            verified: false,
            recent: [],
            ogTitle: ogTitle,
            ogDescription: ogDescription,
            error: 'Partial data: only og: meta was available on this page.'
          };
        }

        const timeline = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media) || {};
        const edges = timeline.edges || [];
        const recent = [];
        for (let j = 0; j < Math.min(edges.length, 12); j++) {
          const node = edges[j] && edges[j].node;
          if (!node || !node.shortcode) continue;
          const capEdges = (node.edge_media_to_caption && node.edge_media_to_caption.edges) || [];
          const capText = (capEdges[0] && capEdges[0].node && capEdges[0].node.text) || '';
          recent.push({ shortcode: node.shortcode, caption: capText });
        }

        return {
          ok: true,
          username: user.username || '',
          fullName: user.full_name || '',
          bio: user.biography || '',
          followers: (user.edge_followed_by && user.edge_followed_by.count) || 0,
          following: (user.edge_follow && user.edge_follow.count) || 0,
          posts: (timeline && timeline.count) || 0,
          verified: !!user.is_verified,
          recent: recent,
          ogTitle: ogTitle,
          ogDescription: ogDescription
        };
      })()
    `;

    try {
      const raw = await cdp.evaluate(script);
      if (raw && typeof raw === 'object' && 'ok' in raw) {
        const result = raw as InstaProfileResult;
        if (!result.ok) {
          return this.error(
            INSTAGRAM_INDEX,
            result.error || 'Unexpected failure extracting Instagram profile'
          );
        }
        const text = this.renderProfileMarkdown(result, url, maxLength);
        return this.success(INSTAGRAM_INDEX, text, undefined, {
          title: result.username || result.fullName || result.ogTitle || 'Instagram profile',
        });
      }
      return this.error(INSTAGRAM_INDEX, 'Unexpected result format from page');
    } catch (e) {
      return this.error(
        INSTAGRAM_INDEX,
        `Evaluation error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async extractStory(
    cdp: ICDPClient,
    url: string,
    username: string,
    options?: ExtractionOptions
  ): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (() => {
        const matchEnd = (s, start) => {
          let depth = 0;
          let inStr = false;
          for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
              if (c === '\\\\') i++;
              else if (c === '"') inStr = false;
            } else {
              if (c === '{') depth++;
              else if (c === '}') {
                depth--;
                if (depth === 0) return i;
              } else if (c === '"') inStr = true;
            }
          }
          return -1;
        };

        const enclosingObject = (text, ki) => {
          let prev = text.lastIndexOf('{', ki);
          while (prev !== -1) {
            const end = matchEnd(text, prev);
            if (end > ki) {
              try { return JSON.parse(text.slice(prev, end + 1)); } catch (e) { return null; }
            }
            prev = text.lastIndexOf('{', prev - 1);
          }
          return null;
        };

        const scripts = Array.prototype.map.call(
          document.querySelectorAll('script'),
          function (s) { return s.textContent || ''; }
        );

        const meta = (selector) => {
          const el = document.querySelector(selector);
          return el ? (el.getAttribute('content') || '') : '';
        };
        const ogTitle = meta('meta[property="og:title"]');
        const ogImage = meta('meta[property="og:image"]');
        const ogVideo = meta('meta[property="og:video"]');

        const hasLoginForm = !!document.querySelector(
          'input[name="username"], input[name="password"]'
        );
        const bodyText = (document.body && document.body.innerText) || '';
        const loginWall = hasLoginForm ||
          /log\\s+in\\s+to\\s+(see|like|view|read)/i.test(bodyText) ||
          /this\\s+story\\s+is\\s+unavailable/i.test(bodyText);

        // Best-effort: pull video_versions (video) and image_versions2
        // (cover/still) out of the embedded story JSON.
        const media = [];
        const video = [];
        for (let i = 0; i < scripts.length; i++) {
          const t = scripts[i];
          const vi = t.indexOf('"video_versions"');
          if (vi !== -1) {
            const obj = enclosingObject(t, vi);
            if (obj) {
              const versions = obj.video_versions;
              if (Array.isArray(versions) && versions.length > 0) {
                const last = versions[versions.length - 1];
                if (last && typeof last.url === 'string' && video.indexOf(last.url) === -1) {
                  video.push(last.url);
                }
              }
              const candidates = (obj.image_versions2 && obj.image_versions2.candidates) || [];
              if (Array.isArray(candidates)) {
                for (let j = 0; j < candidates.length; j++) {
                  const c = candidates[j];
                  if (c && typeof c.url === 'string' && media.indexOf(c.url) === -1) {
                    media.push(c.url);
                  }
                }
              }
            }
          }
          const ii = t.indexOf('"image_versions2"');
          if (ii !== -1) {
            const obj = enclosingObject(t, ii);
            if (obj && Array.isArray(obj.candidates)) {
              for (let j = 0; j < obj.candidates.length; j++) {
                const c = obj.candidates[j];
                if (c && typeof c.url === 'string' && media.indexOf(c.url) === -1) {
                  media.push(c.url);
                }
              }
            }
          }
          if (media.length > 0 || video.length > 0) break;
        }

        if (media.length === 0 && video.length === 0) {
          if (loginWall) {
            return { ok: false, loginWall: true, error: 'Instagram requires login to view this story.' };
          }
          if (!ogImage && !ogVideo) {
            return { ok: false, error: 'Could not extract story data from this page.' };
          }
          // Minimal og: meta fallback.
          if (ogVideo) video.push(ogVideo);
          if (ogImage && media.indexOf(ogImage) === -1) media.push(ogImage);
        }
        if (ogImage && media.indexOf(ogImage) === -1) media.push(ogImage);
        if (ogVideo && video.indexOf(ogVideo) === -1) video.push(ogVideo);

        return {
          ok: true,
          media: media,
          video: video,
          ogImage: ogImage,
          ogTitle: ogTitle
        };
      })()
    `;

    try {
      const raw = await cdp.evaluate(script);
      if (raw && typeof raw === 'object' && 'ok' in raw) {
        const result = raw as InstaStoryResult;
        if (!result.ok) {
          return this.error(
            INSTAGRAM_INDEX,
            result.error || 'Unexpected failure extracting Instagram story'
          );
        }
        const text = this.renderStoryMarkdown(result, username, url, maxLength);
        const author = username || result.ogTitle || '';
        return this.success(INSTAGRAM_INDEX, text, undefined, {
          title: author ? `Instagram story by @${author}` : 'Instagram story',
        });
      }
      return this.error(INSTAGRAM_INDEX, 'Unexpected result format from page');
    } catch (e) {
      return this.error(
        INSTAGRAM_INDEX,
        `Evaluation error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private renderPostMarkdown(r: InstaPostResult, url: string, maxLength: number): string {
    const lines: string[] = [];
    lines.push(`# ${r.title || 'Instagram post'}`);
    lines.push('');
    if (r.fullName || r.username) {
      const author = r.username ? `@${r.username}` : '';
      lines.push(`**Author:** ${r.fullName ? r.fullName : ''}${r.fullName && author ? ' ' : ''}${author}`.trim());
    }
    if (r.shortcode) lines.push(`**Shortcode:** ${r.shortcode}`);
    if (r.mediaKind) lines.push(`**Type:** ${r.mediaKind}`);
    if (r.likeCount !== undefined) lines.push(`**Likes:** ${this.formatCount(r.likeCount)}`);
    if (r.commentCount !== undefined) lines.push(`**Comments:** ${this.formatCount(r.commentCount)}`);
    if (r.takenAt) lines.push(`**Posted:** ${this.formatDate(r.takenAt)}`);
    lines.push(`**URL:** ${url}`);
    if (r.error) {
      lines.push('');
      lines.push(`_${r.error}_`);
    }
    lines.push('');

    if ((r.media || []).length > 0) {
      lines.push('---');
      lines.push('');
      const mediaLabel = r.mediaKind === 'video' ? 'Video' : r.mediaKind === 'carousel' ? 'Carousel Media' : 'Image';
      lines.push(`## ${mediaLabel}${(r.media || []).length > 1 ? ` (${(r.media || []).length})` : ''}`);
      lines.push('');
      for (const m of r.media || []) {
        lines.push(`- ${m}`);
      }
      lines.push('');
    }

    if ((r.video || []).length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## Video Stream');
      lines.push('');
      for (const v of r.video || []) lines.push(`- ${v}`);
      lines.push('');
    }

    if (r.caption) {
      lines.push('---');
      lines.push('');
      lines.push('## Caption');
      lines.push('');
      lines.push(r.caption);
      lines.push('');
    }

    let text = lines.join('\n');
    if (text.length > maxLength) text = this.truncate(text, maxLength);
    return text;
  }

  private renderProfileMarkdown(r: InstaProfileResult, url: string, maxLength: number): string {
    const lines: string[] = [];
    const display = r.fullName || r.username || r.ogTitle || 'Instagram profile';
    const handle = r.username ? ` (@${r.username})` : '';
    lines.push(`# ${display}${handle}`);
    lines.push('');

    if (r.followers !== undefined) lines.push(`**Followers:** ${this.formatCount(r.followers)}`);
    if (r.following !== undefined) lines.push(`**Following:** ${this.formatCount(r.following)}`);
    if (r.posts !== undefined) lines.push(`**Posts:** ${this.formatCount(r.posts)}`);
    lines.push(`**Verified:** ${r.verified ? 'Yes' : 'No'}`);
    lines.push(`**URL:** ${url}`);
    lines.push('');

    if (r.bio) {
      lines.push('---');
      lines.push('');
      lines.push('## Bio');
      lines.push('');
      lines.push(r.bio);
      lines.push('');
    }
    if (r.ogDescription) {
      lines.push('---');
      lines.push('');
      lines.push(r.ogDescription);
      lines.push('');
    }
    if (r.error) {
      lines.push('');
      lines.push(`_${r.error}_`);
      lines.push('');
    }

    if (r.recent && r.recent.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push(`## Recent Posts (${r.recent.length})`);
      lines.push('');
      for (const p of r.recent) {
        const postUrl = `https://www.instagram.com/p/${p.shortcode}/`;
        lines.push(`### ${p.caption ? this.truncate(p.caption.replace(/\s+/g, ' ').trim(), 120) : p.shortcode}`);
        lines.push('');
        lines.push(`**Link:** ${postUrl}`);
        lines.push('');
      }
    }

    let text = lines.join('\n');
    if (text.length > maxLength) text = this.truncate(text, maxLength);
    return text;
  }

  private renderStoryMarkdown(
    r: InstaStoryResult,
    username: string,
    url: string,
    maxLength: number
  ): string {
    const lines: string[] = [];
    const handle = username ? `@${username}` : '';
    lines.push(`# Instagram Story${handle ? ` by ${handle}` : ''}`);
    lines.push('');
    if (handle) lines.push(`**Author:** ${handle}`);
    lines.push(`**URL:** ${url}`);
    lines.push('');

    if ((r.video || []).length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## Story Video');
      lines.push('');
      for (const v of r.video || []) lines.push(`- ${v}`);
      lines.push('');
    }

    if ((r.media || []).length > 0) {
      lines.push('---');
      lines.push('');
      const label = (r.video || []).length > 0 ? 'Cover Image' : 'Story Image';
      const count = (r.media || []).length;
      lines.push(`## ${label}${count > 1 ? ` (${count})` : ''}`);
      lines.push('');
      for (const m of r.media || []) lines.push(`- ${m}`);
      lines.push('');
    }

    if (r.ogTitle) {
      lines.push('---');
      lines.push('');
      lines.push(r.ogTitle);
      lines.push('');
    }

    if (r.loginWall) {
      lines.push('');
      lines.push('_Instagram requires login to view this story._');
      lines.push('');
    }

    let text = lines.join('\n');
    if (text.length > maxLength) text = this.truncate(text, maxLength);
    return text;
  }

  private formatCount(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }

  private formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}

export const instagramExtractor = new InstagramExtractor();