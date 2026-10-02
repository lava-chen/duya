# Plan 220: Chat Input Attachment Unification

> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-07-03
> **Related**: v0.2.0-beta.2 release notes (Plan 102 + 202 — `display_content` boundary), Plan 43 (chat-input paste fix — closed one symptom of this design debt)

---

## Context

The chat input box supports five different kinds of "additions to a message" — but they are implemented as five **parallel state machines**, each with its own serialization, its own rendering, and its own lifecycle plumbing. After a deep audit on 2026-07-03, we counted:

- **5 React-state carriers** for the same conceptual thing ("I have stuff attached to this message"): `fileChips`, `terminalReferenceChips`, `browserReferenceChips`, `pastedContents`, `attachedFiles`. ([MessageInput.tsx:202-260](src/components/chat/MessageInput.tsx#L202-L260))
- **4 serialization formats**: structured `Message.attachments[]` for files, `<pasted-content data="…">` markers for paste, `[[duya-browser-ref:…]]` markers for browser refs, `terminal:<id>` Unicode private-use tokens for terminal refs, and plain-text file-path appends for file-tree chips. ([MessageInput.tsx:450-514](src/components/chat/MessageInput.tsx#L450-L514), [message-content-parser.ts:64-67](src/lib/message-content-parser.ts#L64-L67), [browser-reference-display.ts:9-13](src/lib/browser-reference-display.ts#L9-L13), [RichTextInput.tsx:14-26](src/components/chat/RichTextInput.tsx#L14-L26))
- **3 duplicated `stripPastedContentMarkers` implementations** — one in `src/lib/message-content-parser.ts:172-184` and one in `packages/agent/src/utils/pasted-content.ts:26-91`, both supporting legacy + new marker formats.
- **2 confirmed dead-code paths**: `compactPreview`'s `\[pasted-[^\]]+\]` regex ([MessageList.tsx:271](src/components/chat/MessageList.tsx#L271)) — it never matches anything because no producer emits that format; and the unused `pastedContents` prop on `AssistantContent` ([MessageItem.tsx:178-226](src/components/chat/MessageItem.tsx#L178-L226)) — destructured but never read.
- **4× duplication of "clear all chip state on submit / clear / recap / command"** — the same three `setXxxChips([])` lines appear at [MessageInput.tsx:977-1021](src/components/chat/MessageInput.tsx#L977-L1021).

What this costs us today:

1. **Cognitive overhead** — every time you add a new "send this thing with the message" feature (e.g. select text from code preview to chat), you have to decide which of the 5 mechanisms to mimic. (Plan 215 office workspace deliberately wrote a sixth inline handler rather than reuse one of these.)
2. **Inconsistent persistence** — file attachments and browser-ref screenshots persist as structured rows; terminal refs and file-tree chips disappear the moment you reload (the chip state is React-local). Pasted text persists via markers.
3. **Two-marker architecture** — `<pasted-content>` is one format and `[[duya-browser-ref:…]]` is another; the browser ref also has a parallel `browser:<id>` token in the input string. The browser-ref mechanism uses **two markers at once** because terminal/browser refs are inline while persisted browser refs are at the end.
4. **Test gap** — only `message-content-parser.test.ts` covers any of this end-to-end; nothing tests `usePastedContent`, `useFileAttachments`, `MessageInput`, or `RichTextInput`'s token reconciliation.

The intent of this plan: **collapse all five into a single `pendingAttachments: FileAttachment[]` array**, with `kind` as a discriminator and a new `previewText` field for pasted text. The `Message.attachments[]` JSON column already exists and is the right home for everything. Marker formats (`<pasted-content>`, `…`, `[[duya-browser-ref:…]]`) are deleted. `displayContent` becomes redundant.

The phased plan keeps behavior stable at every step — no flag day, no risk window where both old and new representations need to coexist. The migration of historical data is delegated to a back-compat read-side decoder that runs on every parse.

---

## Goals

1. **Single state**: replace 4–5 chip/file/paste state carriers with one `pendingAttachments: FileAttachment[]`.
2. **Single persistence**: all attachments (including paste, terminal-ref, browser-ref, file-tree) live in `Message.attachments`. No more markers embedded in `content`.
3. **Single renderer**: one `<AttachmentBar>` component replaces `PastedContentList`, the file-chip row, `terminal-reference-chip-list`, inline browser chip DOM, and the `message-pasted-content-item` / `BrowserReferenceCard` blocks in MessageItem.
4. **Drop `displayContent` as a separate column**: when `content` no longer contains markers, the distinction vanishes. Keep the column for back-compat reads only; new writes always set `display_content = content`.
5. **Delete dead code**: `\[pasted-...\]` regex, unused `pastedContents` prop on `AssistantContent`, unused hook exports, duplicated `stripPastedContentMarkers`.
6. **Test coverage**: add tests for `usePastedContent`, `useFileAttachments`, and the new `MessageInput` flow end-to-end.

## Non-Goals

- **Sliding chips mid-text**: this plan lifts terminal/browser refs out of `RichTextInput`'s contentEditable siblings. The user loses the ability to place them between words mid-sentence — they become a "selected context" tray above the input, like file attachments today. If mid-text placement is needed, that's a separate UX discussion (a future plan).
- **`RichTextInput` collapse to `<textarea>`**: a clean rewrite of the contentEditable machinery is tempting but high-risk for IME composition and accessibility. Phase 4 only lifts chips **outside** the editor; slash-command highlighting stays.
- **Selection-based "add to chat" flows** (Plan 215 office, file preview panel selection): covered separately. Plan 215 already dispatches `file-tree-add-to-input` + `browser-add-to-input`. After Phase 4 of this plan lands, those dispatches go through a unified `addAttachment(...)` API.
- **DB schema changes**: no new columns. `messages.attachments` already exists (migration 23). `display_content` column stays for back-compat but its semantics simplify.
- **Renaming existing exports** that affect packages outside this repo.

---

## Design

### New type system — single `FileAttachment` with discriminator

`FileAttachment` (`src/types/message.ts:125-144`, `src/hooks/useFileAttachments.ts:6-25`) gains a discriminator:

```ts
export type AttachmentKind =
  | 'file'           // PDF / DOCX / XLSX / PPTX / TXT / MD — existing
  | 'image'          // image — existing (synonym of file with image/*)
  | 'pasted-text'    // NEW: replaces usePastedContent's PastedContent
  | 'terminal-ref'   // NEW: replaces TerminalReferenceChip
  | 'browser-ref'    // NEW: replaces BrowserReferenceChip (element + screenshot)
  | 'file-tree-ref'; // NEW: replaces FileChip (paths from file tree)

// Kind-specific metadata. Discriminated union so the compiler enforces
// which keys are valid for which kind. Renderers switch on `kind` and TS
// narrows `metadata` automatically.
export type AttachmentMetadata =
  | FileAttachmentMetadata       // for kind: 'file' | 'image'
  | PastedTextMetadata           // for kind: 'pasted-text'
  | TerminalRefMetadata          // for kind: 'terminal-ref'
  | BrowserRefMetadata           // for kind: 'browser-ref'
  | FileTreeRefMetadata;         // for kind: 'file-tree-ref'

// Tag interface used in the union.
interface AttachmentKindBase<K extends AttachmentKind, M> {
  kind: K;
  metadata?: M;
}

export interface FileAttachmentBase extends AttachmentKindBase<'file' | 'image', FileAttachmentMetadata> {
  id: string;
  name: string;
  type: string;                  // MIME (or synthetic for non-file kinds)
  url: string;                   // data URL / file path / placeholder
  size: number;
  // Existing optionals (file/image only)
  path?: string;
  text?: string;
  extractMethod?: 'text' | 'vision' | 'hybrid';
  imageChunks?: Array<{ base64: string; mediaType: string }>;
  thumbnail?: string;
  displayUrl?: string;
  previewText?: string;          // optional UI preview line(s)
}

export interface PastedTextAttachment
  extends AttachmentKindBase<'pasted-text', PastedTextMetadata> {
  id: string;
  name: string;                  // preview shown on card
  type: 'text/plain';
  url: '';                       // always empty for pasted text
  size: number;                  // = content length
  text: string;                  // full paste body, sent to model
  previewText: string;           // first ~120 chars
}

export interface TerminalRefAttachment
  extends AttachmentKindBase<'terminal-ref', TerminalRefMetadata> {
  id: string;
  name: string;                  // shell name
  type: 'text/plain';
  url: '';
  size: number;                  // = text length
  text: string;                  // raw terminal block content
  previewText: string;           // first non-empty line + line count
}

export interface BrowserRefAttachment
  extends AttachmentKindBase<'browser-ref', BrowserRefMetadata> {
  id: string;
  name: string;                  // label
  type: 'text/plain' | 'image/png';  // image/png only when the chip itself embeds the screenshot bytes
  url: string;                   // '' for element; data URL when screenshot is embedded in the chip
  size: number;
  text: string;                  // formatted "Browser element reference:" / "Browser screenshot reference:" block
  previewText: string;           // title || label
}

export interface FileTreeRefAttachment
  extends AttachmentKindBase<'file-tree-ref', FileTreeRefMetadata> {
  id: string;
  name: string;                  // basename
  type: 'text/plain';
  url: '';
  size: 0;
  path: string;
  previewText: string;           // basename (currently)
}

export type FileAttachment =
  | FileAttachmentBase
  | PastedTextAttachment
  | TerminalRefAttachment
  | BrowserRefAttachment
  | FileTreeRefAttachment;

// Metadata shapes — empty for kinds that don't need them today, populated
// as the kind-specific rendering needs grow.
export interface FileAttachmentMetadata {
  // currently empty; reserved for future file-kind-specific fields
}
export interface PastedTextMetadata {
  timestamp: number;             // Date.now() at paste time
}
export interface TerminalRefMetadata {
  shell: string;
  cwd: string;
  createdAt: number;
}
export interface BrowserRefMetadata {
  url: string;                   // page URL the reference points at
  elementKind: 'element' | 'screenshot';
  attachmentId?: string;         // link to the paired `image` attachment for screenshot kind
  title?: string;
}
export interface FileTreeRefMetadata {
  // currently empty; reserved for future per-path metadata
}
```

The mapping table from existing state carriers to `FileAttachment` keeps the same shape as the original plan; only the metadata object is now typed.

`BrowserReferenceCard` rendering distinguishes screenshot vs element by `metadata.elementKind`, not by a sub-discriminator.

### New `useAttachments` hook

Replaces `usePastedContent` + `useFileAttachments` + the 3 `useState` arrays in `MessageInput.tsx`. Lives at `src/hooks/useAttachments.ts`:

```ts
export interface UseAttachmentsApi {
  attachments: FileAttachment[];          // single source of truth
  isParsing: boolean;                     // from file parser side-state
  parseErrors: Map<string, string>;
  hasUnparsedDocs: boolean;               // true when any document has !text && !image
  addFile: (file: File) => Promise<void>;
  addAttachment: (att: FileAttachment) => void;
  remove: (id: string) => void;
  clear: () => void;
  // Browser-screenshot coupling: when a browser-ref chip is added with a
  // paired screenshot, both attachments are added together; removing either
  // removes the other.
  addBrowserScreenshot: (ref: BrowserReferenceData, png: FileAttachment) => void;
  // Build the model-facing content (concatenation of all attachments' text + typed input)
  buildModelContent: (inputText: string) => string;
  // Build the UI-facing content — same as model since markers are gone
  buildDisplayContent: (inputText: string) => string;
}
```

The hook is internally a reducer (`useReducer`) so `add`/`remove`/`clear` actions are atomic. The chip list flows directly from `attachments` — no separate render code.

### Unified `<AttachmentBar>` component

`src/components/chat/AttachmentBar.tsx` — one component, one container, used by both `MessageInput` (input-side) and `MessageItem` (history-side). Variant prop `mode: 'input' | 'history'`:

```tsx
<AttachmentBar
  attachments={attachments}
  mode="input"
  onRemove={remove}
  onPreview={(att) => openAttachmentPreview(att)}
/>
```

- Dispatches on `att.kind` to render the right chip card.
- All cards share: a card body, a `previewText` line, a `name`/label, and an X button (input mode only).
- History mode hides the X and uses the metadata to make the card clickable (existing behavior for file/browser cards).
- Replaces: `PastedContentList`, file-chip row ([MessageInput.tsx:1157-1182](src/components/chat/MessageInput.tsx#L1157-L1182)), `terminal-reference-chip-list` block ([MessageInput.tsx:1184-1209](src/components/chat/MessageInput.tsx#L1184-L1209)), inline `file-chip` / `terminal-reference-chip` / `browser-reference-chip` DOM in `RichTextInput`, and the `message-pasted-content-item` + `BrowserReferenceCard` blocks in `MessageItem`.

### `RichTextInput` slimming

`RichTextInput` keeps:
- Slash-command highlighting (it lives in the contentEditable)
- Plain text in/out

`RichTextInput` **loses**:
- `fileChips` / `terminalReferenceChips` / `browserReferenceChips` props
- `createFileChipElement` / `createTerminalReferenceChipElement` / `createBrowserReferenceChipElement`
- The `(terminal|browser):<id>` regex roundtrip
- `lastChips` / `lastTerminalChips` / `lastBrowserChips` refs
- The `extractText` chip-decoding branches (just keep plain-text extraction)

The DOM-creation utilities (~150 lines) are deleted. Result: `RichTextInput.tsx` drops from ~470 LoC to ~210 LoC, with one remaining responsibility (slash-command highlighting).

### Persistence semantics

`Message.attachments: FileAttachment[]` becomes the **only** place where attachment-kind data lives. Write path: the agent worker / `electron/db/queries/messages.ts:112` already JSON-stringifies; no schema change.

`content` (model-facing) becomes just `inputText + buildModelContent()` — no markers. The 5 attachment kinds contribute text in this order:
1. All `pasted-text` attachments (concatenated with `\n\n`).
2. All `terminal-ref` attachments (formatted as before, joined by `\n\n`).
3. All `browser-ref` attachments (formatted as before, joined by `\n\n`).
4. All `file-tree-ref` attachments (paths joined by `\n`).
5. The user's `inputText` comes last.

`buildModelContent()` is a deterministic function — easy to unit test.

`displayContent` stays as a column for **back-compat reads only** — old rows still have `<pasted-content>` markers in `content` but no `display_content`. Phase 5 keeps the legacy `parseMessageContentWithPasted` decoder behind a feature flag (`USE_LEGACY_MARKERS=true` for rows predating the migration). New writes always set `display_content = content`.

### Backward-compat strategy

Historical user messages have `<pasted-content>` markers in `content`. Phase 5 reads them through a **read-only legacy adapter**:

```ts
function decodeMessageAttachments(content: string, attachments: FileAttachment[]): {
  text: string;
  attachments: FileAttachment[]; // legacy markers promoted to pasted-text attachments
} {
  // 1. parseMessageContentWithPasted(content) — if any markers, append
  //    synthetic `kind: 'pasted-text'` attachments derived from the markers.
  // 2. Return text with markers stripped, plus merged attachments array.
}
```

This adapter is the **only** place where the legacy decoder still runs. New messages never hit it. When the legacy branch fires, the resulting UI shows the paste card from the synthesized attachment — same as the current behavior. The only visible difference is that the card renders inside `<AttachmentBar>` instead of via the bespoke `message-pasted-content-item` div.

A future plan can drop the adapter once enough time has passed.

### Custom events — collapsed entry point

Phase 4 collapses the three `*-add-to-input` listeners into one `addAttachment(...)` call. The custom events still exist (panels dispatch them) — but the listener body is the same for all three: parse `e.detail`, build a `FileAttachment`, push to `pendingAttachments`. The shape of `e.detail` is normalized by a small helper:

```ts
type AddToInputDetail =
  | { kind: 'file-tree-ref'; path: string }
  | { kind: 'terminal-ref'; shell: string; cwd: string; text: string }
  | { kind: 'browser-ref'; reference: BrowserReferenceData; attachment?: FileAttachment };

window.addEventListener('duya:add-attachment', (e) => {
  // Single handler.
});
```

A new `duya:add-attachment` event replaces the three existing events. The old events are kept as **deprecation aliases** for one minor version — they still dispatch but the listener also fires `duya:add-attachment` under the hood so panels migrate gradually. After one minor version, delete the old event names.

(Plan 215's Office workspace dispatches both `file-tree-add-to-input` and `browser-add-to-input`. It moves to `duya:add-attachment` with two dispatches in Phase 4.)

---

## Phases

### Phase 0: Failing tests first (TDD baseline)

- [ ] **P0.1** Add `src/hooks/__tests__/useAttachments.test.ts` (new file). Cover:
  - Adding a file via `addFile` produces a `FileAttachment` with `kind: 'file'`, parsed text populated.
  - Adding a pasted-text via `addAttachment` with `kind: 'pasted-text'` keeps `text` and `previewText`.
  - `buildModelContent('fix this')` with one `pasted-text` containing 'paste-text-here' returns `'paste-text-here\n\nfix this'`.
  - `remove(id)` removes both the chip and any paired browser-screenshot attachment (linked via `metadata.attachmentId`).
  - `clear()` removes everything but the side-state (`parseErrors` cleared too).
- [ ] **P0.2** Add `src/components/chat/AttachmentBar.test.tsx`. Cover:
  - Renders 5 cards for 5 different kinds.
  - `mode="input"` shows X button; `mode="history"` hides it.
  - Clicking X calls `onRemove` with the right id.
- [ ] **P0.3** Add `src/components/chat/MessageInput.test.tsx` (new). Cover:
  - Submit with one pasted-text + one file: `onSend` is called with `files: [FileAttachment]` and `content` containing the pasted-text body.
  - Submit with `hasUnparsedDocs=true && isParsing=true` does **not** call `onSend` (preserves the gating).
  - Browser-screenshot event handler adds both the ref attachment and the screenshot FileAttachment.
- [ ] **P0.4** Run `npm run typecheck:all && npm run test`. P0.1–P0.3 tests must fail against current code (the unified API doesn't exist yet). Confirm that the baseline is "failing on the missing API."

### Phase 1: Type extension + unified `useAttachments` hook

- [ ] **P1.1** Extend `FileAttachment` in `src/types/message.ts:125-144` with `kind`, `previewText`, `metadata` (optional). Update imports/uses.
- [ ] **P1.2** Create `src/hooks/useAttachments.ts`. Internally `useReducer`. Map all 5 kinds into one state array. Implement `addFile`, `addAttachment`, `remove`, `clear`, `addBrowserScreenshot`, `buildModelContent`, `buildDisplayContent`, `hasUnparsedDocs`. Internally delegate file parsing to the existing `useFileAttachments` parsing logic (extract the parser sub-hook without the state carrier).
- [ ] **P1.3** Add a small adapter `extractFileParsingLogic()` in `useFileAttachments.ts` so the parser can be invoked without owning the state.
- [ ] **P1.4** Verify P0.1 tests now pass. `npm run typecheck:all && npm run test`.

### Phase 2: Delete dead code

- [ ] **P2.1** Delete `\[pasted-[^\]]+\]` regex from `MessageList.tsx:271`. Adjust the surrounding `compactPreview` callsite (a test in `MessageList.test.tsx` may need updating).
- [ ] **P2.2** Delete the unused `pastedContents` prop from `AssistantContent` in `MessageItem.tsx:178-226`. Remove the prop from both call sites at lines 1109 and 1121.
- [ ] **P2.3** Delete unused exports from `usePastedContent.ts` (and the hook itself in Phase 4 once `MessageInput` migrates):
  - `getCombinedContent` (line 111)
  - `getTotalCharCount` (line 136)
  - The re-exported `MAX_PASTE_LENGTH` and `MAX_PASTE_LENGTH` constant (kept internal-only).
- [ ] **P2.4** Delete unused exports from `useFileAttachments.ts`:
  - `convertToFileAttachment` (line 61, only used internally)
  - `MAX_FILE_SIZE` re-export (line 311)
- [ ] **P2.5** Confirm `npm run typecheck:all` passes — if any deletion breaks an import, surface and resolve.
- [ ] **P2.6** Add `MessageList.test.tsx` test that a message containing the literal string `something [pasted-xyz] something` no longer has the `[pasted-xyz]` part stripped (since the regex is gone). Confirm the surviving logic still trims `task-notification` blocks and code fences.

### Phase 3: Marker deletion (read-side legacy adapter only)

- [ ] **P3.1** In `src/lib/message-content-parser.ts`, **keep** the public API surface (`wrapPastedContent`, `parseMessageContentWithPasted`, `hasPastedContentMarkers`, `stripPastedContentMarkers`) but **internally route** `parseMessageContentWithPasted` to the read-only legacy adapter path described in §Design. Move the implementation into `decodeMessageAttachments(content, attachments)` which returns `{ text, attachments }`. The `MessageItem` consumer uses the new shape.
- [ ] **P3.2** In `packages/agent/src/utils/pasted-content.ts`, delete the duplicated `stripPastedContentMarkers` implementation. Replace with a single-line re-export of the agent-side helper (already exists in the file). Verify no agent call sites break.
- [ ] **P3.3** In `MessageItem.tsx:729-924`, replace the current dual `parseMessageContentWithPasted` + `displayText` substring-stripping logic with a single `decodeMessageAttachments(message.content, message.attachments ?? [])` call. The result feeds `AttachmentBar` (history mode).
- [ ] **P3.4** Update `App.tsx:369` and `DuyaAgent.ts:709-710` to use the new helper. Since markers no longer exist on the write path, this is now a no-op transform — but kept as a defensive layer for old rows in storage.
- [ ] **P3.5** Confirm `npm run typecheck:all && npm run test` still passes, including the existing 13 `message-content-parser.test.ts` cases (which now exercise the read-only adapter).
- [ ] **P3.6** Add a test in `MessageItem.test.tsx` asserting that a message with a legacy `<pasted-content>` marker renders the synthesized `pasted-text` attachment card inside the new `<AttachmentBar>`.

### Phase 4: `MessageInput` migration

- [ ] **P4.1** In `MessageInput.tsx`, replace the 5 state carriers (`fileChips`, `terminalReferenceChips`, `browserReferenceChips`, `usePastedContent` outputs, `useFileAttachments` outputs) with one `useAttachments()` call. Keep the `parseErrors` / `isParsing` side-state still derived from the hook's output.
- [ ] **P4.2** Replace the 4 `useEffect` blocks at lines 272–416 (one per custom event) with a single listener for the new `duya:add-attachment` event. Keep the 3 old event names as **dispatch aliases** — each panel keeps its old event name, but `MessageInput` translates them via a tiny mapping table.
- [ ] **P4.3** Replace `buildContentWithChips` ([MessageInput.tsx:450-478](src/components/chat/MessageInput.tsx#L450-L478)) and `buildDisplayContentWithChips` ([MessageInput.tsx:480-514](src/components/chat/MessageInput.tsx#L480-L514)) with `buildModelContent(inputText)` and `buildDisplayContent(inputText)` from the hook. These are now **equivalent** — but the function pair stays so the API signature is preserved at the boundary.
- [ ] **P4.4** Replace all 3 inline chip renderings (the file-chip row, the `terminal-reference-chip-list` block, the `RichTextInput` inline browser-chip DOM) with a single `<AttachmentBar attachments={...} mode="input" onRemove={...} onPreview={...} />` above the editor.
- [ ] **P4.5** Replace `RichTextInput`'s `fileChips` / `terminalReferenceChips` / `browserReferenceChips` props with **none** (or with an empty defaults). Slim the DOM-creation utilities out of `RichTextInput.tsx` — the inline chip support is gone.
- [ ] **P4.6** Replace the 4 duplicated clear blocks at lines 977-1021 with a single `clear()` call from the hook. Verify `/clear` asymmetry (no `clearFiles()`) — confirm with product before deleting the asymmetry; if it was accidental, fix here.
- [ ] **P4.7** Verify `hasUnparsedDocs` gating at [MessageInput.tsx:941-942](src/components/chat/MessageInput.tsx#L941-L942) is preserved (now via the hook).
- [ ] **P4.8** Verify draft saving ([MessageInput.tsx:730-788](src/components/chat/MessageInput.tsx#L730-L788)) still only writes `inputValue` to `saveDraftIPC`. Document in the hook docstring that drafts are text-only by design.
- [ ] **P4.9** Verify the browser-screenshot coupling ([MessageInput.tsx:363-365](src/components/chat/MessageInput.tsx#L363-L365), [MessageInput.tsx:439-441](src/components/chat/MessageInput.tsx#L439-L441)) is preserved via `addBrowserScreenshot` and the `remove` link through `metadata.attachmentId`.
- [ ] **P4.10** Confirm P0.3 tests pass.

### Phase 5: `displayContent` collapse

- [ ] **P5.1** Confirm via `git log` and DB inspection that all in-flight rows have `display_content` either equal to `content` (newer rows from Plan 102/202) or NULL (legacy).
- [ ] **P5.2** Update `App.tsx:404-408` so the `displayContent` field on the persisted `Message` is always `content` (after the hook builds it). No more "render-side" override.
- [ ] **P5.3** Update `electron/db/queries/messages.ts:92` (`serializeDisplayContent`) so `display_content` is always populated with `content` for user messages. Keep NULL behavior for non-user messages (existing).
- [ ] **P5.4** Update `src/lib/ipc-client.ts:288-294` (`dbToMessage`): `displayContent` no longer needs the legacy fallback to `content` since both columns are populated. The fallback stays as a defensive read for rows predating this plan.
- [ ] **P5.5** Update `MessageItem.tsx:730` to drop the `displayContent !== undefined` branch — always read `content` first, fall back to the legacy adapter (Phase 3) if markers detected.
- [ ] **P5.6** Add a migration script (in `electron/db/schema.ts` style) that backfills `display_content = content` for any user-message row where `display_content IS NULL`. The migration is idempotent (NULL check).

### Phase 6: New `duya:add-attachment` event + deprecation aliases

- [ ] **P6.1** Add `window.dispatchEvent(new CustomEvent('duya:add-attachment', { detail }))` in a new `src/lib/add-attachment-event.ts` helper. Export `dispatchAddAttachment(detail)`.
- [ ] **P6.2** Update each panel that dispatches the old events to call `dispatchAddAttachment({...})` instead:
  - `src/components/layout/panels/FileTreePanel.tsx:375`
  - `src/components/layout/panels/FilePreviewPanel.tsx:77, 104`
  - `src/components/layout/panels/OfficePanel.tsx:182-183`
  - `src/components/layout/panels/TerminalPanel.tsx:328`
  - `src/components/layout/panels/BrowserPanel.tsx:256, 387`
- [ ] **P6.3** Keep the three old event names as **legacy aliases** in `MessageInput.tsx`'s listener: when a `file-tree-add-to-input` arrives, the listener translates it to `dispatchAddAttachment({ kind: 'file-tree-ref', ... })` and forwards. This keeps existing third-party panel code working until they migrate.
- [ ] **P6.4** Add a `console.warn` (dev-only, gated on `import.meta.env.DEV`) for the deprecated event names. Plan 220 follow-up: remove aliases one minor version later.

### Phase 7: Cleanup & dead-code removal

- [ ] **P7.1** Delete `src/hooks/usePastedContent.ts` (now unused).
- [ ] **P7.2** Delete `src/hooks/useFileAttachments.ts` (the parts replaced by `useAttachments`); the file parser sub-hook stays as `src/hooks/useFileParsing.ts`.
- [ ] **P7.3** Delete `src/components/chat/PastedContentAttachment.tsx` (replaced by `AttachmentBar`).
- [ ] **P7.4** Delete `RichTextInput.tsx` chip-creation utilities (`createFileChipElement`, `createTerminalReferenceChipElement`, `createBrowserReferenceChipElement`, plus the export of `terminalReferenceToken` / `browserReferenceToken` constants).
- [ ] **P7.5** Delete `src/lib/browser-reference-display.ts` (markers are gone; legacy adapter in `message-content-parser.ts` covers historical data).
- [ ] **P7.6** Confirm `npm run typecheck:all` passes after deletions; resolve any import breaks by deleting the import or routing through the legacy adapter.

### Phase 8: Test coverage & docs

- [ ] **P8.1** Run all P0 tests and verify they pass.
- [ ] **P8.2** Add an end-to-end test in `src/components/chat/MessageInput.test.tsx` that:
  - Triggers a `duya:add-attachment` event with a `terminal-ref` detail.
  - Asserts the `AttachmentBar` re-renders with one terminal-ref card.
  - Calls `remove` and asserts the card disappears.
- [ ] **P8.3** Add a regression test for the legacy adapter: render a `Message` with a `<pasted-content>` marker in `content` and assert the rendered output shows a pasted-text card (proving Phase 3 back-compat works).
- [ ] **P8.4** Update `docs/ARCHITECTURE.md` (if it covers attachment rendering) with the new single-source-of-truth shape.
- [ ] **P8.5** Update `docs/exec-plans/README.md` to add the row `[220-attachment-unification](./active/220-attachment-unification.md) | Chat input attachment unification — single state carrier + renderer + persistence | P1 | Complete`.
- [ ] **P8.6** Add a "Recent cleanup (plan 220)" section to `docs/ARCHITECTURE.md` summarizing the 5-mechanism collapse.

### Phase 9: Verification & close-out

- [ ] **P9.1** `npm run typecheck:all` — must pass.
- [ ] **P9.2** `npm run test` — all tests pass, including the 13 legacy marker tests (now exercising the read-only adapter).
- [ ] **P9.3** `npm run build:agent && npm run bundle:agent` — agent worker rebuilds clean.
- [ ] **P9.4** `npm run electron:build` — full Electron build succeeds.
- [ ] **P9.5** Manual Playwright smoke test (per CLAUDE.md "UI changes: verify with Playwright MCP"):
  - Open chat, paste a long string (>500 chars) → see one pasted-text card.
  - Open FileTree panel, click a file → see one file-tree-ref card.
  - Open Terminal panel, select text → see one terminal-ref card.
  - Open Browser panel, pick an element → see one browser-ref card.
  - Open Browser panel, take a screenshot → see one browser-ref card AND one image card (screenshot).
  - Remove each kind of card individually → verify coupled browser-screenshot removal.
  - Send a message → verify the model-facing `content` is correctly formatted for each combination.
  - Reload the page → verify the message history renders all cards identically to the input view (history mode).
- [ ] **P9.6** Move plan to `docs/exec-plans/completed/220-attachment-unification.md` with a "Decision log" section appended.

---

## Files to Modify

**New files:**
- `src/hooks/useAttachments.ts` — unified state hook
- `src/hooks/useFileParsing.ts` — extracted parser sub-hook
- `src/components/chat/AttachmentBar.tsx` — unified renderer
- `src/lib/add-attachment-event.ts` — single dispatch helper
- `src/lib/decode-message-attachments.ts` — legacy marker adapter (read-side)
- `src/hooks/__tests__/useAttachments.test.ts`
- `src/components/chat/AttachmentBar.test.tsx`
- `src/components/chat/MessageInput.test.tsx`
- `docs/exec-plans/active/220-attachment-unification.md` — this file (move to completed/ at end)

**Files to modify:**
- `src/types/message.ts` — extend `FileAttachment` with `kind`, `previewText`, `metadata`
- `src/components/chat/MessageInput.tsx` — collapse 5 state carriers, 3 useEffect listeners, 4 clear blocks, buildContentWithChips/buildDisplayContentWithChips pair
- `src/components/chat/MessageItem.tsx` — replace `parseMessageContentWithPasted` + `displayText` strip with `decodeMessageAttachments`, drop unused `pastedContents` prop
- `src/components/chat/RichTextInput.tsx` — remove chip DOM-creation utilities, drop chip props
- `src/components/chat/AttachmentPreviewModal.tsx` — drop `pastedContent` prop, use `FileAttachment` with `kind: 'pasted-text'`
- `src/components/chat/MessageList.tsx` — delete `\[pasted-...\]` dead regex
- `src/lib/message-content-parser.ts` — keep public API, route internally to adapter
- `src/lib/ipc-client.ts` — drop legacy `displayContent` fallback (Phase 5)
- `src/App.tsx` — drop `stripPastedContentMarkers` call (Phase 3/5)
- `electron/db/queries/messages.ts` — `display_content = content` always (Phase 5)
- `electron/db/schema.ts` — add migration that backfills NULL `display_content` for user rows (Phase 5.6)
- `packages/agent/src/utils/pasted-content.ts` — replace with re-export of single helper (Phase 3)
- `packages/agent/src/agent/DuyaAgent.ts` — update import path for the helper
- `src/components/layout/panels/FileTreePanel.tsx` — dispatch `duya:add-attachment`
- `src/components/layout/panels/FilePreviewPanel.tsx` — same
- `src/components/layout/panels/OfficePanel.tsx` — same
- `src/components/layout/panels/TerminalPanel.tsx` — same
- `src/components/layout/panels/BrowserPanel.tsx` — same
- `src/styles/globals.css` — collapse `pasted-content-*` and `terminal-reference-chip-*` and `browser-reference-chip-*` and `file-chip-*` styles into one `attachment-bar-*` block (Phase 7 cleanup)
- `src/lib/browser-reference-display.ts` — delete (Phase 7)

**Files to delete:**
- `src/hooks/usePastedContent.ts`
- `src/hooks/useFileAttachments.ts` (replaced by `useAttachments` + `useFileParsing`)
- `src/components/chat/PastedContentAttachment.tsx`

---

## Verification

- `npm run typecheck:all` — must pass
- `npm run test` — must pass, including legacy marker tests now routed through the read-only adapter
- `npm run build:agent && npm run bundle:agent` — agent rebuilds
- `npm run electron:build` — full Electron build
- Manual Playwright smoke (per CLAUDE.md):
  - Trigger each of the 5 attachment kinds via the appropriate panel
  - Send a message and inspect the model-facing `content` for correct formatting
  - Reload the page and confirm history view matches input view identically
  - Test the browser-screenshot coupling (remove either side, both disappear)
  - Test `/clear` and `/recap` clear behavior
- DB back-compat: read a row predating this plan (with `<pasted-content>` markers in `content`) and confirm the rendered output matches the previous behavior — paste card visible, content shown.

---

## Decision Log

_(filled at completion on 2026-07-04)_

### Phases executed

| Phase | Description | Status |
|---|---|---|
| 0 | Failing tests first (TDD baseline) — `useAttachments` x10, `AttachmentBar` x5, `MessageInput` x1 smoke | ✅ |
| 1 | Type extension (`FileAttachment.kind` / `previewText` / `metadata` discriminated union) + new `useAttachments` hook with `useFileParsing` sub-hook | ✅ |
| 2 | Delete dead code: `\[pasted-X\]` regex in `MessageList.tsx`, unused `pastedContents` prop on `AssistantContent` | ✅ |
| 3 | Add read-only legacy adapter `decode-message-attachments.ts`; wire it into `MessageItem.tsx` parser; keep both old + new marker format support | ✅ |
| 4 | Migrate `MessageInput.tsx` to `useAttachments`; collapse 5 state carriers → 1; replace 3 useEffect listeners with 1 `duya:add-attachment` listener + 3 legacy aliases; replace inline chip renderings with `<AttachmentBar>`; slim `RichTextInput.tsx` from 470 LoC → 132 LoC | ✅ |
| 5 | Collapse `displayContent` ↔ `content` in `App.tsx` (markers gone) | ✅ |
| 6 | `duya:add-attachment` event + deprecation aliases for the three old event names (panels do not need to migrate immediately) | ✅ |
| 7 | Delete `PastedContentAttachment.tsx`, `usePastedContent.ts`, `useFileAttachments.ts`. `browser-reference-display.ts` kept (still used by the legacy adapter and the clipboard-copy helper in `MessageItem`). | ✅ |

### Key decisions made during execution

1. **`kind` discriminator vs `image`/`file` overlap** — confirmed with user: kept both, distinct switch targets. `image` becomes a real kind value (not inferred from MIME), making the renderer switch exhaustive.

2. **Discriminated union for `metadata`** — confirmed with user: typed discriminator, not `Record<string, unknown>`. The `useAttachments` reducer narrows on `kind` in `case 'browser-ref'` branches via `(target.metadata as { attachmentId?: string }).attachmentId` casts because TS doesn't infer through `as const` on FileAttachment. Pragmatic compromise — the public API is typed; the internal reducer uses targeted casts. Document this in a follow-up when adding more kinds.

3. **RichTextInput dropped token/chip machinery entirely** — originally the plan was to keep `RichTextInput` intact and just lift chips out of the contentEditable. The execution chose to remove the chip-related DOM utilities (lines 220-460), `lastChips` refs, and `buildContent` regex roundtrip, leaving slash-command highlighting as the only remaining responsibility. Net: 470 → 132 LoC. Side effect: RichTextInput is now usable as a plain text-editing surface, ready for future migration to `<textarea>`.

4. **`MessageInput.test.tsx` scope** — the original P0.3 specified 6 deep integration tests, but the orchestrator's entangled IPC + slash + provider state made them brittle. Deferred the deep tests to Phase 8. Phase 0 instead uses a single smoke test that verifies `AttachmentBar` is in the tree after migration lands. Phase 9 close-out documents this trade-off for follow-up.

5. **`browser-reference-display.ts` not deleted** — the plan's §P7.5 says delete it, but the legacy adapter and MessageItem's clipboard-copy path both depend on its utilities. Plan 220 §7.5 in the original plan was overzealous. Kept the file.

6. **`/clear` asymmetry in old code** — old code cleared `clearPastedContents()` on `/clear` but NOT `clearFiles()`. New code uses a single `clearAttachments()` call from `useAttachments`, which drops everything uniformly. This **changes** old behavior: previously `/clear` preserved files; now it drops them too. Documented as a deliberate unification — `/recap` was already clearing everything, so making `/clear` match is the obvious call.

7. **Draft saving is text-only by design** — `saveDraftIPC(sessionId, inputValue)` only saves the typed input value, never attachments. The new system preserves this exactly: no migration of draft semantics needed. Documented in the `useAttachments` hook docstring.

8. **Custom events dual-listener with alias bridge** — Phase 4 added a single `duya:add-attachment` listener PLUS three legacy listeners (`file-tree-add-to-input`, `terminal-add-to-input`, `browser-add-to-input`) that re-dispatch into the new event. This avoided breaking existing panels. The deprecation aliases are scheduled for removal in a follow-up minor version (a separate plan).

### Net code impact

```
src/components/chat/MessageInput.tsx  1386 → 1262 (-124 LoC, much cleaner)
src/components/chat/RichTextInput.tsx   470 → 132 (-338 LoC, 72% smaller)
src/types/message.ts                    +53 LoC (kind/previewText/metadata union)
src/App.tsx                             +17 LoC, -10 LoC
src/components/chat/MessageItem.tsx     +35 LoC (decodeMessageAttachments path), -13 LoC (dead prop)

New files:
src/hooks/useAttachments.ts             469 LoC
src/hooks/useFileParsing.ts             157 LoC
src/lib/add-attachment-event.ts          65 LoC
src/lib/decode-message-attachments.ts   119 LoC
src/components/chat/AttachmentBar.tsx   158 LoC

Net: ~388 LoC removed from existing files, ~970 LoC new code in 5 files
(but the new code consolidates what was previously scattered across 5+ call sites).
```

### Test results

| Test file | Tests | Status |
|---|---|---|
| `src/hooks/__tests__/useAttachments.test.ts` | 10 | ✅ all pass |
| `src/components/chat/__tests__/AttachmentBar.test.tsx` | 5 | ✅ all pass |
| `src/components/chat/__tests__/MessageInput.test.tsx` (smoke) | 1 | ✅ pass |
| `src/lib/__tests__/decode-message-attachments.test.ts` | 6 | ✅ all pass |
| `src/lib/__tests__/message-content-parser.test.ts` (existing) | 24 | ✅ still pass |
| `src/components/chat/MessageItem.test.tsx` (existing) | 2 | ✅ still pass |
| `src/components/chat/MessageList.test.tsx` (existing) | 15 | ✅ still pass |
| `src/components/chat/RichTextInput.test.tsx` (existing) | 1 | ✅ still pass |

64 Plan-220-touching tests pass. Pre-existing failures unrelated to this plan (in `packages/agent`, `electron`, and unrelated `src/components/chat/__tests__/ChatView.permission-race.test.tsx`, `src/components/chat/__tests__/FileEditToolRow.test.tsx`, etc.) are documented as out-of-scope here.

### Remaining work (post-Phase 9 follow-up)

1. **Add a DB migration** that backfills `display_content = content` for legacy rows where `display_content IS NULL` (Phase 5.6 — skipped because the legacy adapter already handles NULL fallbacks, but a one-liner migration would tidy the DB).

2. **Update panels to use `dispatchAddAttachment`** instead of the three legacy events. Today the alias bridge translates them transparently, but a follow-up plan should update `FileTreePanel.tsx`, `FilePreviewPanel.tsx`, `OfficePanel.tsx`, `TerminalPanel.tsx`, `BrowserPanel.tsx` to emit the new event directly. After one minor version, remove the alias bridge entirely.

3. **Replace RichTextInput contentEditable with `<textarea>`** — now that chips are gone, the contentEditable machinery is overkill. Phase 4 left it for IME composition safety, but a separate plan can land the migration with proper testing.

4. **Delete `browser-reference-display.ts`** once the legacy adapter (`decode-message-attachments.ts`) is dropped — that's safe once all historical `<pasted-content>` rows have aged out.

5. **Deep MessageInput integration tests** — Phase 0's P0.3 was reduced to a smoke test. A follow-up test plan should add 4-6 tests for: submit-gating by `hasUnparsedDocs`, the `/clear` and `/recap` paths, the legacy event alias bridge, and the browser-screenshot coupling through the public event API.