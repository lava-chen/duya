/**
 * BrowserTool constants
 */

export const BROWSER_TOOL_NAME = 'browser';

export const BROWSER_TOOL_DESCRIPTION = `Navigate and interact with web pages using a real browser.

This tool provides powerful web browsing capabilities:
- Navigate to URLs and wait for page load (auto-returns compact snapshot)
- Get DOM snapshots (structured text representation of the page)
- Click elements, type text, scroll pages, hover, select dropdowns
- Computer-use operations: click_at (coordinates, double/right click), drag, key_combo (Ctrl+A/C/V...), mouse_move, scroll_to, refresh, clipboard, handle_dialog
- Execute JavaScript in page context
- Take screenshots (annotate mode overlays numbered marks with coordinates for vision-driven clicking)
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
Prefer direct URL navigation over search when the target URL is known.
Use parallel_fetch for multi-source research tasks.

Example workflow:
1. browser_navigate → Load a page (gets compact snapshot automatically)
2. browser_snapshot → See full page structure with [ref] IDs
3. browser_click ref="@3" → Click an element
4. browser_type ref="@1" text="hello" → Type into an input
**5. browser_parallel → Investigate multiple URLs simultaneously (faster research)**
`;

export const BROWSER_TOOL_DESCRIPTION_HUMAN_LIKE = `Navigate and interact with web pages using a real browser with HUMAN-LIKE input (computer-use mode).

This tool drives a real browser with realistic mouse movements (bezier curves), typing patterns (random delays, occasional typos with corrections), and inertial scrolling — mimicking human behavior to bypass bot detection.

PRIMARY interaction paradigm: **visual loop** (screenshot → annotate → coordinate click).
- Take an annotated screenshot: \`{"operation": "screenshot", "annotate": true}\`
- Returns a **marks table** with numbered elements and their center coordinates
- Pass the screenshot filePath to \`vision_analyze\` to see the page
- Click using coordinates: \`{"operation": "click_at", "x": 512, "y": 300}\`

Computer-use operations (coordinate-driven, PREFERRED in this mode):
- **click_at** - Click at viewport coordinates (supports right click, double click)
- **mouse_move** - Move cursor without clicking (reveals hover UI)
- **drag** - Drag from one point to another (sliders, sortable lists)
- **key_combo** - Press key with modifiers (Ctrl+A/C/V, Shift+Tab, etc.)
- **scroll_to** - Scroll to a position or element
- **clipboard_read / clipboard_write** - Access clipboard
- **handle_dialog** - Answer native alert/confirm/prompt dialogs

Ref-based operations (fallback when coordinates aren't suitable):
- navigate, snapshot, click (by ref), type (by ref), scroll, hover, select, evaluate, screenshot, wait, tabs, file_upload, network, cookies, parallel_fetch

The visual loop is PREFERRED because:
1. It works on ANY element (canvas, SVG, shadow DOM, custom widgets)
2. Human-like mouse movements make it indistinguishable from a real user
3. The annotated screenshot gives you exact coordinates for every interactive element

Example workflow (visual loop):
1. \`{"operation": "navigate", "url": "https://example.com"}\` → Load page
2. \`{"operation": "screenshot", "annotate": true}\` → Get marked screenshot + marks table
3. Pass filePath to \`vision_analyze\` → See what's on screen
4. \`{"operation": "click_at", "x": 320, "y": 280}\` → Click the element
5. \`{"operation": "screenshot", "annotate": true}\` → Verify the result
`;

export const DEFAULT_TIMEOUT = 30000;
export const MAX_CONTENT_LENGTH = 500000;
export const SNAPSHOT_MAX_LENGTH = 100000;
