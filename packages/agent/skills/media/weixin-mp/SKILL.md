---
name: weixin-mp
description: Extract and download WeChat Official Account articles (mp.weixin.qq.com). Convert articles to Markdown with images, code blocks, and metadata. Handles anti-bot verification detection.
version: 1.0.0
author: DUYA Agent
license: MIT
metadata:
  hermes:
    tags: [WeChat, Weixin, 微信公众号, Article, Markdown, Download, Media]
    related_skills: [bilibili, youtube]
---

# WeChat Official Account Articles (微信公众号)

Extract and download WeChat articles using the browser tool's evaluate operation.

## When to Use

Use this skill when the user wants to:
- Download a WeChat article as Markdown
- Extract article content, title, author, publish time
- Save article images locally
- Convert WeChat articles to readable format
- Archive WeChat articles

## Required Tool

This skill requires the **browser** tool. Use `browser_navigate` to load pages and `browser_evaluate` to extract data.

## Quick Start

### Download Article as Markdown

```
1. browser_navigate: https://mp.weixin.qq.com/s/xxx
2. browser_evaluate: Extract article metadata and content
3. browser_evaluate: Process images (data-src -> src)
4. Format as Markdown with frontmatter
```

## Detailed Operations

### 1. Extract Article Metadata

WeChat articles store metadata in the DOM.

**Step 1: Navigate to article**
```json
{"operation": "navigate", "url": "https://mp.weixin.qq.com/s/EXAMPLE"}
```

**Step 2: Extract metadata**
```json
{
  "operation": "evaluate",
  "script": "(function(){ const pickFirst=(...sels)=>{for(const sel of sels){const t=document.querySelector(sel)?.textContent?.replace(/\\s+/g,' ').trim();if(t&&t!=='Name cleared')return t;}return'';}; return {title:pickFirst('#activity-name','#js_text_title','.rich_media_title'),author:pickFirst('#js_name','.wx_follow_nickname','#profileBt .profile_nickname','.rich_media_meta_nickname'),publishTime:document.querySelector('#publish_time')?.textContent?.trim()||''}; })()"
}
```

**Metadata Fields:**
| Field | Selector | Description |
|-------|----------|-------------|
| title | `#activity-name`, `#js_text_title` | Article title |
| author | `#js_name`, `.wx_follow_nickname` | Official account name |
| publishTime | `#publish_time` | Publish time text |

### 2. Extract Publish Time (Advanced)

If `#publish_time` is empty, extract from inline scripts:

```json
{
  "operation": "evaluate",
  "script": "(function(){ const html=document.documentElement.innerHTML; const jsMatch=html.match(/create_time\\s*:\\s*JsDecode\\('([^']+)'\\)/); const directMatch=html.match(/create_time\\s*[:=]\\s*(?:\"([^\"]+)\"|'([^']+)'|([0-9A-Za-z]+))/); const raw=jsMatch?jsMatch[1]:(directMatch?(directMatch[1]||directMatch[2]||directMatch[3]):''); if(!/^\\d{10}$|^\\d{13}$/.test(raw))return''; const ts=raw.length===13?parseInt(raw):parseInt(raw)*1000; const d=new Date(ts); const pad=(n)=>String(n).padStart(2,'0'); const utc8=new Date(d.getTime()+8*3600*1000); return `${utc8.getUTCFullYear()}-${pad(utc8.getUTCMonth()+1)}-${pad(utc8.getUTCDate())} ${pad(utc8.getUTCHours())}:${pad(utc8.getUTCMinutes())}:${pad(utc8.getUTCSeconds())}`; })()"
}
```

### 3. Extract Article Content

Extract HTML content and convert to Markdown.

```json
{
  "operation": "evaluate",
  "script": "(function(){ const result={contentHtml:'',codeBlocks:[],imageUrls:[],errorHint:''}; const pickFirst=(...sels)=>{for(const sel of sels){const t=document.querySelector(sel)?.textContent?.replace(/\\s+/g,' ').trim();if(t&&t!=='Name cleared')return t;}return'';}; result.title=pickFirst('#activity-name','#js_text_title','.rich_media_title'); result.author=pickFirst('#js_name','.wx_follow_nickname','.rich_media_meta_nickname'); const publishTimeEl=document.querySelector('#publish_time'); result.publishTime=publishTimeEl?publishTimeEl.textContent.trim():''; const detectIssue=(()=>{const t=(document.body?.innerText||'').replace(/\\s+/g,' ').trim(); if(/环境异常/.test(t)&&/(完成验证后即可继续访问|去验证)/.test(t))return'environment verification required'; const h=document.documentElement.innerHTML; if(/secitptpage\\/verify\\.html/.test(h)||/id=[\"']js_verify[\"']/.test(h))return'environment verification required'; return'';})(); result.errorHint=detectIssue; if(detectIssue)return result; const contentEl=document.querySelector('#js_content'); if(!contentEl)return result; contentEl.querySelectorAll('img[data-src]').forEach(img=>{const ds=img.getAttribute('data-src');if(ds)img.setAttribute('src',ds);}); const codeBlocks=[]; contentEl.querySelectorAll('.code-snippet__fix').forEach(el=>{el.querySelectorAll('.code-snippet__line-index').forEach(li=>li.remove()); const pre=el.querySelector('pre[data-lang]'); const lang=pre?(pre.getAttribute('data-lang')||''):''; const lines=[]; el.querySelectorAll('code').forEach(codeTag=>{const text=codeTag.textContent; if(/^[ce]?ounter\\(line/.test(text))return; lines.push(text); }); if(lines.length===0)lines.push(el.textContent); const placeholder='CODEBLOCK-PLACEHOLDER-'+codeBlocks.length; codeBlocks.push({lang,code:lines.join('\\n')}); const p=document.createElement('p'); p.textContent=placeholder; el.replaceWith(p); }); result.codeBlocks=codeBlocks; ['script','style','.qr_code_pc','.reward_area'].forEach(sel=>{contentEl.querySelectorAll(sel).forEach(tag=>tag.remove());}); const seen=new Set(); contentEl.querySelectorAll('img[src]').forEach(img=>{const src=img.getAttribute('src'); if(src&&!seen.has(src)){seen.add(src);result.imageUrls.push(src);}}); result.contentHtml=contentEl.innerHTML; return result; })()"
}
```

**Content Processing:**
1. Fix lazy-loaded images (`data-src` -> `src`)
2. Extract code blocks with language info
3. Remove noise elements (QR codes, reward buttons)
4. Collect image URLs

### 4. Convert to Markdown

After extracting HTML content, convert to Markdown:

```javascript
// This is done in the agent's response, not in browser evaluate
function htmlToMarkdown(html, title, author, publishTime, codeBlocks) {
  let md = `---\n`;
  md += `title: "${title}"\n`;
  md += `author: "${author}"\n`;
  md += `date: "${publishTime}"\n`;
  md += `source: "WeChat Official Account"\n`;
  md += `---\n\n`;
  
  // Convert HTML to Markdown (simplified)
  // Replace headings
  let content = html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, '![image]($1)\n\n')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<[^>]+>/g, ''); // Remove remaining tags
  
  // Replace code block placeholders
  codeBlocks.forEach((block, i) => {
    const placeholder = `CODEBLOCK-PLACEHOLDER-${i}`;
    const codeMd = `\`\`\`${block.lang}\n${block.code}\n\`\`\`\n\n`;
    content = content.replace(placeholder, codeMd);
  });
  
  return md + content;
}
```

## Complete Workflows

### Workflow: Download Article

```
User: "帮我下载这篇公众号文章 https://mp.weixin.qq.com/s/xxx"

Agent:
1. browser_navigate → https://mp.weixin.qq.com/s/xxx
2. browser_evaluate → Extract article data (title, author, content, images)
3. If anti-bot detected:
   - Inform user that manual verification may be needed
4. Process content:
   - Convert HTML to Markdown
   - Replace code block placeholders
   - Format frontmatter
5. Return Markdown content to user
6. Optionally save to file
```

### Workflow: Extract Article Info

```
User: "提取这个公众号文章的信息"

Agent:
1. browser_navigate → article URL
2. browser_evaluate → Extract metadata
3. Return: {title, author, publishTime, url}
```

### Workflow: Batch Download

```
User: "下载这几篇公众号文章 [url1, url2, url3]"

Agent:
1. For each URL:
   - browser_navigate → URL
   - browser_evaluate → Extract content
   - Convert to Markdown
   - Add to results
2. Return all articles or save to files
```

## Anti-Bot Handling

WeChat has anti-bot protection. The browser tool handles this automatically:

| Issue | Detection | Solution |
|-------|-----------|----------|
| Environment verification | Page shows "环境异常" | Inform user to verify manually in browser |
| CAPTCHA | URL contains `verify.html` | Ask user to complete CAPTCHA |
| Access denied | HTTP 403 | Try again with user's Chrome profile |

## Tips

1. **URL format**: `https://mp.weixin.qq.com/s/XXXXX` or `https://mp.weixin.qq.com/s?__biz=...&mid=...`
2. **Images**: WeChat uses lazy loading (`data-src`), the tool automatically fixes this
3. **Code blocks**: Preserved with language info
4. **Anti-bot**: If detected, the tool will inform you
5. **Login**: Usually not required for public articles

## Common Issues

| Issue | Solution |
|-------|----------|
| "环境异常" | Open article in Chrome manually and complete verification |
| Empty content | Wait for page to fully load before extracting |
| Missing images | Check if images require Referer header |
| Garbled text | WeChat may use custom fonts, text should still be extractable |

## Related

- **browser tool**: General browser automation
- **bilibili skill**: Video platform extraction
- **youtube skill**: YouTube video extraction
