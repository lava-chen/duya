/**
 * Capability guides, keyed by the `PlatformContentType` a platform extractor
 * returns. Surfaced on navigate / snapshot / parallel_fetch results so the
 * model knows what URL paths this site's extractor covers and what structured
 * content it will get back on each — the tool's capability boundary per site.
 */

import type { PlatformContentType } from './types.js';

export const capabilityGuides: Partial<Record<PlatformContentType, string>> = {
  'tweet': [
    '**X (Twitter) — status/article.** Serves single tweets and long-form articles.',
    '- /<user>/status/<id> → single tweet (content, counts).',
    '- /i/article/<id> or long-form tweet → article body (in `tweet`).',
    'Threads return as a `thread` result. Like/RT/delete are not automated.',
    '',
    '**Publishing (write).** A logged-in X.com session in the browser can also post.',
    '- Use `twitter_post` to publish a new tweet (text + up to 4 jpg/png/gif/webp images).',
    '- It drives the real composer: opens /compose/post, attaches media, types, submit, and verifies the resulting `/status/<id>` URL.',
    '- Replies reuse the same composer route; confirm the account before any public post.',
    '- Posting is irreversible and public — only call `twitter_post` after the user confirms.',
  ].join('\n'),

  'thread': [
    '**X (Twitter) — thread.** A tweet plus its parent/replies, ordered chronologically.',
    '- /<user>/status/<id> on the root/first tweet → numbered `thread` (author, text, like/RT per part).',
    'Prefer navigating to the thread root tweet for the full conversation.',
    '',
    '**Publishing (write).** With a logged-in session, `twitter_post` posts a single tweet; to start a thread, post the first tweet via `twitter_post`, then reply to it if the user wants a thread. Confirm before posting.',
  ].join('\n'),

  'youtube-video': [
    '**YouTube.** Serves one page type from its URL path.',
    '- /watch?v= → metadata + Transcript (when captions exist) + description + top comments (+ replies).',
    '- /@user or /channel/ → channel info + recent videos.',
    '- /playlist → title + items.',
    '- /results?search_query= → search result list.',
    'Reads public content only; nothing here creates/subscribes.',
  ].join('\n'),

  'reddit-post': [
    '**Reddit.** Single post OR a subreddit/search list.',
    '- /r/<sub>, /r/<sub>/hot|new|top → listing (title, score, comments, link).',
    '- /search/?q= → search result list.',
    '- /r/<sub>/comments/<id> → single post (returned as reddit-comments).',
    'No posting/voting.',
  ].join('\n'),

  'reddit-comments': [
    '**Reddit — post + comments.** One thread read.',
    '- /r/<sub>/comments/<id> → post body + comment tree.',
    'For lists use /r/<sub>/hot or /search/?q=.',
  ].join('\n'),

  'zhihu-answer': [
    '**知乎.** Question / answer routing by URL path.',
    '- /question/<id> → question + top answers (answerer, votes, summary).',
    '- /question/<id>/answer/<aid> → single answer.',
    '- /hot or /billboard → 热榜 list (returned as zhihu-article).',
    'Read-only; no follow/vote.',
  ].join('\n'),

  'zhihu-article': [
    '**知乎 — 热榜/专栏.** Ranked or article content.',
    '- /hot, /billboard → ranked 热榜 list.',
    '- /p/<id> article → article body.',
    'Use /question/<id> for Q&A.',
  ].join('\n'),

  'instagram': [
    '**Instagram.** Post / reel / story / profile.',
    '- /p/<shortcode> → post (caption, media, counts, time).',
    '- /reel(s)/<shortcode> → video post.',
    '- /stories/<user>/<id> → story media.',
    '- /<user> → profile + recent posts.',
    'Best-effort; private / "log in to view" pages degrade.',
  ].join('\n'),

  'tiktok': [
    '**TikTok.** Video / profile.',
    '- /@<user>/video/<id> → caption, stats, cover, music.',
    '- /@<user> → profile (bio, followers, recent videos).',
    'Geo/login walls cap results to og-meta fallback.',
  ].join('\n'),

  'weibo': [
    '**微博.** Single weibo or hot list.',
    '- hot → rankings (词 + 热度).',
    '- /status/<id> or /detail/<id> → single weibo (text, images, reposts/comments/likes).',
    'Uses public JSON; no login needed for these.',
  ].join('\n'),

  'rednote': [
    '**小红书.** Note / profile.',
    '- /explore/<id> or /discovery/item/<id> → note (desc, images, counts, tags).',
    '- /user/profile/<id> → profile + recent notes.',
    'Login / 风控 walls degrade.',
  ].join('\n'),

  'bilibili-video': [
    '**哔哩哔哩.** Video page read (title, up, stats, description, comments when present).',
    'Interactions (like/danmaku) are out of scope.',
  ].join('\n'),

  'github-repo': [
    '**GitHub.** Repository page → description, stats, language, readme/front matter.',
    'Only public repo metadata; no clone/build.',
  ].join('\n'),

  'arxiv': [
    '**arXiv.** Paper abstract page → title, authors, abstract, links.',
    'No PDF text extraction (that needs a dedicated tool).',
  ].join('\n'),

  'wikipedia': [
    '**Wikipedia.** Full plain-text article via the page language API.',
    '- /wiki/<Title> → full article (paragraphs, description). Any language host is auto-detected.',
  ].join('\n'),

  'hacker-news': [
    '**Hacker News.** Story + threaded comments.',
    '- /item?id=<id> → story + comment tree (depth/reply caps).',
    'Public Firebase API; no login.',
  ].join('\n'),

  'pubmed': [
    '**PubMed.** Article metadata for a PMID.',
    '- /<pmid>/ → title, authors, journal, date, type, DOI, URL.',
    'Abstract is not currently included.',
  ].join('\n'),

  'google-search': [
    '**Search engine SERP** (google/bing/baidu/brave/yahoo) → structured ranked result list (title/url/snippet), plus featured snippet & People Also Ask on Google.',
    'Prefer the `search` operation; this runs when you navigate directly to a search URL.',
  ].join('\n'),

  'article': [
    '**Generic article read (any page).** Readability extraction (title + paragraphs + code/list).',
    'Fallback for pages no specific platform handles. For interactive pages use `snapshot` for refs.',
  ].join('\n'),
};

/**
 * Return the capability guide markdown for a platform type, or undefined when
 * there is no specific guide (no site handler matched).
 */
export function getCapabilityGuide(type: PlatformContentType): string | undefined {
  return capabilityGuides[type];
}