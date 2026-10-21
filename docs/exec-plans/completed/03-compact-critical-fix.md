# Compact Critical Fix — Implementation Plan

> **For agentic workers:** This plan fixes 6 critical issues in the compact system.
> Use `writing-plans` skill subagent flow or implement inline task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the compact system so LLM summarization actually works, boundary markers separate old/new content, post-compact reinjection restores file/skill state, micro-compact cleans stale tool results, and the frontend renders compact boundaries and summaries properly.

**Architecture:** The fix wires the existing LLM client into `CompactionManager.setSummarizer()`, fixes the legacy `compactHistory` to use structured messages, adds `isCompactBoundary`/`isCompactSummary` metadata to `Message`, enables post-compact reinjection in the Agent constructor, adds lightweight tool-result cleanup before each LLM call, and builds frontend components for compact boundary/summary rendering.

**Tech Stack:** TypeScript, React 19, Anthropic/OpenAI LLM clients (existing), CSS Modules / Tailwind (existing)

---

### Task 1: Wire LLM Summarizer Into CompactionManager (P0)

**Files:**
- Modify: `packages/agent/src/index.ts:329`

**Problem:** Agent constructor creates `CompactionManager` but never calls `setSummarizer()`, so all LLM-based summarization paths are dead code.

- [ ] **Step 1: Read the existing LLM client interface to understand its API**

The agent stores `this.llmClient` (an `LLMClientWrapper`) which has a `streamChat(messages, options)` method. We need a simpler non-streaming interface for compact summarization. Check if the client exposes a `chat` or `complete` method.

- [ ] **Step 2: Create the summarizer function**

In `packages/agent/src/index.ts`, after line 329 (`this.compactionManager = createCompactionManager();`), add a summarizer closure that uses `this.llmClient`. The summarizer must:

1. Accept `(text: string, prompt: string) => Promise<string>`
2. Call the LLM with the prompt as system + text as user message
3. Return the text response

```typescript
// In Agent constructor, after line 329:
this.compactionManager = createCompactionManager({
  enableReinjection: true,
});

// Wire up the LLM summarizer
this.compactionManager.setSummarizer(async (text: string, prompt: string): Promise<string> => {
  const messages: Message[] = [
    {
      role: 'user',
      content: text,
    },
  ];

  const result: string[] = [];
  const stream = this.llmClient.streamChat(messages, {
    systemPrompt: prompt,
    maxTokens: 4096,
    temperature: 0.3,
    signal: new AbortController().signal,
  });

  for await (const event of stream) {
    if (event.type === 'text') {
      result.push(event.data);
    }
    if (event.type === 'done' || event.type === 'error') {
      break;
    }
  }

  return result.join('').trim();
});
```

- [ ] **Step 3: Verify the fix by running typecheck**

```bash
npm run typecheck:all
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "feat(compact): wire LLM summarizer into CompactionManager"
```

---

### Task 2: Fix compactHistory to Use Structured Messages (P0)

**Files:**
- Modify: `packages/agent/src/compact/compact.ts:139-196`

**Problem:** `generateSummary()` flattens all messages into one text string `Please summarize the following conversation:\n\n${conversationText}`, losing message role structure and preventing prompt cache sharing.

- [ ] **Step 1: Replace the Anthropic direct API call with the agent's LLM infrastructure**

The `compactHistory` function is a standalone exported function that creates its own `Anthropic` client. We need to make it accept an LLM summarizer function instead, or use structured messages.

Since `compactHistory` is a legacy path and the main path is through `CompactionManager`, the minimal fix is to change `generateSummary` to accept a `summarizer` parameter:

```typescript
// Change signature:
async function generateSummary(
  // OLD: apiKey, baseURL, model, messages
  // NEW:
  summarize: (text: string, prompt: string) => Promise<string>,
  messages: Message[],
): Promise<string>
```

And remove the Anthropic SDK import + retry logic (the summarizer handles that).

```typescript
async function generateSummary(
  summarize: (text: string, prompt: string) => Promise<string>,
  messages: Message[],
): Promise<string> {
  const cleanedMessages = stripImagesFromMessages(messages);
  const conversationText = extractTextFromMessages(cleanedMessages);

  if (!conversationText.trim()) {
    return '[No meaningful content to summarize]';
  }

  const compactPrompt = getCompactPrompt();

  try {
    return await summarize(conversationText, compactPrompt);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `[Summary generation failed: ${errorMessage}]`;
  }
}
```

- [ ] **Step 2: Update compactHistory to accept a summarizer**

```typescript
export async function compactHistory(
  messages: Message[],
  options: {
    summarize: (text: string, prompt: string) => Promise<string>;
    maxMessagesToKeep?: number;
  },
): Promise<CompactResult> {
  const { summarize, maxMessagesToKeep = 20 } = options;
  // ... rest stays the same, but replace generateSummary call:
  const summary = await generateSummary(summarize, olderMessages);
  // ...
}
```

- [ ] **Step 3: Update context-compressor.ts bridge to pass summarizer**

In `src/lib/context-compressor.ts:102`, replace:
```typescript
const result = await compactHistory(
  messages as Parameters<typeof compactHistory>[0],
  { apiKey, model: model || '', maxMessagesToKeep: 20 }
);
```
with a summarizer function that calls the agent process via the existing SSE mechanism. Since `context-compressor.ts` is frontend-side, we should:

1. Check if this path is actually used. Looking at the agent-sse-client, compact is done via HTTP POST to `/sessions/:id/compact` which goes to the agent process.
2. The `checkAndCompress` path was the OLD mechanism; the NEW mechanism uses the agent process's `compact` handler.

**Decision:** Mark `context-compressor.ts` as deprecated (it uses the outdated `compactHistory`). The agent process's `compact` handler already uses `agent.compact()` which goes through `CompactionManager`.

Add a deprecation comment and remove the `compactHistory` import from `index.ts` if it's only used by context-compressor.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/compact/compact.ts src/lib/context-compressor.ts
git commit -m "refactor(compact): replace Anthropic SDK direct call with structured summarizer"
```

---

### Task 3: Add Compact Boundary Marker to Message Types (P1)

**Files:**
- Modify: `packages/agent/src/types.ts:54-77`
- Modify: `packages/agent/src/compact/types.ts:30-35`

**Goal:** Add metadata fields to `Message` so the frontend can identify compact boundaries and summaries.

- [ ] **Step 1: Add compact metadata to the Message interface**

In `packages/agent/src/types.ts`, add to the `Message` interface:

```typescript
export interface Message {
  // ... existing fields ...
  /** True if this message is a compact boundary marker */
  isCompactBoundary?: boolean;
  /** True if this message is a compact summary (generated by LLM) */
  isCompactSummary?: boolean;
  /** Number of messages that were compacted into this summary */
  compactedMessageCount?: number;
  /** ID of the compact boundary this summary belongs to */
  compactBoundaryId?: string;
}
```

- [ ] **Step 2: Update MicroCompactStrategy to produce boundary + summary**

In `packages/agent/src/compact/strategies/MicroCompactStrategy.ts`, modify `compact()` to create:

1. A **boundary marker** system message (optional, mainly for frontend rendering)
2. A **summary** system message with `isCompactSummary: true`

```typescript
// After generating summaryText, create boundary + summary:
const boundaryId = crypto.randomUUID();

// Create compact boundary marker (optional, for UI)
const boundaryMarker: Message = {
  role: 'system',
  content: `--- Conversation compacted at ${new Date().toISOString()} ---`,
  timestamp: Date.now(),
  isCompactBoundary: true,
  compactBoundaryId: boundaryId,
  compactedMessageCount: olderMessages.length,
};

const summaryMessage: Message = {
  role: 'system',
  content: getSummaryMessage(summaryText),
  timestamp: Date.now(),
  isCompactSummary: true,
  compactBoundaryId: boundaryId,
  compactedMessageCount: olderMessages.length,
};

const compressedMessages: Message[] = [
  ...systemMessages,
  boundaryMarker,
  summaryMessage,
  ...recentMessages,
];
```

- [ ] **Step 3: Update SessionMemoryCompactStrategy similarly**

Same pattern as MicroCompactStrategy — add `isCompactSummary: true` and `compactedMessageCount` to the summary message.

- [ ] **Step 4: Update SnipCompactStrategy similarly**

Even though Snip has no summary, it should still mark its boundary:

```typescript
const snipNotice: Message = {
  role: 'system',
  content: `[Earlier messages truncated — ${removedCount} messages removed to stay within context limits]`,
  timestamp: Date.now(),
  isCompactBoundary: true,
  compactedMessageCount: removedCount,
};
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/types.ts packages/agent/src/compact/
git commit -m "feat(compact): add boundary marker and summary metadata to messages"
```

---

### Task 4: Enable Post-Compact Reinjection (P1)

**Files:**
- Modify: `packages/agent/src/index.ts:329`

**Goal:** Enable `PostCompactReinjector` so file state and skill context are restored after compaction.

- [ ] **Step 1: Enable reinjection in CompactionManager config**

Already done in Task 1 where we added `enableReinjection: true`. Verify:

```typescript
this.compactionManager = createCompactionManager({
  enableReinjection: true,
});
```

- [ ] **Step 2: Wire skill context caching**

In the agent's `streamChat` method, after a skill is invoked (when `toolCallCountThisTurn` increments and the tool is `skill_manage`), cache the skill context:

```typescript
// In the tool execution loop, after skill_manage is used:
if (event.data.name === 'skill_manage') {
  // Cache skill context for post-compact reinjection
  this.compactionManager.cacheSkillContext([{
    name: event.data.input.name || 'unknown',
    description: event.data.input.description || '',
    invokedAt: Date.now(),
  }]);
}
```

This is lightweight — just adds a cache entry. The reinjector will use it during compact.

- [ ] **Step 3: Verify reinjection in compact flow**

The `CompactionManager.compact()` method already calls `this.reinjector.reinject(baseResult.messages, {...})` when `this.reinjector` exists and has cached files. Verify this code path works after Task 1.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "feat(compact): enable post-compact reinjection with file/skill state"
```

---

### Task 5: Add Lightweight Micro-Compact for Tool Result Cleanup (P1)

**Files:**
- Modify: `packages/agent/src/index.ts:695-725`
- Optionally Create: `packages/agent/src/compact/microCompactCleanup.ts`

**Goal:** Before each LLM call, clear old tool results from messages to save tokens without needing a full compact. This is the reference's `cachedMicrocompactPath` equivalent.

- [ ] **Step 1: Create microCleanupMessages function**

Add a function that processes messages to truncate old tool results (but NOT remove the tool_use/tool_result message pairs — just clear the result content for old pairs).

```typescript
// In packages/agent/src/compact/microCompactCleanup.ts (new file)

import type { Message } from '../types.js';

const COMPACTABLE_TOOLS = new Set([
  'Read', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write',
]);

const MAX_RECENT_TO_KEEP = 15; // Keep full results for last 15 messages

/**
 * Truncate old tool results to save tokens.
 * Does NOT remove messages — only clears result content for old tool_result blocks.
 */
export function microCleanupMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_RECENT_TO_KEEP) return messages;

  const cleaned = messages.map((msg, index) => {
    const isRecent = index >= messages.length - MAX_RECENT_TO_KEEP;
    if (isRecent || !Array.isArray(msg.content)) return msg;

    const hasCompactableToolResult = msg.content.some(
      (block: any) =>
        block.type === 'tool_result' &&
        block.tool_use?.name &&
        COMPACTABLE_TOOLS.has(block.tool_use.name)
    );

    if (!hasCompactableToolResult) return msg;

    // Clear the content of compactable tool results
    const newContent = msg.content.map((block: any) => {
      if (
        block.type === 'tool_result' &&
        block.tool_use?.name &&
        COMPACTABLE_TOOLS.has(block.tool_use.name)
      ) {
        return {
          ...block,
          content: `[tool_result truncated by micro-compact]`,
          is_error: false,
        };
      }
      return block;
    });

    return { ...msg, content: newContent };
  });

  return cleaned;
}
```

- [ ] **Step 2: Call microCleanup before each LLM call**

In `packages/agent/src/index.ts`, in the `streamChat` method, before the proactive compaction check (around line 711), add:

```typescript
// Lightweight tool result cleanup before each turn
// Saves tokens by truncating old tool results without full compaction
messages = microCleanupMessages(messages);
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/compact/microCompactCleanup.ts packages/agent/src/index.ts
git commit -m "feat(compact): add lightweight micro-cleanup for old tool results"
```

---

### Task 6: Frontend — Compact Boundary and Summary Rendering (P2)

**Files:**
- Create: `src/components/chat/CompactBoundary.tsx`
- Create: `src/components/chat/CompactSummary.tsx`
- Modify: `src/components/chat/MessageItem.tsx`
- Modify: `src/components/chat/MessageList.tsx`
- Modify: `src/components/chat/ChatView.tsx`

**Goal:** Render compact boundaries and summaries in the chat UI so users can see what happened during compaction.

- [ ] **Step 1: Create CompactBoundary component**

```typescript
// src/components/chat/CompactBoundary.tsx
import React from 'react';

interface CompactBoundaryProps {
  compactedMessageCount: number;
  timestamp?: number;
}

export function CompactBoundary({ compactedMessageCount, timestamp }: CompactBoundaryProps) {
  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : '';

  return (
    <div className="compact-boundary">
      <div className="compact-boundary-line" />
      <span className="compact-boundary-text">
        {compactedMessageCount} messages compacted
        {timeStr && ` at ${timeStr}`}
      </span>
      <div className="compact-boundary-line" />
    </div>
  );
}
```

With CSS:
```css
.compact-boundary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  opacity: 0.6;
}
.compact-boundary-line {
  flex: 1;
  height: 1px;
  background: var(--border-color);
}
.compact-boundary-text {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}
```

- [ ] **Step 2: Create CompactSummary component**

```typescript
// src/components/chat/CompactSummary.tsx
import React, { useState } from 'react';

interface CompactSummaryProps {
  content: string;
  compactedMessageCount: number;
}

export function CompactSummary({ content, compactedMessageCount }: CompactSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="compact-summary">
      <button
        className="compact-summary-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="compact-summary-icon">{expanded ? '▼' : '▶'}</span>
        Context compacted ({compactedMessageCount} messages summarized)
      </button>
      {expanded && (
        <div className="compact-summary-content">
          {content}
        </div>
      )}
    </div>
  );
}
```

With CSS:
```css
.compact-summary {
  margin: 8px 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}
.compact-summary-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-surface);
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-muted);
}
.compact-summary-toggle:hover {
  background: var(--bg-hover);
}
.compact-summary-icon {
  font-size: 10px;
  width: 14px;
  text-align: center;
}
.compact-summary-content {
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  border-top: 1px solid var(--border-color);
  max-height: 300px;
  overflow-y: auto;
}
```

- [ ] **Step 3: Modify MessageItem to check for compact flags**

In `src/components/chat/MessageItem.tsx`, before the main rendering, check `message.isCompactBoundary` and `message.isCompactSummary`:

```typescript
// At the top of the MessageItem rendering logic:
if (message.isCompactBoundary) {
  return (
    <CompactBoundary
      compactedMessageCount={message.compactedMessageCount || 0}
      timestamp={message.timestamp}
    />
  );
}

if (message.isCompactSummary) {
  const content = typeof message.content === 'string'
    ? message.content
    : '';
  return (
    <CompactSummary
      content={content}
      compactedMessageCount={message.compactedMessageCount || 0}
    />
  );
}
```

- [ ] **Step 4: Update ChatView compact handler to reload messages**

In `src/components/chat/ChatView.tsx:314-327`, the `handleCompact` callback shows "Context compressed successfully." After compact completes, it should reload messages from DB to pick up the new compact boundary and summary messages:

```typescript
const handleCompact = useCallback(() => {
  if (!sessionId) return;
  setIsCompacting(true);
  compactContext(sessionId, {
    onDone: (result) => {
      setIsCompacting(false);
      setCompressionNotification(
        `Context compressed: ${result.removedCount || 0} messages compacted.`
      );
      // Reload messages to show compact boundary and summary
      // The message list should re-fetch from the store/DB
      reloadMessages?.(); // if available, or dispatch a refetch event
    },
    onError: (error) => {
      setIsCompacting(false);
      setCompressionNotification(`Compression failed: ${error}`);
    },
  });
}, [sessionId, reloadMessages]);
```

If `reloadMessages` is not available, emit a custom event that `MessageList` listens to, or use the existing message refresh mechanism.

- [ ] **Step 5: Verify with Playwright MCP**

```bash
npm run dev
```

Then use Playwright to:
1. Open `http://localhost:3000`
2. Start a conversation
3. Trigger compact
4. Verify compact boundary and summary render correctly

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/CompactBoundary.tsx src/components/chat/CompactSummary.tsx src/components/chat/MessageItem.tsx src/components/chat/ChatView.tsx
git commit -m "feat(ui): add compact boundary and summary rendering"
```

---

### Task 7: Final Integration Test & Cleanup

**Files:**
- Modify: `docs/exec-plans/active/03-compact-critical-fix.md` (this plan)
- Modify: `docs/exec-plans/README.md`

- [x] **Step 1: Run full typecheck**

```bash
npm run typecheck:all
```

Expected: Zero errors.

- [ ] **Step 2: Run existing tests**

```bash
npm run test
```

Expected: All existing tests pass.

- [ ] **Step 3: Manual smoke test**

1. Start dev server: `npm run electron:dev`
2. Start a conversation with the agent
3. Send enough messages to trigger auto-compact (or use manual `/compact`)
4. Verify the LLM-generated summary appears in the chat
5. Verify the compact boundary marker renders
6. Verify file context is preserved after compact (if file reads happened)

- [ ] **Step 4: Mark plan complete**

Update this plan file's checkboxes, then move to `docs/exec-plans/completed/` and update `docs/exec-plans/README.md`.

- [ ] **Step 5: Final commit**

```bash
git add docs/exec-plans/
git commit -m "docs(plan): complete compact critical fix plan"
```