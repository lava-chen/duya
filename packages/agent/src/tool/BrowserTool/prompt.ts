/**
 * BrowserTool prompt
 * Generic browser automation - no platform-specific features exposed
 * Platform-specific capabilities are discovered via Skills
 */

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
- **browser_parallel** - Investigate multiple URLs simultaneously in separate browser windows

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

export function getPrompt(): string {
  return `## Browser Tool

The browser tool allows you to navigate and interact with web pages using a real Chrome browser.

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

- **browser_parallel** - Investigate multiple URLs simultaneously in separate browser windows
  \`\`\`json
  {"operation": "browser_parallel", "urls": ["https://site1.com", "https://site2.com"], "task": "Compare pricing", "timeoutMs": 30000}
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
11. **Use \`browser_parallel\` for multi-URL research** — it's MUCH faster than navigating each URL one at a time (5 parallel windows instead of 5 serial navigations)

### Discovering Platform-Specific Features

For specific platforms (like Bilibili, YouTube, etc.), check available skills.
Skills provide platform-specific guidance on how to use this tool effectively.
`;
}
