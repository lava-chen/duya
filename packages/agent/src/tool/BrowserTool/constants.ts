/**
 * BrowserTool constants
 */

export const BROWSER_TOOL_NAME = 'browser';

export const BROWSER_TOOL_DESCRIPTION = `Navigate and interact with web pages using a real browser.

This tool provides powerful web browsing capabilities:
- Navigate to URLs and wait for page load (auto-returns compact snapshot)
- Get DOM snapshots (structured text representation of the page)
- Click elements, type text, scroll pages, hover, select dropdowns
- Execute JavaScript in page context
- Take screenshots
- Wait for elements, page loads, or time intervals
- Manage multiple tabs and browser windows
- **browser_parallel** - Investigate multiple URLs simultaneously (multi-window parallel research)

Use this when you need to:
- Access JavaScript-heavy websites (SPAs, React/Vue apps)
- Interact with web pages (click, type, submit forms)
- Extract data from dynamic content
- Access sites that require login/cookies
- Get visual information via screenshots
- **Research multiple websites in parallel for comparison or efficiency**

The tool returns a DOM snapshot with interactive elements marked with [ref] IDs.
Use these refs for click and type operations.

Example workflow:
1. browser_navigate → Load a page (gets compact snapshot automatically)
2. browser_snapshot → See full page structure with [ref] IDs
3. browser_click ref="@3" → Click an element
4. browser_type ref="@1" text="hello" → Type into an input
**5. browser_parallel → Investigate multiple URLs simultaneously (faster research)**
`;

export const DEFAULT_TIMEOUT = 30000;
export const MAX_CONTENT_LENGTH = 500000;
export const SNAPSHOT_MAX_LENGTH = 100000;
