/**
 * search - First-class search operation for BrowserTool.
 *
 * Replaces the prompt-driven "model googles manually" flow (pick engine →
 * navigate SERP → find input by ref → type+submit → re-read results = 4-6
 * tool rounds) with ONE deterministic call:
 *
 *   {"operation":"search","query":"...","maxResults":8,"engine":"auto"}
 *
 * Engine selection is deterministic code (based on probed network
 * environment + query language), the SERP is parsed by engine-specific
 * scripts into a clean {title,url,snippet} list, and failures degrade
 * through an engine chain (google → bing → baidu → duckduckgo → brave → yahoo) before
 * escalating to manual/human-like takeover guidance.
 */

import { z } from 'zod/v4';
import axios from 'axios';
import type { ActionHandler, ActionContext } from './types.js';
import { detectNetworkEnvironment } from '../networkEnv.js';
import type { NetworkEnvironment } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SearchEngineId = 'google' | 'bing' | 'baidu' | 'duckduckgo' | 'brave' | 'yahoo' | 'github';
export type SearchEngineChoice = SearchEngineId | 'auto';

/**
 * SERP item classification. Mirrors OpenCLI's google adapter:
 * - `result`  - a standard organic search result
 * - `snippet` - the featured / answer snippet block
 * - `paa`     - a "People Also Ask" question (no url)
 */
export type SearchResultType = 'result' | 'snippet' | 'paa';

export interface SearchItem {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  /** SERP result type (currently set only by the google engine). */
  type?: SearchResultType;
}

export interface SearchAttempt {
  engine: SearchEngineId;
  path: 'browser' | 'http';
  error: string;
}

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────

export function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

const ALL_ENGINES: SearchEngineId[] = ['google', 'bing', 'baidu', 'duckduckgo', 'brave', 'yahoo', 'github'];

/**
 * Deterministically order the engine chain.
 * - explicit engine always goes first, remaining engines follow as fallback
 * - domestic (mainland China): google unreachable → baidu/bing lead,
 *   ordered by query language (baidu is stronger for CJK, bing for English)
 * - overseas: google leads
 * - unknown: bing leads (generally reachable from both sides)
 * - github is appended as a code/repo-specialized fallback (never leads)
 *   so general queries still prefer general engines.
 */
export function selectEngines(
  engine: SearchEngineChoice,
  networkEnv: NetworkEnvironment | undefined,
  query: string,
): SearchEngineId[] {
  let chain: SearchEngineId[];
  const cjk = hasCJK(query);

  if (engine !== 'auto') {
    const rest = ALL_ENGINES.filter(e => e !== engine);
    return [engine, ...rest];
  }

  switch (networkEnv) {
    case 'domestic':
      chain = cjk
        ? ['baidu', 'bing', 'duckduckgo', 'brave', 'yahoo', 'github', 'google']
        : ['bing', 'baidu', 'duckduckgo', 'brave', 'yahoo', 'github', 'google'];
      break;
    case 'overseas':
      chain = cjk
        ? ['google', 'baidu', 'bing', 'duckduckgo', 'brave', 'yahoo', 'github']
        : ['google', 'bing', 'duckduckgo', 'brave', 'yahoo', 'github', 'baidu'];
      break;
    default:
      chain = ['bing', 'duckduckgo', 'brave', 'baidu', 'yahoo', 'github', 'google'];
  }
  return chain;
}

export function buildSerpUrl(engine: SearchEngineId, query: string, maxResults: number): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${q}&num=${maxResults}&hl=en`;
    case 'bing':
      return `https://www.bing.com/search?q=${q}&count=${maxResults}`;
    case 'baidu':
      return `https://www.baidu.com/s?wd=${q}&rn=${Math.min(maxResults, 20)}`;
    case 'duckduckgo':
      return `https://html.duckduckgo.com/html/?q=${q}`;
    case 'brave':
      return `https://search.brave.com/search?q=${q}`;
    case 'yahoo':
      return `https://search.yahoo.com/search?p=${q}`;
    case 'github':
      // GitHub search defaults to "repositories" type — covers code/issues/wiki
      // when the model wants source code / repo discovery. `type` is fixed
      // here; the model can navigate deeper via the BrowserTool navigate op.
      return `https://github.com/search?q=${q}&type=repositories`;
  }
}

export function truncateResults(items: SearchItem[], maxResults: number): SearchItem[] {
  return items
    // Require a url for normal results; "People Also Ask" items legitimately lack one.
    .filter(r => r.title && (r.url || r.type === 'paa'))
    .slice(0, maxResults)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Resolve DuckDuckGo redirect links (//duckduckgo.com/l/?uddg=<encoded>). */
export function resolveDdgLink(href: string): string {
  let link = href.trim();
  if (link.startsWith('//')) link = 'https:' + link;
  try {
    const u = new URL(link);
    const uddg = u.searchParams.get('uddg');
    return uddg ? uddg : link;
  } catch {
    return link;
  }
}

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse Bing SERP HTML fetched over plain HTTP (no JS). Bing serves usable
 * result markup to non-browser clients — verified live — unlike DuckDuckGo's
 * html endpoint which now returns a CAPTCHA anomaly page to plain HTTP.
 */
export function parseBingHtml(html: string, maxResults: number): SearchItem[] {
  const items: SearchItem[] = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    if (items.length >= maxResults) break;
    const h2m = block.match(/<h2[^>]*>[\s\S]{0,600}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h2m) continue;
    const url = h2m[1];
    const title = stripTags(h2m[2]);
    if (!title || !/^https?:/.test(url)) continue;
    if (/bing\.com\/(search|aclick)/i.test(url)) continue;
    const descM =
      block.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) ||
      block.match(/<div class="b_caption[^"]*">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    items.push({
      rank: 0,
      title: title.slice(0, 200),
      url,
      snippet: (descM ? stripTags(descM[1]) : '').slice(0, 300),
    });
  }
  return items;
}

/**
 * Parse the JS-free DuckDuckGo HTML endpoint (https://html.duckduckgo.com/html/).
 * Kept as the secondary HTTP fallback — the endpoint intermittently serves a
 * CAPTCHA anomaly page (status 202) to plain HTTP clients.
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchItem[] {
  const links: Array<{ title: string; url: string }> = [];
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null && links.length < maxResults * 2) {
    links.push({ title: stripTags(m[2]), url: resolveDdgLink(m[1]) });
  }

  const snippets: string[] = [];
  const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snippetRegex.exec(html)) !== null && snippets.length < maxResults * 2) {
    snippets.push(stripTags(m[1]));
  }

  const items: SearchItem[] = [];
  for (let i = 0; i < links.length && items.length < maxResults; i++) {
    if (!links[i].title || !links[i].url) continue;
    items.push({
      rank: 0,
      title: links[i].title.slice(0, 200),
      url: links[i].url,
      snippet: (snippets[i] ?? '').slice(0, 300),
    });
  }
  return items;
}

/**
 * Parse GitHub repository search SERP HTML fetched over plain HTTP.
 *
 * GitHub's SSR markup wraps each result in a div with `data-testid="search-result"`
 * (React Testing Library convention, stable across redesigns). Each block has:
 *   - an <a href="/<owner>/<repo>"> with the title
 *   - a <p class*="search-match"> describing the repository
 * Older layouts also used `Box-row`; the regex tolerates either.
 *
 * Returns `[]` when the page is a sign-in wall or CAPTCHA anomaly rather
 * than a SERP — keeps the HTTP fallback chain honest.
 */
export function parseGitHubHtml(html: string, maxResults: number): SearchItem[] {
  const items: SearchItem[] = [];
  // Lazily split: keep delimiters so we can include them in the per-block
  // capture without losing the closing of the previous block.
  const blockRegex =
    /<div[^>]*data-testid="search-result"[^>]*>([\s\S]*?)(?=<div[^>]*data-testid="search-result"|<\/main>)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(html)) !== null && items.length < maxResults) {
    const block = m[1];
    // Title link: matches <a href="/owner/repo" ...>title</a>. Some blocks use
    // <a data-testid="repository-link">; the href pattern is the invariant.
    const linkM = block.match(/<a[^>]+href="(\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    const href = linkM[1];
    // Exclude known non-repo GitHub paths (sponsor pages, settings, marketplace,
    // topics, explore, etc.) that also match the two-segment pattern.
    if (/^\/(sponsors|settings|marketplace|topics|explore|orgs|users|login|signup|new|notifications|pulls|issues|search)(\/|$)/.test(href)) continue;
    const title = stripTags(linkM[2]);
    if (!title) continue;
    // Description: GitHub wraps matches in <mark class*="search-match">; the
    // outer <p> is the natural snippet container. Fallback to first <p>.
    const descM =
      block.match(/<p[^>]*class="[^"]*search-match[^"]*"[^>]*>([\s\S]*?)<\/p>/) ||
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    items.push({
      rank: 0,
      title: title.slice(0, 200),
      url: `https://github.com${href}`,
      snippet: (descM ? stripTags(descM[1]) : '').slice(0, 300),
    });
  }
  return items;
}

// ─── SERP extraction scripts (run in page via CDP) ─────────────────────────

const COLLECT_PREAMBLE = `
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const push = (results, title, link, snippet) => {
  if (!title || !link || !/^https?:/.test(link)) return;
  results.push({ type: 'result', title: title.substring(0, 200), url: link, snippet: (snippet || '').substring(0, 300) });
};
`;

function serpExtractScript(engine: SearchEngineId): string {
  const collectors: Record<SearchEngineId, string> = {
    google: `
const collect = () => {
  const results = [];
  const seenUrls = {};
  const rso = document.querySelector('#rso');
  // The google collector builds its own typed objects (featured snippet,
  // people-also-ask); it does not reuse the preamble's 'push' helper.
  if (!rso) return results;

  // Featured / answer snippet block
  const featuredEl = rso.querySelector('.xpdopen .hgKElc') || rso.querySelector('.IZ6rdc');
  if (featuredEl) {
    const block = featuredEl.closest('[data-hveid]') || featuredEl.parentElement;
    const fLink = block ? block.querySelector('a[href]') : null;
    const fUrl = fLink ? fLink.href : '';
    if (fUrl) seenUrls[fUrl] = true;
    results.push({ type: 'snippet', title: featuredEl.textContent.trim().slice(0, 200), url: fUrl, snippet: '' });
  }

  // Standard results: every <a> containing an <h3> inside #rso, walking up
  // to the result container ([data-hveid]) to source the snippet. This is
  // resilient to Google's public class renames.
  const allLinks = rso.querySelectorAll('a');
  for (let i = 0; i < allLinks.length; i++) {
    const link = allLinks[i];
    const h3 = link.querySelector('h3');
    if (!h3) continue;
    const href = link.href || '';
    if (!/^https?:\\/\\//.test(href)) continue;
    if (href.indexOf('google.com/search') >= 0 || href.indexOf('google.com/url') >= 0) continue;
    if (seenUrls[href]) continue;
    seenUrls[href] = true;

    let container = link;
    for (let j = 0; j < 6; j++) {
      if (container.parentElement && container.parentElement !== rso) container = container.parentElement;
      if (container.getAttribute && container.getAttribute('data-hveid')) break;
    }

    const titleText = h3.textContent.trim();
    let snippetText = '';
    const candidates = container.querySelectorAll('span, div');
    for (let k = 0; k < candidates.length && !snippetText; k++) {
      const el = candidates[k];
      if (el.querySelector('h3') || el.querySelector('a[href]')) continue;
      const text = el.textContent.trim();
      if (text.length < 40 || text.length > 500) continue;
      if (text === titleText) continue;
      // Skip URL breadcrumbs ("Site › path…") by filtering the U+203A char.
      if (text.indexOf('›') >= 0) continue;
      if (new RegExp('https?://').test(text.slice(0, 60))) continue;
      snippetText = text;
    }

    results.push({ type: 'result', title: titleText.slice(0, 200), url: href, snippet: snippetText.slice(0, 300) });
  }

  // People Also Ask
  const paaEls = document.querySelectorAll('[data-sgrd="true"]');
  for (let i = 0; i < paaEls.length; i++) {
    const q = paaEls[i].querySelector('span.CSkcDe');
    if (q) results.push({ type: 'paa', title: q.textContent.trim().slice(0, 200), url: '', snippet: '' });
  }

  return results;
};`,
    bing: `
const collect = () => {
  const results = [];
  const els = document.querySelectorAll('li.b_algo');
  for (let i = 0; i < Math.min(els.length, 30); i++) {
    const el = els[i];
    const titleEl = el.querySelector('h2 a') || el.querySelector('h2') || el.querySelector('a');
    const snippet = (el.querySelector('.b_desc') || el.querySelector('p') || {}).textContent || '';
    push(results, (titleEl || {}).textContent, titleEl ? titleEl.href || '' : '', snippet);
  }
  return results;
};`,
    baidu: `
const collect = () => {
  const results = [];
  const els = document.querySelectorAll('.result, .c-container');
  for (let i = 0; i < Math.min(els.length, 30); i++) {
    const el = els[i];
    const titleEl = el.querySelector('h3 a') || el.querySelector('h3') || el.querySelector('a');
    const snippet = (el.querySelector('.c-abstract') || el.querySelector('.content-right_8Zs40') || el.querySelector('p') || {}).textContent || '';
    push(results, (titleEl || {}).textContent, titleEl ? titleEl.href || '' : '', snippet);
  }
  return results;
};`,
    duckduckgo: `
const resolve = (href) => {
  let link = href;
  if (link.indexOf('//') === 0) link = location.protocol + link;
  try {
    const u = new URL(link);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
  } catch (e) {}
  return link;
};
const collect = () => {
  const results = [];
  const els = document.querySelectorAll('.result, .web-result');
  for (let i = 0; i < Math.min(els.length, 30); i++) {
    const el = els[i];
    const a = el.querySelector('a.result__a');
    if (!a) continue;
    const snippet = (el.querySelector('.result__snippet') || {}).textContent || '';
    push(results, a.textContent, resolve(a.href), snippet);
  }
  return results;
};`,
    brave: `
const collect = () => {
  const results = [];
  const items = document.querySelectorAll('.snippet');
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    if (el.classList.contains('standalone') || el.classList.contains('ad')) continue;
    const titleEl = el.querySelector('.search-snippet-title');
    if (!titleEl) continue;
    const linkEl = el.querySelector('.result-content a');
    const href = linkEl ? linkEl.href || '' : '';
    const snippetEl = el.querySelector('.generic-snippet .content');
    const snippet = snippetEl ? snippetEl.textContent.trim() : '';
    push(results, titleEl.textContent.trim(), href, snippet);
  }
  return results;
};`,
    yahoo: `
const resolve = (href) => {
  if (!href) return '';
  const m = href.match(/RU=([^/]+)\\/RK=/);
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]); } catch (e) {}
  }
  return href;
};
const collect = () => {
  const results = [];
  const items = document.querySelectorAll('.algo');
  for (let i = 0; i < items.length; i++) {
    const el = items[i];
    const h3 = el.querySelector('h3');
    const linkEl = el.querySelector('.compTitle a');
    if (!h3 || !linkEl) continue;
    const href = resolve(linkEl.getAttribute('href') || '');
    const snippetEl = el.querySelector('.compText');
    const snippet = snippetEl ? snippetEl.textContent.trim() : '';
    push(results, h3.textContent.trim(), href, snippet);
  }
  return results;
};`,
    github: `
const collect = () => {
  const results = [];
  const blocks = document.querySelectorAll('[data-testid="search-result"]');
  for (let i = 0; i < Math.min(blocks.length, 30); i++) {
    const el = blocks[i];
    // Pick the first /owner/repo link — GitHub uses absolute /-rooted paths
    // for repo links in the SERP. Skip avatar/user links by shape.
    const a = el.querySelector('a[href^="/"][data-hovercard-type="repository"]')
           || el.querySelector('a[data-testid="repository-link"]')
           || el.querySelector('a[href^="/"][href*="/"]');
    if (!a) continue;
    const href = (a.getAttribute('href') || '').split('?')[0].split('#')[0];
    if (!/^\\/[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\/?$/.test(href)) continue;
    const title = (a.textContent || '').trim();
    if (!title) continue;
    const descEl = el.querySelector('p[class*="search-match"]') || el.querySelector('p');
    const snippet = descEl ? (descEl.textContent || '').trim() : '';
    push(results, title, 'https://github.com' + href.replace(/\\/$/, ''), snippet);
  }
  return results;
};`,
  };

  return [
    '(async () => {',
    COLLECT_PREAMBLE,
    collectors[engine],
    'await sleep(800);',
    'let results = collect();',
    'if (results.length === 0) { await sleep(1500); results = collect(); }',
    "if (results.length === 0) {",
    "  const blocked = document.querySelector('form[action*=\"consent\"], #captcha, .g-recaptcha, #verify');",
    "  return { kind: 'error', detail: blocked ? 'blocked by consent/captcha page' : 'no results parsed on SERP' };",
    '}',
    "return { kind: 'ok', results };",
    '})()',
  ].join('\n');
}

interface ScriptResult {
  kind: 'ok' | 'error';
  results?: Array<{ title: string; url: string; snippet: string; type?: SearchResultType }>;
  detail?: string;
}

// ─── Action ────────────────────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1).describe('Search query text'),
  engine: z.preprocess(
    (val) => (typeof val === 'string' ? val.toLowerCase().trim() : val),
    z.enum(['auto', 'google', 'bing', 'baidu', 'duckduckgo', 'brave', 'yahoo', 'github']).optional().default('auto'),
  ).describe("Search engine. 'auto' picks deterministically from the probed network environment (recommended)."),
  maxResults: z.preprocess(
    (val) => {
      if (typeof val === 'string') {
        const n = Number(val);
        return isNaN(n) ? val : n;
      }
      return val;
    },
    z.number().int().min(1).max(20).optional().default(8),
  ).describe('Maximum number of results to return (1-20, default 8)'),
});

export const searchAction: ActionHandler<z.infer<typeof searchSchema>> = {
  operation: 'search',
  schema: searchSchema,
  async execute(data, ctx: ActionContext) {
    // Resolve network environment: prefer the tool instance's cached value,
    // otherwise run the probe now (cached process-wide, so subsequent calls
    // are instant) and sync it back so getPrompt() picks the right guidance.
    let env: NetworkEnvironment = ctx.networkEnvironment ?? 'unknown';
    if (ctx.networkEnvironment === undefined) {
      env = await detectNetworkEnvironment();
      ctx.setNetworkEnvironment?.(env);
    }

    const engines = selectEngines(data.engine, env, data.query);
    const attempts: SearchAttempt[] = [];

    // Path 1: real browser (CDP) through the engine chain.
    if (ctx.cdp) {
      for (const engine of engines) {
        const url = buildSerpUrl(engine, data.query, data.maxResults);
        try {
          if (ctx.mode !== 'extension' && ctx.checkDomainBlocked(url)) {
            attempts.push({ engine, path: 'browser', error: 'engine domain is blocked by domain blocklist' });
            continue;
          }
          await ctx.cdp.navigate(url);
          const evaluated = await ctx.cdp.evaluate(serpExtractScript(engine));
          const parsed = evaluated as ScriptResult | null;
          if (parsed && parsed.kind === 'ok' && Array.isArray(parsed.results) && parsed.results.length > 0) {
            return {
              success: true,
              query: data.query,
              engineRequested: data.engine,
              engineUsed: engine,
              networkEnvironment: env,
              serpUrl: url,
              total: parsed.results.length,
              results: truncateResults(parsed.results.map(r => ({ ...r, rank: 0 })), data.maxResults),
              attempts,
            };
          }
          attempts.push({
            engine,
            path: 'browser',
            error: parsed?.detail || 'extraction returned no results',
          });
        } catch (e) {
          attempts.push({
            engine,
            path: 'browser',
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // Path 2: JS-free HTTP fallback chain. Bing serves parseable SERP HTML to
    // plain HTTP clients (works in both domestic and overseas networks);
    // DuckDuckGo's html endpoint is the secondary attempt; GitHub's
    // server-rendered search page also works without JS for the repo SERP.
    const httpChain: Array<{ engine: SearchEngineId; url: string; parse: (html: string) => SearchItem[] }> = [
      {
        engine: 'bing',
        url:
          env === 'domestic'
            ? `https://cn.bing.com/search?q=${encodeURIComponent(data.query)}&count=${data.maxResults}`
            : buildSerpUrl('bing', data.query, data.maxResults),
        parse: html => parseBingHtml(html, data.maxResults),
      },
      {
        engine: 'duckduckgo',
        url: buildSerpUrl('duckduckgo', data.query, data.maxResults),
        parse: html => parseDuckDuckGoHtml(html, data.maxResults),
      },
      {
        engine: 'github',
        url: buildSerpUrl('github', data.query, data.maxResults),
        parse: html => parseGitHubHtml(html, data.maxResults),
      },
    ];

    for (const candidate of httpChain) {
      try {
        const response = await axios.get(candidate.url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          maxRedirects: 3,
          responseType: 'text',
        });
        const items = candidate.parse(String(response.data));
        if (items.length > 0) {
          return {
            success: true,
            query: data.query,
            engineRequested: data.engine,
            engineUsed: candidate.engine,
            networkEnvironment: env,
            serpUrl: candidate.url,
            total: items.length,
            results: truncateResults(items, data.maxResults),
            attempts,
          };
        }
        attempts.push({ engine: candidate.engine, path: 'http', error: 'no results parsed from SERP html' });
      } catch (e) {
        attempts.push({
          engine: candidate.engine,
          path: 'http',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // All engines failed: escalate with actionable next steps instead of a
    // bare error string, so the model can recover in the same turn.
    return {
      success: false,
      query: data.query,
      engineRequested: data.engine,
      networkEnvironment: env,
      attempts,
      error: `All search engines failed (${attempts.map(a => `${a.engine}/${a.path}`).join(', ')})`,
      nextSteps: [
        'Retry once with an explicit engine: {"operation":"search","query":"...","engine":"baidu"} (or bing/google)',
        'If you already know a likely source URL, navigate to it directly and read the page',
        'If engines are blocked by CAPTCHA/consent, switch to human-like visual mode (screenshot + click_at) or ask the user to search manually and paste the URL',
      ],
    };
  },
};
