---
name: twitter
description: Extract tweets, timelines, and search results from X (Twitter) using the browser tool. Uses DOM-based extraction as the primary method (more reliable than API), with API as fallback. Handles X's SPA navigation and tab disconnection.
version: 1.1.0
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
- Extract tweet content, likes, retweets
- Monitor specific accounts

## Required Tool

This skill requires the **browser** tool. Use `browser_navigate` to load pages and `browser_evaluate` to extract data.

**Important:** X requires login for most operations. The browser tool uses the user's Chrome profile.

## Architecture Decision

Based on testing, **DOM extraction is more reliable than GraphQL API** for X:

| Method | Pros | Cons |
|--------|------|------|
| **DOM (Primary)** | No auth tokens needed; works with page cookies; stable | Need to handle SPA lazy loading |
| **API (Fallback)** | Structured data; can fetch more items | Bearer token expires; Query IDs change frequently; tab disconnection after ~5 requests |

**Strategy:** Use DOM extraction as primary method. Use API only when DOM method fails.

## Quick Start

### Fetch User Tweets (DOM Method)

```
1. browser_navigate: https://x.com/USERNAME
2. browser_evaluate: Extract tweets from article[data-testid="tweet"] elements
3. Scroll to load more (if needed)
4. Parse and return tweet data
```

### Search Tweets (DOM Method)

```
1. browser_navigate: https://x.com/search?q=QUERY&f=live
2. browser_evaluate: Extract tweets from article[data-testid="tweet"]
3. Return results
```

## Detailed Operations

### 1. Extract Tweets via DOM (Primary Method)

Extract tweets directly from rendered DOM. No API tokens needed.

**Step 1: Navigate to user profile or search**
```json
{"operation": "navigate", "url": "https://x.com/xdash"}
```

**Step 2: Extract tweets from DOM**
```json
{
  "operation": "evaluate",
  "script": "(function(){ const articles=document.querySelectorAll('article[data-testid=\"tweet\"]'); const tweets=[]; for(const article of articles){ try{ const textEl=article.querySelector('[data-testid=\"tweetText\"]'); const text=textEl?textEl.textContent.trim():''; const userEl=article.querySelector('[data-testid=\"User-Name\"] a'); const userLink=userEl?userEl.getAttribute('href'):''; const author=userLink?userLink.replace('/',''):''; const timeEl=article.querySelector('time'); const time=timeEl?timeEl.getAttribute('datetime'):''; const stats=article.querySelectorAll('[data-testid=\"like\"],[data-testid=\"retweet\"],[data-testid=\"reply\"]'); let likes=0,retweets=0,replies=0; for(const stat of stats){ const label=stat.getAttribute('aria-label')||''; const match=label.match(/([\\d,]+)/); const num=match?parseInt(match[1].replace(/,/g,''),10):0; if(stat.getAttribute('data-testid')==='like')likes=num; else if(stat.getAttribute('data-testid')==='retweet')retweets=num; else if(stat.getAttribute('data-testid')==='reply')replies=num; } const linkEl=article.querySelector('a[href*=\"/status/\"]'); const statusPath=linkEl?linkEl.getAttribute('href'):''; const url=statusPath?'https://x.com'+statusPath:''; if(text){ tweets.push({author,text,likes,retweets,replies,time,url}); } }catch(e){} } return tweets; })()"
}
```

**Step 3: Scroll to load more (optional)**
```json
{"operation": "scroll", "direction": "down", "amount": 800}
```

Then re-run Step 2 to get newly loaded tweets.

**Tweet Fields:**
| Field | Description |
|-------|-------------|
| author | Screen name (@handle) |
| text | Tweet text content |
| likes | Like count |
| retweets | Retweet count |
| replies | Reply count |
| time | ISO timestamp |
| url | Direct link to tweet |

### 2. Search Tweets via DOM

**Step 1: Navigate to search with query**
```json
{"operation": "navigate", "url": "https://x.com/search?q=machine%20learning&f=live"}
```

**Step 2: Extract search results**
```json
{
  "operation": "evaluate",
  "script": "(function(){ const articles=document.querySelectorAll('article[data-testid=\"tweet\"]'); const tweets=[]; for(const article of articles){ try{ const textEl=article.querySelector('[data-testid=\"tweetText\"]'); const text=textEl?textEl.textContent.trim():''; const userEl=article.querySelector('[data-testid=\"User-Name\"] a'); const userLink=userEl?userEl.getAttribute('href'):''; const author=userLink?userLink.replace('/',''):''; const timeEl=article.querySelector('time'); const time=timeEl?timeEl.getAttribute('datetime'):''; const stats=article.querySelectorAll('[data-testid=\"like\"],[data-testid=\"retweet\"],[data-testid=\"reply\"]'); let likes=0,retweets=0,replies=0; for(const stat of stats){ const label=stat.getAttribute('aria-label')||''; const match=label.match(/([\\d,]+)/); const num=match?parseInt(match[1].replace(/,/g,''),10):0; if(stat.getAttribute('data-testid')==='like')likes=num; else if(stat.getAttribute('data-testid')==='retweet')retweets=num; else if(stat.getAttribute('data-testid')==='reply')replies=num; } const linkEl=article.querySelector('a[href*=\"/status/\"]'); const statusPath=linkEl?linkEl.getAttribute('href'):''; const url=statusPath?'https://x.com'+statusPath:''; if(text){ tweets.push({author,text,likes,retweets,replies,time,url}); } }catch(e){} } return tweets; })()"
}
```

**Search Filters:**
- `f=live` — Latest tweets
- `f=top` — Top tweets
- Add `&f=media` for media only

### 3. Fetch Home Timeline via DOM

**Step 1: Navigate to home**
```json
{"operation": "navigate", "url": "https://x.com/home"}
```

**Step 2: Extract timeline tweets**
```json
{
  "operation": "evaluate",
  "script": "(function(){ const articles=document.querySelectorAll('article[data-testid=\"tweet\"]'); const tweets=[]; for(const article of articles){ try{ const textEl=article.querySelector('[data-testid=\"tweetText\"]'); const text=textEl?textEl.textContent.trim():''; const userEl=article.querySelector('[data-testid=\"User-Name\"] a'); const userLink=userEl?userEl.getAttribute('href'):''; const author=userLink?userLink.replace('/',''):''; const timeEl=article.querySelector('time'); const time=timeEl?timeEl.getAttribute('datetime'):''; const stats=article.querySelectorAll('[data-testid=\"like\"],[data-testid=\"retweet\"],[data-testid=\"reply\"]'); let likes=0,retweets=0,replies=0; for(const stat of stats){ const label=stat.getAttribute('aria-label')||''; const match=label.match(/([\\d,]+)/); const num=match?parseInt(match[1].replace(/,/g,''),10):0; if(stat.getAttribute('data-testid')==='like')likes=num; else if(stat.getAttribute('data-testid')==='retweet')retweets=num; else if(stat.getAttribute('data-testid')==='reply')replies=num; } const linkEl=article.querySelector('a[href*=\"/status/\"]'); const statusPath=linkEl?linkEl.getAttribute('href'):''; const url=statusPath?'https://x.com'+statusPath:''; if(text){ tweets.push({author,text,likes,retweets,replies,time,url}); } }catch(e){} } return tweets; })()"
}
```

### 4. API Fallback (When DOM Fails)

If DOM extraction fails (e.g., page not loading, anti-bot), use API fallback with dynamic Query ID resolution.

**Step 1: Resolve GraphQL Query ID**
```json
{
  "operation": "evaluate",
  "script": "(async function(){ const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),5000); try{ const resp=await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json',{signal:controller.signal}); clearTimeout(timeout); if(!resp.ok)return {error:'GitHub fetch failed'}; const data=await resp.json(); return {userTweets:data?.UserTweets?.queryId,searchTimeline:data?.SearchTimeline?.queryId,homeTimeline:data?.HomeTimeline?.queryId}; }catch(e){ clearTimeout(timeout); return {error:e.message}; } })()"
}
```

**Step 2: Get auth token**
```json
{
  "operation": "evaluate",
  "script": "document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('ct0='))?.split('=')[1]||null"
}
```

**Step 3: Call API with resolved Query ID**
```json
{
  "operation": "evaluate",
  "script": "(async function(){ const QUERY_ID='QUERY_ID_FROM_STEP_1'; const USER_ID='USER_ID'; const bearer='AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'; const ct0=document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('ct0='))?.split('=')[1]; const headers={'Authorization':`Bearer ${decodeURIComponent(bearer)}`,'X-Csrf-Token':ct0,'X-Twitter-Auth-Type':'OAuth2Session','X-Twitter-Active-User':'yes'}; const vars={userId:USER_ID,count:20,includePromotedContent:false}; const features={rweb_video_screen_enabled:false,profile_label_improvements_pcf_label_in_post_enabled:true,rweb_tipjar_consumption_enabled:true,verified_phone_label_enabled:false,creator_subscriptions_tweet_preview_api_enabled:true,responsive_web_graphql_timeline_navigation_enabled:true,responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,premium_content_api_read_enabled:false,communities_web_enable_tweet_community_results_fetch:true,c9s_tweet_anatomy_moderator_badge_enabled:true,responsive_web_grok_analyze_button_fetch_trends_enabled:false,responsive_web_grok_analyze_post_followups_enabled:true,responsive_web_jetfuel_frame:true,responsive_web_grok_share_attachment_enabled:true,articles_preview_enabled:true,responsive_web_edit_tweet_api_enabled:true,graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,view_counts_everywhere_api_enabled:true,longform_notetweets_consumption_enabled:true,responsive_web_twitter_article_tweet_consumption_enabled:true,tweet_awards_web_tipping_enabled:false,content_disclosure_indicator_enabled:true,content_disclosure_ai_generated_indicator_enabled:true,responsive_web_grok_show_grok_translated_post:false,responsive_web_grok_analysis_button_from_backend:true,post_ctas_fetch_enabled:false,freedom_of_speech_not_reach_fetch_enabled:true,standardized_nudges_misinfo:true,tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:true,longform_notetweets_rich_text_read_enabled:true,longform_notetweets_inline_media_enabled:true,responsive_web_grok_image_annotation_enabled:true,responsive_web_enhance_cards_enabled:false}; const url='/i/api/graphql/'+QUERY_ID+'/UserTweets?variables='+encodeURIComponent(JSON.stringify(vars))+'&features='+encodeURIComponent(JSON.stringify(features)); const resp=await fetch(url,{headers,credentials:'include'}); if(!resp.ok)return{error:'HTTP '+resp.status}; const data=await resp.json(); const instructions=data?.data?.user?.result?.timeline_v2?.timeline?.instructions||[]; const tweets=[]; const seen=new Set(); for(const inst of instructions){ for(const entry of inst.entries||[]){ const item=entry.content?.itemContent?.tweet_results?.result; if(!item)continue; const tw=item.tweet||item; const l=tw.legacy||{}; if(!tw.rest_id||seen.has(tw.rest_id))continue; seen.add(tw.rest_id); const u=tw.core?.user_results?.result; const screenName=u?.legacy?.screen_name||'unknown'; tweets.push({id:tw.rest_id,author:screenName,text:tw.note_tweet?.note_tweet_results?.result?.text||l.full_text||'',likes:l.favorite_count||0,retweets:l.retweet_count||0,replies:l.reply_count||0,created_at:l.created_at||'',url:`https://x.com/${screenName}/status/${tw.rest_id}`}); } } return {tweets}; })()"
}
```

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
User: "获取 xdash 最近的推文"

Agent:
1. browser_navigate → https://x.com/xdash
2. browser_evaluate → Extract tweets from article[data-testid="tweet"]
3. If tweets found:
   - Format and return
4. If empty (page not loaded):
   - Wait 2 seconds, scroll down
   - Re-evaluate
5. If still empty:
   - Use API fallback (resolve Query ID → get auth → call API)
```

### Workflow: Search Tweets

```
User: "搜索关于 AI 的最新推文"

Agent:
1. browser_navigate → https://x.com/search?q=AI&f=live
2. browser_evaluate → Extract tweets from DOM
3. Return results
```

### Workflow: Monitor Timeline

```
User: "看看我的时间线有什么新内容"

Agent:
1. browser_navigate → https://x.com/home
2. browser_evaluate → Extract timeline tweets from DOM
3. Return recent tweets
```

## Tips

1. **DOM method is primary** — More reliable, no token management needed
2. **Login required** — X blocks most content without login
3. **Tab disconnection** — ~5 evaluate calls may disconnect; re-navigate if needed
4. **Scroll for more** — Lazy loading requires scrolling to load more tweets
5. **Search filters** — Use `f=live` for latest, `f=top` for top tweets
6. **Batch extraction** — Do as much as possible in single evaluate to avoid disconnection

## Common Issues

| Issue | Solution |
|-------|----------|
| Empty results | Page may not be loaded; wait 2s and retry |
| Tab disconnected | Re-navigate to the page |
| Not logged in | Log into X in Chrome before using |
| Rate limited (API) | Switch to DOM method |
| Query ID expired (API) | Resolve latest Query ID from GitHub |

## Technical Notes

### Why DOM over API?

Testing shows DOM extraction is more reliable for X:
- No Bearer token expiration issues
- No Query ID maintenance
- Works with existing login session
- Less likely to trigger anti-bot

API is kept as fallback for edge cases.

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
