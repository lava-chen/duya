---
name: bilibili
description: Extract video info, subtitles, comments, and search videos from Bilibili (bilibili.com). Uses WBI-signed API calls to bypass风控 restrictions and properly fetch subtitle data.
version: 1.1.0
author: DUYA Agent
license: MIT
metadata:
  hermes:
    tags: [Bilibili, Video, Subtitle, Comments, Search, China, Media]
    related_skills: [youtube]
---

# Bilibili Video Platform

Extract content from Bilibili videos using the browser tool's evaluate operation.

## When to Use

Use this skill when the user wants to:
- Extract subtitles from a Bilibili video
- Get video metadata (title, author, views, etc.)
- Read comments from a video
- Search for videos on Bilibili
- Summarize or analyze video content

## Required Tool

This skill requires the **browser** tool. Use `browser_navigate` to load pages and `browser_evaluate` to extract data.

## Quick Start

### Extract Video Subtitles

```
1. browser_navigate: https://www.bilibili.com/video/{BV_ID}/
2. browser_evaluate: Extract CID from __INITIAL_STATE__
3. browser_evaluate: Call /x/player/wbi/v2 API with WBI signature to get subtitle list
4. browser_evaluate: Fetch subtitle JSON from CDN URL
5. Format and return subtitle data
```

### Get Video Info

```
1. browser_navigate: https://www.bilibili.com/video/{BV_ID}/
2. browser_evaluate: Extract metadata from __INITIAL_STATE__.videoData
```

## Detailed Operations

### 1. Extract Subtitles

**IMPORTANT**: Bilibili's `/x/player/wbi/v2` API requires WBI signature (w_rid parameter). Unsigned requests will be blocked by风控 and return 403. The skill includes inline WBI signing logic.

**Step 1: Navigate to video page**
```json
{"operation": "navigate", "url": "https://www.bilibili.com/video/BV1GbXPBeEZm/"}
```

**Step 2: Get CID from page state**
```json
{
  "operation": "evaluate",
  "script": "(function(){ const state=window.__INITIAL_STATE__||{}; return state?.videoData?.cid||null; })()"
}
```

**Step 3: Fetch subtitle list via WBI-signed API**
```json
{
  "operation": "evaluate",
  "script": "(async function(){ const bvid='BV1GbXPBeEZm'; const cid=CID_FROM_STEP_2; const MIXIN_KEY_ENC_TAB=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]; async function getWbiKeys(){ const res=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'}); const data=await res.json(); const wbiImg=data?.data?.wbi_img||{}; const imgKey=wbiImg.img_url?.split('/')?.pop()?.split('.')?.[0]||''; const subKey=wbiImg.sub_url?.split('/')?.pop()?.split('.')?.[0]||''; return {imgKey,subKey}; } function getMixinKey(imgKey,subKey){ const raw=imgKey+subKey; return MIXIN_KEY_ENC_TAB.map(i=>raw[i]||'').join('').slice(0,32); } async function md5(text){ const msgBuffer=new TextEncoder().encode(text); const hashBuffer=await crypto.subtle.digest('MD5',msgBuffer); return Array.from(new Uint8Array(hashBuffer)).map(b=>b.toString(16).padStart(2,'0')).join(''); } async function wbiSign(params){ const {imgKey,subKey}=await getWbiKeys(); const mixinKey=getMixinKey(imgKey,subKey); const wts=Math.floor(Date.now()/1000); const sorted={}; const allParams={...params,wts:String(wts)}; for(const key of Object.keys(allParams).sort()){ sorted[key]=String(allParams[key]).replace(/[!'()*]/g,''); } const query=new URLSearchParams(sorted).toString().replace(/\\+/g,'%20'); const wRid=await md5(query+mixinKey); sorted.w_rid=wRid; return sorted; } const signedParams=await wbiSign({bvid,cid}); const qs=new URLSearchParams(signedParams).toString().replace(/\\+/g,'%20'); const resp=await fetch('https://api.bilibili.com/x/player/wbi/v2?'+qs,{credentials:'include'}); const payload=await resp.json(); if(payload.code!==0)return {error:'API error: '+payload.message,code:payload.code}; const needLogin=payload.data?.need_login_subtitle===true; const subtitles=payload.data?.subtitle?.subtitles||[]; if(subtitles.length===0){ if(needLogin)return {error:'Subtitles require login'}; return {error:'No subtitles available'}; } return {subtitles:subtitles.map(s=>({lan:s.lan,lan_doc:s.lan_doc,subtitle_url:s.subtitle_url})),needLogin}; })()"
}
```

**Step 4: Fetch subtitle content from CDN**
```json
{
  "operation": "evaluate",
  "script": "(async function(){ const subtitleUrl='SUBTITLE_URL_FROM_STEP_3'; const finalUrl=subtitleUrl.startsWith('//')?'https:'+subtitleUrl:subtitleUrl; const resp=await fetch(finalUrl); const text=await resp.text(); if(text.startsWith('<!DOCTYPE')||text.startsWith('<html'))return {error:'HTML response (blocked)',text:text.substring(0,100)}; try{ const subJson=JSON.parse(text); if(Array.isArray(subJson?.body))return {success:true,data:subJson.body}; if(Array.isArray(subJson))return {success:true,data:subJson}; return {error:'Unknown JSON format',data:subJson}; }catch(e){ return {error:'Parse failed',text:text.substring(0,100)}; } })()"
}
```

**Step 5: Format output**
The subtitle JSON has structure: `{body: [{from, to, content, sid}]}`

Result:
```json
[
  {"index": 1, "from": "0.50s", "to": "3.20s", "content": "Hello everyone"},
  {"index": 2, "from": "3.20s", "to": "6.10s", "content": "Welcome to this video"}
]
```

**Available Languages:**
- `zh-CN` - Simplified Chinese (most common)
- `zh-TW` - Traditional Chinese
- `en-US` - English
- `ja-JP` - Japanese
- `ai-zh` - AI-generated Chinese
- `ai-en` - AI-generated English

**Note:** Some videos require login for subtitles. The browser tool uses the user's Chrome profile.

### 2. Extract Video Metadata

Video metadata is in `window.__INITIAL_STATE__.videoData`.

```json
{
  "operation": "evaluate",
  "script": "(function(){ const d=window.__INITIAL_STATE__?.videoData; if(!d)return null; return {bvid:d.bvid,title:d.title,description:d.desc,duration:d.duration,owner:{name:d.owner.name,mid:d.owner.mid},stat:{view:d.stat.view,like:d.stat.like,coin:d.stat.coin,favorite:d.stat.favorite,danmaku:d.stat.danmaku},pubdate:new Date(d.pubdate*1000).toISOString(),pic:d.pic}; })()"
}
```

**Fields:**
| Field | Description |
|-------|-------------|
| bvid | BV ID |
| title | Video title |
| description | Video description |
| duration | Duration in seconds |
| owner.name | Uploader name |
| owner.mid | Uploader ID |
| stat.view | View count |
| stat.like | Like count |
| stat.coin | Coin count |
| stat.favorite | Favorite count |
| stat.danmaku | Danmaku count |
| pubdate | Publish date (ISO) |
| pic | Thumbnail URL |

### 3. Extract Comments

Comments are in `window.__INITIAL_STATE__.comment.data.replies`.

**Step 1: Navigate and scroll to comments**
```json
{"operation": "navigate", "url": "https://www.bilibili.com/video/BV1GbXPBeEZm/"}
```

Then scroll down:
```json
{"operation": "scroll", "direction": "down", "amount": 800}
```

**Step 2: Extract comments**
```json
{
  "operation": "evaluate",
  "script": "(function(){ const replies=window.__INITIAL_STATE__?.comment?.data?.replies; if(!replies)return[]; return replies.slice(0,20).map(r=>({content:r.content.message,author:r.member.uname,like:r.like,time:new Date(r.ctime*1000).toISOString(),replies:r.replies?.map(rr=>({content:rr.content.message,author:rr.member.uname}))||[]})); })()"
}
```

### 4. Search Videos

**Step 1: Navigate to search**
```json
{"operation": "navigate", "url": "https://search.bilibili.com/all?keyword=Python教程"}
```

**Step 2: Extract results**
```json
{
  "operation": "evaluate",
  "script": "(function(){ const results=window.__INITIAL_STATE__?.flow?.data?.result; if(!results)return[]; return results.filter(r=>r.result_type==='video').map(r=>{const v=r.data;return{bvid:v.bvid,title:v.title.replace(/<[^>]+>/g,''),author:v.author,play:v.play,danmaku:v.danmaku,pic:v.pic}}).slice(0,20); })()"
}
```

## Complete Workflows

### Workflow: Extract Video with Subtitles

```
User: "帮我提取 BV1GbXPBeEZm 的字幕"

Agent:
1. browser_navigate → {"operation": "navigate", "url": "https://www.bilibili.com/video/BV1GbXPBeEZm/"}
2. browser_evaluate → Extract CID from __INITIAL_STATE__
3. browser_evaluate → Call /x/player/wbi/v2 with WBI signature
4. If subtitles found:
   - browser_evaluate → Fetch subtitle JSON from CDN
   - Format and return
5. If no subtitles:
   - Inform user (may need login or video has no subtitles)
```

### Workflow: Summarize Video Content

```
User: "总结一下这个视频的内容 BV1GbXPBeEZm"

Agent:
1. browser_navigate → {"operation": "navigate", "url": "https://www.bilibili.com/video/BV1GbXPBeEZm/"}
2. browser_evaluate → {"operation": "evaluate", "script": "(function(){ const d=window.__INITIAL_STATE__?.videoData; if(!d)return null; return {title:d.title,description:d.desc,duration:d.duration,owner:d.owner.name,stat:{view:d.stat.view,like:d.stat.like}}; })()"}
3. browser_evaluate → Extract CID, call WBI API for subtitles
4. If subtitles available:
   - Fetch subtitle content
   - Summarize main points
5. If no subtitles:
   - Use title + description + comments for summary
```

### Workflow: Search and Compare

```
User: "搜索Python教程，找播放量最高的"

Agent:
1. browser_navigate → https://search.bilibili.com/all?keyword=Python教程&order=click
2. browser_evaluate → Extract top 20 results
3. Sort by play count
4. Return top 5 with details
```

## Tips

1. **BV IDs are case-sensitive** - `BV1GbXPBeEZm` not `bv1gbxpbeezm`
2. **Use WBI-signed API for subtitles** - Direct fetch without signature will be blocked by风控
3. **Handle missing data** - Some videos have no subtitles or comments disabled
4. **Login may be required** - For some restricted content or AI subtitles
5. **Scroll for lazy loading** - Comments and related videos may need scrolling
6. **Check for null** - Always check if `__INITIAL_STATE__` exists before accessing properties

## Common Issues

| Issue | Solution |
|-------|----------|
| 403 Forbidden on subtitle API | Must use WBI-signed request (see Step 3) |
| Empty subtitle_url | May require login or be blocked by风控 |
| No subtitle data | Video may not have subtitles or requires login |
| Empty comments | Comments may be disabled or need scrolling |
| Page not loading | Check BV ID is correct and case-sensitive |
| Data is null | Wait for page to fully load before evaluating |

## Technical Notes

### Why WBI Signature?

Bilibili's WBI (Web Interface) API requires a signed `w_rid` parameter generated from:
1. Current WBI keys (from `/x/web-interface/nav`)
2. Request parameters sorted alphabetically
3. A mixin key derived from img_key + sub_key
4. MD5 hash of (query_string + mixin_key)

Unsigned requests to `/x/player/wbi/v2` will return 403 HTML instead of JSON.

### WBI Signing Process

1. Fetch current WBI keys from `https://api.bilibili.com/x/web-interface/nav`
2. Extract `img_key` and `sub_key` from `wbi_img` field
3. Generate mixin key using a fixed permutation table
4. Sort all request parameters alphabetically
5. Add `wts` (timestamp) parameter
6. Encode as query string (use `%20` not `+` for spaces)
7. Calculate MD5 of (query_string + mixin_key) → `w_rid`
8. Append `w_rid` to parameters

## Related

- **youtube skill**: Similar functionality for YouTube
- **browser tool**: General browser automation capabilities
