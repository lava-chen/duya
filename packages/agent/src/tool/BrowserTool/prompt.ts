/**
 * BrowserTool prompt
 * Generic browser automation - no platform-specific features exposed
 * Platform-specific capabilities are discovered via Skills
 */

import type { NetworkEnvironment } from './types.js';

export const DESCRIPTION = `Navigate and interact with web pages using a real browser.

This tool provides generic web browsing capabilities:
- Navigate to URLs and wait for page load (auto-returns compact snapshot)
- Get DOM snapshots (structured text representation of the page)
- Click elements, type text, scroll pages, hover, select options
- Execute JavaScript in page context
- Take screenshots
- Wait for elements or conditions
- Manage tabs (list, create, close, switch)
- Upload files
- Capture network requests
- Evaluate JavaScript in iframes
- Access cookies
- **parallel_fetch** - Investigate multiple URLs simultaneously (fast HTTP or real browsers)

Use this when you need to:
- Access JavaScript-heavy websites (SPAs, React/Vue apps)
- Interact with web pages (click, type, submit forms)
- Extract data from dynamic content
- Access sites that require login/cookies
- Get visual information via screenshots
- Manage multiple tabs
- Upload files to websites
- Monitor network requests
- **Research or compare multiple websites at once (parallel investigation)**

The tool returns a DOM snapshot with interactive elements marked with [ref] IDs.
Use these refs for click and type operations.

Example workflow:
1. browser_navigate → Load a page (gets compact snapshot automatically)
2. browser_snapshot → See full page structure with [ref] IDs
3. browser_click ref="@3" → Click an element
4. browser_type ref="@1" text="hello" → Type into an input
`;

function buildStrategySection(networkEnv?: NetworkEnvironment): string {
  const envBlock = buildNetworkEnvBlock(networkEnv);

  return `### Search Strategy (Read Before Acting)

**Step 0 — Do you even need the browser?**
- If your training data answers the question with high confidence (stable facts,
  well-known APIs, language syntax, historical events), answer directly without
  the browser. The browser is slow — only use it when freshness or interactivity
  is required.
- If the question requires real-time information (current news, live prices,
  latest docs) or interaction (forms, login, dynamic content), use the browser.

**Step 1 — Direct URL vs Search**
- You already know the exact URL (official docs domain, GitHub repo, npm page,
  specific article you've visited before)? → Use \`browser_navigate\` to go
  there directly. Do NOT search for it first.
- You need to discover where the information lives? → Search. One query,
  read 2-3 results at most, then stop.

**Step 2 — Task budget**

| Task type | Max queries | Max pages | When to stop |
|-----------|------------|-----------|--------------|
| Single fact check | 1 | Read the key section | Answer found |
| Code problem / how-to | 1 | Scan 2-3 results | Working solution found |
| Comparison / research | Up to 3 | Up to 6 | Report, don't keep browsing |

Report what you found after each search cycle. Do NOT silently keep browsing.

**Step 3 — Engine selection**
${envBlock}

**Step 4 — Failure recovery (non-negotiable)**
- Page load exceeds 15 seconds OR returns an error → abandon that URL
  immediately. Do NOT retry the same URL.
- Execute Plan B in this order:
  1. Switch to an alternative search engine or platform for the same query
  2. Try a cached version (webcache.googleusercontent.com, archive.org)
  3. Try a different source that likely has the same information
- Two consecutive failures on the same goal → stop and tell the user what you
  tried. Ask whether to continue and how.`;
}

function buildNetworkEnvBlock(networkEnv?: NetworkEnvironment): string {
  switch (networkEnv) {
    case 'domestic':
      return `**Current network: Mainland China — Google, GitHub, YouTube are likely blocked.**

Decision order:
- Chinese content → Baidu (百度) directly, or direct URLs to Zhihu (知乎), CSDN, Juejin (掘金)
- English technical docs → try the official domain directly (many are accessible). Fallback: Bing CN (cn.bing.com)
- English code Q&A → Bing CN search. Avoid going to Stack Overflow directly
- If an international URL fails once → switch immediately. Do NOT retry it`;

    case 'overseas':
      return `**Current network: Overseas — full global access available.**

Decision order:
- English content → Google, or the official domain directly
- Chinese content → either Baidu or Google, both accessible
- Technical docs → always try the official domain first (faster than search)`;

    default:
      return `**Current network: Unknown.**

Decision order:
- English content → try the official domain directly first. Fallback to search
- Chinese content → Baidu (百度) or direct platform URLs
- If a page fails to load → switch to an alternative source immediately`;
  }
}

export function getPrompt(networkEnv?: NetworkEnvironment): string {
  const strategySection = buildStrategySection(networkEnv);

  return `## Browser Tool

The browser tool allows you to navigate and interact with web pages using a real Chrome browser.

${strategySection}

### Operations

- **navigate** - Load a URL
  \`\`\`json
  {"operation": "navigate", "url": "https://example.com"}
  \`\`\`

- **snapshot** - Get DOM snapshot with interactive element refs
  \`\`\`json
  {"operation": "snapshot"}
  \`\`\`
  Returns a text representation of the page with [1], [2], etc. marking interactive elements.

- **click** - Click an element by ref or selector
  \`\`\`json
  {"operation": "click", "ref": "@3"}
  \`\`\`

- **type** - Type text into an input
  \`\`\`json
  {"operation": "type", "ref": "@1", "text": "search query", "submit": true}
  \`\`\`

- **scroll** - Scroll the page
  \`\`\`json
  {"operation": "scroll", "direction": "down", "amount": 500}
  \`\`\`
  amount must be a number, not a string. Do NOT wrap it in quotes.

- **screenshot** - Take a screenshot
  \`\`\`json
  {"operation": "screenshot", "fullPage": true}
  \`\`\`

- **evaluate** - Execute JavaScript and return result
  \`\`\`json
  {"operation": "evaluate", "script": "(function()\{ return document.title; \})()"}
  \`\`\`
  The script must be a self-contained JavaScript expression or IIFE that:
  - Returns JSON-serializable data (object, array, string, number, etc.)
  - Does NOT use console.log to return data — return the value instead
  - Accesses window directly (e.g., window.__INITIAL_STATE__)

  The result is wrapped: &#123;result: &lt;return value&gt;, script: &lt;your script&gt;, mode: "extension"&#125;

  Common patterns:
  - Extract global state: window.__INITIAL_STATE__?.videoData
  - Map over a list: window.data?.items.map(i=&gt;(&#123;id:i.id,name:i.name&#125;))
  - Fetch + parse: (async()=&gt;&#123;const r=await fetch(url);return r.json();&#125;)()

  Tip: If you only need static text, snapshot is faster.

- **go_back** - Go back in history
  \`\`\`json
  {"operation": "go_back"}
  \`\`\`

- **press_key** - Press a key
  \`\`\`json
  {"operation": "press_key", "key": "Enter"}
  \`\`\`

- **hover** - Hover mouse over an element
  \`\`\`json
  {"operation": "hover", "ref": "@5"}
  \`\`\`
  Triggers mouseover and mouseenter events. Useful for revealing hover menus, tooltips, or dropdowns.

- **wait** - Wait for a condition
  \`\`\`json
  {"operation": "wait", "type": "ms", "value": "3000"}
  \`\`\`
  \`\`\`json
  {"operation": "wait", "type": "element", "value": ".results-loaded", "timeoutMs": 10000}
  \`\`\`
  Wait types:
  - \`ms\` — wait N milliseconds, \`value\` is duration in ms (e.g., "3000")
  - \`element\` — wait for a CSS selector to appear, \`value\` is the selector
  - \`load\` — wait for page to fully load (network idle)

- **select** - Select an option in a dropdown
  \`\`\`json
  {"operation": "select", "ref": "@2", "value": "option-value"}
  \`\`\`
  Sets the value of a <select> element and triggers a change event.

- **tabs_list** - List all open tabs
  \`\`\`json
  {"operation": "tabs_list"}
  \`\`\`

- **tabs_new** - Open a new tab
  \`\`\`json
  {"operation": "tabs_new", "url": "https://example.com"}
  \`\`\`

- **tabs_close** - Close a tab
  \`\`\`json
  {"operation": "tabs_close", "target": 1}
  \`\`\`

- **tabs_select** - Switch to a tab
  \`\`\`json
  {"operation": "tabs_select", "target": 0}
  \`\`\`

- **file_upload** - Upload files to a file input
  \`\`\`json
  {"operation": "file_upload", "selector": "input[type=file]", "files": ["/path/to/file.pdf"]}
  \`\`\`

- **network_start** - Start capturing network requests
  \`\`\`json
  {"operation": "network_start", "pattern": "api"}
  \`\`\`

- **network_read** - Read captured network requests
  \`\`\`json
  {"operation": "network_read"}
  \`\`\`

- **iframe_evaluate** - Execute JavaScript in an iframe
  \`\`\`json
  {"operation": "iframe_evaluate", "frameIndex": 0, "script": "document.title"}
  \`\`\`

- **cookies** - Get browser cookies
  \`\`\`json
  {"operation": "cookies", "domain": "example.com"}
  \`\`\`

- **close_window** - Close the browser automation window
  \`\`\`json
  {"operation": "close_window"}
  \`\`\`
  Use this when you are done with browser operations to clean up the automation window.

- **parallel_fetch** - Investigate multiple URLs simultaneously (fast HTTP or real browsers)
  \`\`\`json
  {"operation": "parallel_fetch", "urls": ["https://site1.com", "https://site2.com"], "task": "Compare pricing", "timeoutMs": 30000}
  Uses real browsers by default (Extension CDP / Duya browser plugin). Set \`"useBrowser": false\` for fast HTTP only (no JS rendering).
  \`\`\`
  **Required parameter: \`urls\`** — must be an array of URL strings. Example: ["https://a.com", "https://b.com"]
  Opens multiple independent browser sessions (up to 5) to investigate different URLs at the same time.
  Each URL gets its own browser window and DOM snapshot.
  Use this for:
  - Comparing multiple products/prices across sites
  - Researching a topic across multiple sources simultaneously
  - Any task requiring data from multiple URLs where serial navigation would be too slow
  Returns: results array with snapshot, interactiveElements, and timing for each URL.

### Tips

1. After navigating, the tool returns a compact snapshot automatically — use \`browser_snapshot\` for full view
2. Use refs (e.g., @3) from the snapshot for clicking and typing
3. Wait for page loads between actions (the tool handles this automatically)
4. For SPAs, use snapshot to verify state changes after clicks
5. Screenshots are useful for visual verification
6. Use tabs to manage multiple pages simultaneously
7. Network capture helps debug API calls and dynamic content loading
8. The evaluate operation is very powerful - you can extract any data from the page by writing JavaScript
9. Many websites store data in global variables like window.__INITIAL_STATE__ or window.ytInitialData
10. **Always call \`close_window\` when you are done with browser operations** - this closes the automation window and cleans up resources
11. **Use \`parallel_fetch\` for multi-URL research** — it opens multiple browser windows in parallel (up to 5) using the Duya browser plugin. Much faster than navigating each URL one at a time. Set \`useBrowser: false\` to disable JS rendering for faster static fetches.

### Discovering Platform-Specific Features

For specific platforms (like Bilibili, YouTube, etc.), check available skills.
Skills provide platform-specific guidance on how to use this tool effectively.
`;
}