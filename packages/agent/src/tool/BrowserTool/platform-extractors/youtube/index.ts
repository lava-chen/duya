/**
 * YouTube Content Extractor
 * Extracts video metadata, captions, and comments via page analysis
 */

import { BaseExtractor } from '../BaseExtractor.js';
import type { ICDPClient } from '../../CDPClient.js';
import type { PlatformContent, ExtractionOptions } from '../types.js';

interface YouTubeResult {
  kind: 'ok' | 'error';
  text?: string;
  title?: string;
  detail?: string;
}

export class YouTubeExtractor extends BaseExtractor {
  name = 'youtube';

  private hosts = ['youtube.com', 'www.youtube.com', 'youtu.be', 'music.youtube.com'];

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
      return this.error('youtube-video', 'Invalid URL');
    }

    try {
      // Detect page type
      const isWatchPage = parsed.pathname === '/watch' || parsed.pathname.startsWith('/watch');
      const isChannelPage = parsed.pathname.startsWith('/@') || parsed.pathname.startsWith('/channel/');
      const isPlaylistPage = parsed.pathname.startsWith('/playlist');
      const isSearchPage = parsed.pathname === '/results' || parsed.pathname.startsWith('/results');

      if (isWatchPage) {
        return this.extractVideo(cdp, url, options);
      } else if (isChannelPage) {
        return this.extractChannel(cdp, url, options);
      } else if (isPlaylistPage) {
        return this.extractPlaylist(cdp, url, options);
      } else if (isSearchPage) {
        return this.extractSearch(cdp, url, options);
      } else {
        return this.extractHome(cdp, url, options);
      }
    } catch (e) {
      return this.error('youtube-video', `Extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractVideo(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 12000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        // Try to get ytInitialData from the page
        const scripts = document.querySelectorAll('script');
        let initialData = null;

        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.includes('ytInitialData')) {
            const match = text.match(/ytInitialData\s*=\s*({.+?});/s);
            if (match) {
              try {
                initialData = JSON.parse(match[1]);
                break;
              } catch {}
            }
          }
        }

        // Get video ID
        const urlParams = new URLSearchParams(window.location.search);
        const videoId = urlParams.get('v') || '';

        // Extract video details
        const title = document.title.replace(' - YouTube', '').trim();

        // Try to get description from meta tags first
        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

        // Get channel info
        const channelLink = document.querySelector('#channel-name a') ||
                          document.querySelector('ytd-video-owner-renderer #channel-name a');
        const channelName = channelLink?.textContent?.trim() || '';
        const channelId = channelLink?.href?.match(/\\/(@[\\w]+|channel\\/[\\w]+)/)?.[1] || '';

        // Get view count
        const viewCountEl = document.querySelector('#count .view-count') ||
                           document.querySelector('ytd-video-view-count-renderer .view-count');
        const viewCountText = viewCountEl?.textContent?.trim() || '0';
        const viewCount = parseInt(viewCountText.replace(/[^0-9]/g, '')) || 0;

        // Get like count
        const likeCountEl = document.querySelector('like-button-view-model #segmented-like-dislike-button > yt-formatted-string');
        const likeCountText = likeCountEl?.textContent?.trim() || '0';
        const likeCount = parseInt(likeCountText.replace(/[^0-9]/g, '')) || 0;

        // Get upload date
        const dateEl = document.querySelector('#info .date') ||
                      document.querySelector('ytd-video-primary-info-renderer #info .date');
        const uploadDate = dateEl?.textContent?.trim() || '';

        // Get video duration
        const durationEl = document.querySelector('.ytp-time-duration') ||
                          document.querySelector('h1.ytd-video-primary-info-renderer');
        const duration = durationEl?.textContent?.trim() || '';

        // Get video description (from expandable section)
        const expandBtn = document.querySelector('#expand') ||
                        document.querySelector('button[aria-label*="more"]');
        if (expandBtn) {
          try { expandBtn.click(); } catch {}
          await new Promise(r => setTimeout(r, 500));
        }

        const descEl = document.querySelector('#description-inline-expander') ||
                     document.querySelector('#description') ||
                     document.querySelector('.ytd-video-secondary-info-renderer #description');
        let description = descEl?.textContent?.trim() || metaDesc;

        // Build output
        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**Channel:** [' + channelName + '](https://youtube.com/' + channelId + ')');
        lines.push('**Video ID:** ' + videoId);

        if (viewCount > 0) {
          lines.push('**Views:** ' + this.formatCount(viewCount));
        }
        if (likeCount > 0) {
          lines.push('**Likes:** ' + this.formatCount(likeCount));
        }
        if (uploadDate) {
          lines.push('**Uploaded:** ' + uploadDate);
        }

        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        if (description) {
          lines.push('---');
          lines.push('');
          lines.push('## Description');
          lines.push('');
          lines.push(description.substring(0, 3000));
        }

        // --- Transcript / subtitles (best-effort, never fails the extract) ---
        let transcriptMarkdown = null;
        try {
          const vid = videoId;
          const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

          function parseJson3(text) {
            let data = null;
            try { data = JSON.parse(text); } catch { return null; }
            if (!data || !Array.isArray(data.events)) return null;
            const rows = [];
            for (const ev of data.events) {
              if (!ev || !Array.isArray(ev.segs)) continue;
              const startMs = Number(ev.tStartMs || 0);
              const durMs = Number(ev.dDurationMs || 0);
              const line = ev.segs.map((seg) => (seg && seg.utf8) || '').join('').replace(/\\s+/g, ' ').trim();
              if (!line) continue;
              rows.push({ start: startMs / 1000, end: (startMs + durMs) / 1000, text: line });
            }
            return rows.length ? rows : null;
          }

          function timedtextMatches(u) {
            try {
              const p = new URL(u, location.origin);
              return p.searchParams.get('v') === vid;
            } catch { return false; }
          }

          function extractJsonAssignment(html, key) {
            const markers = [key + '=', 'window[' + key + '] = '];
            for (const marker of markers) {
              let idx = html.indexOf(marker);
              while (idx !== -1) {
                const start = html.indexOf('{', idx + marker.length);
                if (start !== -1) {
                  let depth = 0, inStr = false, quote = '', escape = false;
                  for (let i = start; i < html.length; i++) {
                    const ch = html[i];
                    if (escape) { escape = false; continue; }
                    if (inStr) {
                      if (ch === '\\\\') { escape = true; continue; }
                      if (ch === quote) inStr = false;
                      continue;
                    }
                    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
                    if (ch === '{') depth++;
                    else if (ch === '}') { depth--; if (depth === 0) return html.substring(start, i + 1); }
                  }
                }
                idx = html.indexOf(marker, idx + marker.length);
              }
            }
            return null;
          }

          function attr(str, name) {
            const needle = name + '="';
            const idx = str.indexOf(needle);
            if (idx === -1) return '';
            const start = idx + needle.length;
            const end = str.indexOf('"', start);
            if (end === -1) return '';
            return str.substring(start, end);
          }

          function decodeEnt(s) {
            return s
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'");
          }

          function parseCaptionXml(xml) {
            const isFormat3 = xml.indexOf('<p t="') !== -1;
            const marker = isFormat3 ? '<p ' : '<text ';
            const endMarker = isFormat3 ? '</p>' : '</text>';
            const rows = [];
            let pos = 0;
            while (true) {
              const tagStart = xml.indexOf(marker, pos);
              if (tagStart === -1) break;
              const contentStart = xml.indexOf('>', tagStart);
              if (contentStart === -1) break;
              const bodyStart = contentStart + 1;
              const tagEnd = xml.indexOf(endMarker, bodyStart);
              if (tagEnd === -1) break;
              const attrStr = xml.substring(tagStart + marker.length, contentStart);
              const content = xml.substring(bodyStart, tagEnd);
              let startSec = 0;
              let durSec = 0;
              if (isFormat3) {
                startSec = (parseFloat(attr(attrStr, 't')) || 0) / 1000;
                durSec = (parseFloat(attr(attrStr, 'd')) || 0) / 1000;
              } else {
                startSec = parseFloat(attr(attrStr, 'start')) || 0;
                durSec = parseFloat(attr(attrStr, 'dur')) || 0;
              }
              const text = decodeEnt(content.replace(/<[^>]+>/g, '')).replace(/\\s+/g, ' ').trim();
              if (text) rows.push({ start: startSec, end: startSec + durSec, text });
              pos = tagEnd + endMarker.length;
            }
            return rows.length ? rows : null;
          }

          function pickTrack(list) {
            return list.find((t) => t.languageCode === 'en' && t.kind !== 'asr')
              || list.find((t) => t.languageCode === 'en')
              || list.find((t) => t.kind !== 'asr')
              || list[0];
          }

          async function tryPlayerCapture() {
            const player = document.getElementById('movie_player');
            if (!player || typeof player.setOption !== 'function') return null;
            const tracklist = typeof player.getOption === 'function' ? player.getOption('captions', 'tracklist') : null;
            let track = null;
            if (Array.isArray(tracklist) && tracklist.length) {
              track = pickTrack(tracklist);
            } else {
              const resp = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
              const tracks = resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer
                ? resp.captions.playerCaptionsTracklistRenderer.captionTracks
                : null;
              if (Array.isArray(tracks) && tracks.length) track = pickTrack(tracks);
            }
            if (!track) return null;
            const origFetch = globalThis.fetch;
            const OrigXHR = globalThis.XMLHttpRequest;
            let captured = '';
            try {
              if (origFetch) {
                globalThis.fetch = (...args) => {
                  const res = origFetch.apply(globalThis, args);
                  try {
                    const req = args[0];
                    const reqUrl = typeof req === 'string' ? req : (req && req.url) || '';
                    if (reqUrl && reqUrl.includes('/api/timedtext') && timedtextMatches(reqUrl) && res && res.ok) {
                      res.clone().text().then((t) => { if (t && !captured) captured = t; }).catch(() => {});
                    }
                  } catch {}
                  return res;
                };
              }
              if (OrigXHR) {
                globalThis.XMLHttpRequest = class extends OrigXHR {
                  open(method, url, ...rest) {
                    this.__duyaTtUrl = typeof url === 'string' ? url : '';
                    return super.open(method, url, ...rest);
                  }
                  send(...args) {
                    this.addEventListener('load', () => {
                      try {
                        const u = this.__duyaTtUrl || this.responseURL || '';
                        if (!u.includes('/api/timedtext') || !timedtextMatches(u)) return;
                        if (this.status < 200 || this.status >= 300) return;
                        const t = typeof this.responseText === 'string' ? this.responseText : '';
                        if (t && !captured) captured = t;
                      } catch {}
                    });
                    return super.send(...args);
                  }
                };
              }
              try { if (player.loadModule) player.loadModule('captions'); } catch {}
              await sleep(500);
              try { player.setOption('captions', 'track', track); } catch {}
              try { if (player.playVideo) player.playVideo(); } catch {}
              for (let i = 0; i < 20; i++) {
                await sleep(400);
                if (captured) {
                  const parsed = parseJson3(captured);
                  if (parsed) return parsed;
                }
                let urls = [];
                try {
                  urls = performance.getEntriesByType('resource').map((e) => e.name)
                    .filter((u) => String(u).includes('/api/timedtext') && timedtextMatches(String(u)));
                } catch {}
                if (urls.length) {
                  try {
                    const resp = await fetch(String(urls[urls.length - 1]), { credentials: 'include' });
                    if (resp.ok) {
                      const parsed = parseJson3(await resp.text());
                      if (parsed) return parsed;
                    }
                  } catch {}
                }
              }
              return null;
            } finally {
              try { if (player.pauseVideo) player.pauseVideo(); } catch {}
              if (origFetch) globalThis.fetch = origFetch;
              if (OrigXHR) globalThis.XMLHttpRequest = OrigXHR;
            }
          }

          async function tryPageFallback() {
            try {
              const resp = await fetch('/watch?v=' + encodeURIComponent(vid), { credentials: 'include' });
              if (!resp.ok) return null;
              const html = await resp.text();
              const raw = extractJsonAssignment(html, 'ytInitialPlayerResponse');
              if (!raw) return null;
              const data = JSON.parse(raw);
              const tracks = data && data.captions && data.captions.playerCaptionsTracklistRenderer
                ? data.captions.playerCaptionsTracklistRenderer.captionTracks
                : null;
              if (!Array.isArray(tracks) || !tracks.length) return null;
              const track = tracks.find((t) => t.kind !== 'asr') || tracks[0];
              if (!track || typeof track.baseUrl !== 'string') return null;
              const url = track.baseUrl + (track.baseUrl.indexOf('?') === -1 ? '?' : '&') + 'fmt=srv3';
              const xresp = await fetch(url);
              if (!xresp.ok) return null;
              return parseCaptionXml(await xresp.text());
            } catch { return null; }
          }

          let transcriptRows = await tryPlayerCapture();
          if (!transcriptRows) transcriptRows = await tryPageFallback();

          if (transcriptRows && transcriptRows.length) {
            const SENTENCE_END = /[.!?\u3002\uFF01\uFF1F\uFF0E]["'\u2019\u201D)]*\s*$/;
            function groupBySentence(segs) {
              const groups = [];
              let buffer = '', bufferStart = 0, lastStart = 0;
              const flush = () => {
                if (buffer.trim()) { groups.push({ start: bufferStart, text: buffer.trim(), speakerChange: false }); buffer = ''; }
              };
              for (const seg of segs) {
                if (buffer && seg.start - lastStart > 20) flush();
                if (buffer && seg.start - bufferStart > 30) flush();
                if (!buffer) bufferStart = seg.start;
                buffer += (buffer ? ' ' : '') + seg.text;
                lastStart = seg.start;
                if (SENTENCE_END.test(seg.text)) flush();
              }
              flush();
              return groups;
            }
            function groupBySpeaker(segs) {
              const turns = [];
              let currentTurn = null, speakerIndex = -1, prevSegText = '';
              for (const seg of segs) {
                const isChange = /^>>/.test(seg.text);
                const cleanText = seg.text.replace(/^>>\s*/, '').replace(/^-\s+/, '');
                const prevEndsWithComma = /,\s*$/.test(prevSegText);
                const prevEndedSentence = (SENTENCE_END.test(prevSegText) || !prevSegText) && !prevEndsWithComma;
                const isRealChange = isChange && prevEndedSentence;
                if (isRealChange) {
                  if (currentTurn) turns.push(currentTurn);
                  speakerIndex = (speakerIndex + 1) % 2;
                  currentTurn = { start: seg.start, segments: [{ start: seg.start, text: cleanText }], speakerChange: true, speaker: speakerIndex };
                } else {
                  if (!currentTurn) currentTurn = { start: seg.start, segments: [], speakerChange: false };
                  currentTurn.segments.push({ start: seg.start, text: cleanText });
                }
                prevSegText = cleanText;
              }
              if (currentTurn) turns.push(currentTurn);
              const groups = [];
              for (const turn of turns) {
                const parts = groupBySentence(turn.segments);
                for (let i = 0; i < parts.length; i++) {
                  groups.push({ start: parts[i].start, text: parts[i].text, speakerChange: i === 0 && !!turn.speakerChange, speaker: turn.speaker });
                }
              }
              return groups;
            }
            const hasSpeakers = transcriptRows.some((r) => /^>>/.test(r.text));
            const groups = hasSpeakers ? groupBySpeaker(transcriptRows) : groupBySentence(transcriptRows);
            function fmtTime(sec) {
              const h = Math.floor(sec / 3600);
              const m = Math.floor((sec % 3600) / 60);
              const s = Math.floor(sec % 60);
              return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
            }
            const out = [];
            for (const g of groups) {
              const ts = fmtTime(g.start);
              if (g.speakerChange && g.speaker !== undefined) {
                out.push('**Speaker ' + (g.speaker + 1) + ' [' + ts + ']** ' + g.text);
              } else {
                out.push('[' + ts + '] ' + g.text);
              }
            }
            transcriptMarkdown = out.length ? out.join('\\n') : null;
          }
        } catch {}

        if (transcriptMarkdown) {
          lines.push('');
          lines.push('---');
          lines.push('');
          lines.push('## Transcript');
          lines.push('');
          lines.push(transcriptMarkdown);
        } else {
          lines.push('');
          lines.push('---');
          lines.push('');
          lines.push('*Transcript: not available for this video*');
        }

        // Try to get comments
        const comments = [];
        const commentEls = document.querySelectorAll('ytd-comment-thread-renderer');

        for (let i = 0; i < Math.min(commentEls.length, 25); i++) {
          const el = commentEls[i];
          const root = el.querySelector('#comment') || el;
          const authorEl = root.querySelector('#author-text');
          const textEl = root.querySelector('#content-text');
          const likeEl = root.querySelector('#like-count');

          const author = authorEl?.textContent?.trim() || 'Anonymous';
          const text = textEl?.textContent?.trim() || '';
          const likes = likeEl?.textContent?.trim() || '0';

          if (!text) continue;

          const replies = [];
          const replyEls = el.querySelectorAll('ytd-comment-replies-renderer ytd-comment-renderer');
          for (let r = 0; r < Math.min(replyEls.length, 5); r++) {
            const rel = replyEls[r];
            const rAuthorEl = rel.querySelector('#author-text');
            const rTextEl = rel.querySelector('#content-text');
            const rLikeEl = rel.querySelector('#like-count');
            const rAuthor = rAuthorEl?.textContent?.trim() || 'Anonymous';
            const rText = rTextEl?.textContent?.trim() || '';
            const rLikes = rLikeEl?.textContent?.trim() || '0';

            if (rText) {
              replies.push({
                author: rAuthor.replace(/^@/, ''),
                text: rText.substring(0, 500),
                likes: rLikes
              });
            }
          }

          comments.push({
            author: author.replace(/^@/, ''),
            text: text.substring(0, 500),
            likes,
            replies
          });
        }

        if (comments.length > 0) {
          lines.push('');
          lines.push('---');
          lines.push('');
          lines.push('## Top Comments (' + comments.length + ')');
          lines.push('');

          for (const c of comments) {
            lines.push('**' + c.author + '** • ' + c.likes + ' likes');
            lines.push('> ' + c.text.split('\\n')[0]);
            lines.push('');
            for (const r of c.replies) {
              lines.push('    ↳ **' + r.author + '** • ' + r.likes + ' likes');
              lines.push('      > ' + r.text.split('\\n')[0]);
              lines.push('');
            }
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractChannel(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const title = document.title.replace(' - YouTube', '').trim();
        const channelName = document.querySelector('#channel-title')?.textContent?.trim() || title;
        const subscriberText = document.querySelector('#subscriber-count')?.textContent?.trim() || '';

        const lines = [];
        lines.push('# ' + channelName);
        lines.push('');
        lines.push('**URL:** ' + url);
        if (subscriberText) {
          lines.push('**Subscribers:** ' + subscriberText);
        }
        lines.push('');

        // Get featured videos
        const videos = [];
        const videoEls = document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer');

        for (let i = 0; i < Math.min(videoEls.length, 15); i++) {
          const el = videoEls[i];
          const titleEl = el.querySelector('#video-title') || el.querySelector('h3');
          const metaEl = el.querySelector('#metadata-line');
          const linkEl = el.querySelector('a#thumbnail');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const videoUrl = linkEl?.href || '';

          if (videoTitle) {
            videos.push({
              title: videoTitle,
              meta: meta,
              url: videoUrl ? 'https://youtube.com' + videoUrl.split('&')[0].replace('/watch?v=', '/watch?v=') : ''
            });
          }
        }

        if (videos.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Recent Videos');
          lines.push('');

          for (const v of videos) {
            lines.push('### ' + v.title);
            lines.push('');
            lines.push(v.meta);
            if (v.url) lines.push('**Link:** ' + v.url);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractPlaylist(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};

        const title = document.title.replace(' - YouTube', '').trim();

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        // Get playlist items
        const items = [];
        const itemEls = document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer');

        for (let i = 0; i < Math.min(itemEls.length, 30); i++) {
          const el = itemEls[i];
          const titleEl = el.querySelector('#title');
          const metaEl = el.querySelector('#meta');
          const indexEl = el.querySelector('#index');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const index = indexEl?.textContent?.trim() || String(i + 1);

          if (videoTitle && !videoTitle.includes('http')) {
            items.push({
              index,
              title: videoTitle.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim()
            });
          }
        }

        if (items.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Playlist Items (' + items.length + ')');
          lines.push('');

          for (const item of items) {
            lines.push('**' + item.index + '.** ' + item.title);
            if (item.meta) lines.push('   ' + item.meta);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractSearch(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 10000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const urlParams = new URLSearchParams(window.location.search);
        const query = urlParams.get('search_query') || '';

        const lines = [];
        lines.push('# YouTube Search: ' + query);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        const results = [];
        const resultEls = document.querySelectorAll('ytd-video-renderer, ytd-rich-item-renderer');

        for (let i = 0; i < Math.min(resultEls.length, 20); i++) {
          const el = resultEls[i];
          const titleEl = el.querySelector('#video-title') || el.querySelector('h3');
          const metaEl = el.querySelector('#metadata-line');
          const linkEl = el.querySelector('a#thumbnail');

          const title = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';
          const videoUrl = linkEl?.href?.split('&')[0] || '';

          if (title && !title.includes('http')) {
            results.push({
              title: title.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim(),
              url: videoUrl
            });
          }
        }

        if (results.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Search Results (' + results.length + ')');
          lines.push('');

          for (const r of results) {
            lines.push('### ' + r.title);
            lines.push(r.meta);
            if (r.url) lines.push('**Link:** ' + r.url);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: 'Search: ' + query
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async extractHome(cdp: ICDPClient, url: string, options?: ExtractionOptions): Promise<PlatformContent> {
    const maxLength = options?.maxLength ?? 8000;

    const script = `
      (async () => {
        const maxLength = ${maxLength};
        const title = document.title.replace(' - YouTube', '').trim();

        const lines = [];
        lines.push('# ' + title);
        lines.push('');
        lines.push('**URL:** ' + url);
        lines.push('');

        const videos = [];
        const videoEls = document.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer');

        for (let i = 0; i < Math.min(videoEls.length, 15); i++) {
          const el = videoEls[i];
          const titleEl = el.querySelector('#video-title') || el.querySelector('h3');
          const metaEl = el.querySelector('#metadata-line');

          const videoTitle = titleEl?.textContent?.trim() || '';
          const meta = metaEl?.textContent?.trim() || '';

          if (videoTitle && !videoTitle.includes('http')) {
            videos.push({
              title: videoTitle.replace(/\\s+/g, ' ').trim(),
              meta: meta.replace(/\\s+/g, ' ').trim()
            });
          }
        }

        if (videos.length > 0) {
          lines.push('---');
          lines.push('');
          lines.push('## Recommended Videos');
          lines.push('');

          for (const v of videos) {
            lines.push('### ' + v.title);
            lines.push(v.meta);
            lines.push('');
          }
        }

        let text = lines.join('\\n');
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + '\\n\\n*[Content truncated]*';
        }

        return {
          kind: 'ok',
          text: text,
          title: title
        };
      })()
    `;

    try {
      const result = await cdp.evaluate(script);
      if (result && typeof result === 'object' && 'kind' in result) {
        return this.success('youtube-video', (result as YouTubeResult).text || '', undefined, {
          title: (result as YouTubeResult).title
        });
      }
      return this.error('youtube-video', 'Unexpected result format');
    } catch (e) {
      return this.error('youtube-video', `Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private formatCount(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }
}

export const youtubeExtractor = new YouTubeExtractor();
