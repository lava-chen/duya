---
name: twitter
description: Extract tweets, timelines, and search results from X (Twitter) using the browser tool. Uses DOM-based extraction as the primary method (more reliable than API), with API as fallback. Handles X's SPA navigation and tab disconnection.
version:1.2.0
author: DUYA Agent
license: MIT
metadata:
 tags: [Twitter, X, Tweet, Timeline, Social, Media]
 related_skills: [bilibili, youtube, weixin-mp]
---

# X (Twitter)

Extract tweets and timelines from X (formerly Twitter) using the browser tool.

## When to Use

Use this skill when the user wants to:
- Fetch a user's recent tweets
- Read their home timeline (for-you or following)
- Search for tweets on a topic
- Extract tweet content, likes, retweets, replies, views
- Monitor specific accounts

## Required Tool

This skill requires the **browser** tool. Use `browser_navigate` to load pages and `browser_evaluate` to extract data.

**Important:** X requires login for most operations. The browser tool uses the user's Chrome profile.

## Architecture Decision

Based on testing, **DOM extraction is more reliable than GraphQL API** for X:

| Method | Pros | Cons |
|--------|------|------|
| **DOM (Primary)** | No auth tokens needed; works with page cookies; stable | Need to handle SPA lazy loading; engagement counts are localized ("90K", "1.6K") |
| **API (Fallback)** | Structured data; numeric counts without suffixes | Bearer token expires; Query IDs change frequently; tab disconnection after ~5 requests |

**Strategy:** Use DOM extraction as primary method. Use API only when DOM method fails.

## Engagement Count Parsing

X renders engagement counts in **two redundant places**, both required for robustness:

1. **`aria-label` on the action `<div>`** — full label like `"12,345 Likes. Like"`, `"1.6K Likes. Like"`, `"Unlike"` (when viewer has already liked). Captures the **exact localized number**.
2. **Span `[data-testid="app-text-transition-container"]` inside the action group** — visible text like `"90K"`, `"1.6K"`, `"28M"`. Used as a fallback when `aria-label` is missing or ambiguous.

**Localization suffixes** the parser must handle: `K` (×1,000), `M` (×1,000,000), `B` (×1,000,000,000), comma-separated thousands (`12,345`), dot-decimal millions (`1.6`), and the bare integer.

**Action labels** by `data-testid` on the wrapping group:
| `data-testid` | Field | aria-label keywords |
|---|---|---|
| `like` | `likes` | `Like`, `Unlike`, `Liked` |
| `retweet` | `retweets` | `Repost`, `Reposts`, `Undo repost`, `Reposted` |
| `reply` | `replies` | `Reply`, `Replies`, `repl` (legacy) |
| `view` (or aria contains "view") | `views` | `View`, `Views`, `views` |

The DOM groups live inside the engagement bar at the bottom of each `article[data-testid="tweet"]`. When the viewer has interacted, the wrapping `data-testid` may flip to `unlike` / `unretweet` — never match those for counts; use the visible span text instead.

## Quick Start

### Fetch User Tweets (DOM Method)

```
1. browser_navigate: https://x.com/USERNAME
2. browser_evaluate: Run the EXTRACT_SCRIPT below
3. Scroll to load more (if needed)
4. Re-run EXTRACT_SCRIPT to pick up newly rendered tweets
```

### Search Tweets (DOM Method)

```
1. browser_navigate: https://x.com/search?q=QUERY&f=live
2. browser_evaluate: Run EXTRACT_SCRIPT
3. Return results
```

## Detailed Operations

###1. Extract Tweets via DOM (Primary Method)

Extract tweets directly from rendered DOM. No API tokens needed.

**Step1: Navigate to user profile or search**
```json
{"operation": "navigate", "url": "https://x.com/xdash"}
```

**Step2: Extract tweets from DOM**

Use this canonical `EXTRACT_SCRIPT`. Do not inline-edit — keeping it in one place avoids the three-way drift this skill previously shipped.

```json
{
 "operation": "evaluate",
 "script": "(function(){const parseCount=function(raw){if(!raw)return0;const m=String(raw).trim().match(/([\d.,]+)\s*([KkMmBb])?/);if(!m)return0;const num=parseFloat(m[1].replace(/,/g,''));const suf=(m[2]||'').toUpperCase();return Math.round(num*(suf==='K'?1e3:suf==='M'?1e6:suf==='B'?1e9:1));};const readStat=function(article,kind){const group=article.querySelector('[data-testid=\"'+kind+'\"]');const label=group?group.getAttribute('aria-label')||'':'';const span=group?group.querySelector('[data-testid=\"app-text-transition-container\"]'):null;const spanText=span?span.textContent.trim():'';return parseCount(label)||parseCount(spanText);};const articles=document.querySelectorAll('article[data-testid=\"tweet\"]');const tweets=[];for(const article of articles){try{const textEl=article.querySelector('[data-testid=\"tweetText\"]');const text=textEl?textEl.textContent.trim():'';const userEl=article.querySelector('[data-testid=\"User-Name\"] a');const userLink=userEl?userEl.getAttribute('href'):'';const author=userLink?userLink.replace(/^\//,'').split('/')[0]:'';const timeEl=article.querySelector('time');const time=timeEl?timeEl.getAttribute('datetime'):'';const likes=readStat(article,'like');const retweets=readStat(article,'retweet');const replies=readStat(article,'reply');const viewsEl=article.querySelector('a[href*=\"/analytics\"]');const views=parseCount(viewsEl?viewsEl.textContent:'');const linkEl=article.querySelector('a[href*=\"/status/\"]');const statusPath=linkEl?linkEl.getAttribute('href'):'';const url=statusPath?'https://x.com'+statusPath:'';if(text){tweets.push({author,text,likes,retweets,replies,views,time,url});}}catch(e){}}return tweets;})()"
}
```

The script does four things that the previous version got wrong:

1. `parseCount` understands `K` / `M` / `B` suffixes and comma thousands-separators — `"90K"` → `90000`, `"1.6K"` → `1600`, `"12,345"` → `12345`.
2. Each stat is read with a single helper that tries `aria-label` first, then the visible span — so a viewer who has already liked still reports the right count.
3. Engagement groups are addressed by `data-testid` on the **action group** (`like` / `retweet` / `reply`), which matches X's stable structure regardless of liked/unliked state.
4. Views are pulled from the analytics link (e.g. `<a href="/.../analytics">View count</a>`), which is the only reliable DOM carrier of the impressions figure.

**Step3: Scroll to load more (optional)**
```json
{"operation": "scroll", "direction": "down", "amount":800}
```

Then re-run Step2 to get newly loaded tweets.

**Tweet Fields:**
| Field | Description |
|-------|-------------|
| author | Screen name (@handle) |
| text | Tweet text content |
| likes | Like count (parsed from `K`/`M`/`B` suffix) |
| retweets | Repost count |
| replies | Reply count |
| views | Impression count (best-effort, may be `0` on cards that don't show views) |
| time | ISO timestamp |
| url | Direct link to tweet |

###2. Search Tweets via DOM

**Step1: Navigate to search with query**
```json
{"operation": "navigate", "url": "https://x.com/search?q=machine%20learning&f=live"}
```

**Step2: Extract search results**

Use the same `EXTRACT_SCRIPT` from §1. The script does not care which X page produced the `article[data-testid="tweet"]` nodes.

**Search Filters:**
- `f=live` — Latest tweets
- `f=top` — Top tweets
- Add `&f=media` for media only

###3. Fetch Home Timeline via DOM

**Step1: Navigate to home**
```json
{"operation": "navigate", "url": "https://x.com/home"}
```

**Step2: Extract timeline tweets**

Again, use `EXTRACT_SCRIPT` from §1. There is no need for a separate script — the only difference between user/search/home is the URL.

###4. API Fallback (When DOM Fails)

If DOM extraction fails (e.g., page not loading, anti-bot), use API fallback with dynamic Query ID resolution. **Do not reuse the DOM parsing path** — the API already returns numeric counts, so `parseCount` is unnecessary.

**Step1: Resolve GraphQL Query ID**
```json
{
 "operation": "evaluate",
 "script": "(async function(){ const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),5000); try{ const resp=await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json',{signal:controller.signal}); clearTimeout(timeout); if(!resp.ok)return {error:'GitHub fetch failed'}; const data=await resp.json(); return {userTweets:data?.UserTweets?.queryId,searchTimeline:data?.SearchTimeline?.queryId,homeTimeline:data?.HomeTimeline?.queryId}; }catch(e){ clearTimeout(timeout); return {error:e.message}; } })()"
}
```

**Step2: Get auth token**
```json
{
 "operation": "evaluate",
 "script": "document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('ct0='))?.split('=')[1]||null"
}
```

**Step3: Call API with resolved Query ID**

API counts come back as plain integers (`favorite_count`, `retweet_count`, `reply_count`) — no `K`/`M` suffix parsing needed. This is the path's main advantage when DOM fails: numbers are exact.

```json
{
 "operation": "evaluate",
 "script": "(async function(){ const QUERY_ID='QUERY_ID_FROM_STEP_1'; const USER_ID='USER_ID'; const bearer='AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'; const ct0=document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('ct0='))?.split('=')[1]; const headers={'Authorization':`Bearer ${decodeURIComponent(bearer)}`,'X-Csrf-Token':ct0,'X-Twitter-Auth-Type':'OAuth2Session','X-Twitter-Active-User':'yes'}; const vars={userId:USER_ID,count:20,includePromotedContent:false}; const features={rweb_video_screen_enabled:false,profile_label_improvements_pcf_label_in_post_enabled:true,rweb_tipjar_consumption_enabled:true,verified_phone_label_enabled:false,creator_subscriptions_tweet_preview_api_enabled:true,responsive_web_graphql_timeline_navigation_enabled:true,responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,premium_content_api_read_enabled:false,communities_web_enable_tweet_community_results_fetch:true,c9s_tweet_anatomy_moderator_badge_enabled:true,responsive_web_grok_analyze_button_fetch_trends_enabled:false,responsive_web_grok_analyze_post_followups_enabled:true,responsive_web_jetfuel_frame:true,responsive_web_grok_share_attachment_enabled:true,articles_preview_enabled:true,responsive_web_edit_tweet_api_enabled:true,graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,view_counts_everywhere_api_enabled:true,longform_notetweets_consumption_enabled:true,responsive_web_twitter_article_tweet_consumption_enabled:true,tweet_awards_web_tipping_enabled:false,content_disclosure_indicator_enabled:true,content_disclosure_ai_generated_indicator_enabled:true,responsive_web_grok_show_grok_translated_post:false,responsive_web_grok_analysis_button_from_backend:true,post_ctas_fetch_enabled:false,freedom_of_speech_not_reach_fetch_enabled:true,standardized_nudges_misinfo:true,tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:true,longform_notetweets_rich_text_read_enabled:true,longform_notetweets_inline_media_enabled:true,responsive_web_grok_image_annotation_enabled:true,responsive_web_enhance_cards_enabled:false}; const url='/i/api/graphql/'+QUERY_ID+'/UserTweets?variables='+encodeURIComponent(JSON.stringify(vars))+'&features='+encodeURIComponent(JSON.stringify(features)); const resp=await fetch(url,{headers,credentials:'include'}); if(!resp.ok)return{error:'HTTP '+resp.status}; const data=await resp.json(); const instructions=data?.data?.user?.result?.timeline_v2?.timeline?.instructions||[]; const tweets=[]; const seen=new Set(); for(const inst of instructions){ for(const entry of inst.entries||[]){ const item=entry.content?.itemContent?.tweet_results?.result; if(!item)continue; const tw=item.tweet||item; const l=tw.legacy||{}; if(!tw.rest_id||seen.has(tw.rest_id))continue; seen.add(tw.rest_id); const u=tw.core?.user_results?.result; const screenName=u?.legacy?.screen_name||'unknown'; tweets.push({id:tw.rest_id,author:screenName,text:tw.note_tweet?.note_tweet_results?.result?.text||l.full_text||'',likes:l.favorite_count||0,retweets:l.retweet_count||0,replies:l.reply_count||0,views:parseInt((l.views&&l.views.count)||'0',10)||0,created_at:l.created_at||'',url:`https://x.com/${screenName}/status/${tw.rest_id}`}); } } return {tweets}; })()"
}
```

Note the `views` field: the API exposes it via `l.views.count` (string), which we parse with `parseInt` — different from the DOM path, but both surface the same number.

## Handling Tab Disconnection

X's security mechanism disconnects tabs after ~5 evaluate calls. Mitigation strategies:

1. **Batch extraction** — Get all data in a single evaluate call when possible
2. **Re-navigate when disconnected** — If evaluate returns null/error, re-navigate to the page
3. **Use DOM over API** — DOM extraction doesn't trigger the disconnection as quickly
4. **Add delays** — Small delays between requests reduce detection

```javascript
// Example: Check if tab is still connected
(async () => {
 const test = await page.evaluate('document.title');
 if (!test) {
 // Tab disconnected, re-navigate
 await page.navigate('https://x.com/...');
 }
})();
```

## Complete Workflows

### Workflow: Fetch User's Recent Tweets

```
User: "获取 xdash最近的推文"

Agent:
1. browser_navigate → https://x.com/xdash
2. browser_evaluate → EXTRACT_SCRIPT
3. If tweets found:
 - Format and return
4. If empty (page not loaded):
 - Wait2 seconds, scroll down
 - Re-run EXTRACT_SCRIPT
5. If still empty after two tries:
 - Use API fallback (resolve Query ID → get auth → call API)
```

### Workflow: Search Tweets

```
User: "搜索关于 AI 的最新推文"

Agent:
1. browser_navigate → https://x.com/search?q=AI&f=live
2. browser_evaluate → EXTRACT_SCRIPT
3. Return results
```

### Workflow: Monitor Timeline

```
User: "看看我的时间线有什么新内容"

Agent:
1. browser_navigate → https://x.com/home
2. browser_evaluate → EXTRACT_SCRIPT
3. Return recent tweets
```

## Tips

1. **DOM method is primary** — More reliable, no token management needed
2. **Login required** — X blocks most content without login
3. **Tab disconnection** — ~5 evaluate calls may disconnect; re-navigate if needed
4. **Scroll for more** — Lazy loading requires scrolling to load more tweets
5. **Search filters** — Use `f=live` for latest, `f=top` for top tweets
6. **Batch extraction** — Do as much as possible in single evaluate to avoid disconnection
7. **One script, many pages** — User profile, search, and home all use the same `EXTRACT_SCRIPT`; only the navigation URL changes

## Common Issues

| Issue | Solution |
|-------|----------|
| All counts are0 | Page may not be loaded; wait2s and retry. Also check that `aria-label` exists — some embedded cards omit it; the span-text fallback should still recover. |
| Tab disconnected | Re-navigate to the page |
| Not logged in | Log into X in Chrome before using |
| Rate limited (API) | Switch to DOM method |
| Query ID expired (API) | Resolve latest Query ID from GitHub |
| Counts off by1000× | Old script silently dropped `K`/`M` suffixes; ensure `EXTRACT_SCRIPT` is the v1.2 version |

## Technical Notes

### Why DOM over API?

Testing shows DOM extraction is more reliable for X:
- No Bearer token expiration issues
- No Query ID maintenance
- Works with existing login session
- Less likely to trigger anti-bot

The cost is dealing with localized count strings (`90K`, `1.6M`); `parseCount` handles that.

API is kept as fallback for edge cases. It returns exact integers but is fragile (token expiry, query ID churn, tab disconnection).

### Tab Disconnection

X monitors for automated behavior. After ~5 evaluate calls, the tab may disconnect.

Mitigation:
- Prefer single large evaluate over multiple small ones
- Re-navigate when connection is lost
- Use DOM scraping (less detectable than API calls)

## Related

- **browser tool**: General browser automation
- **bilibili skill**: Bilibili video extraction
- **youtube skill**: YouTube video extraction
- **weixin-mp skill**: WeChat article extraction
