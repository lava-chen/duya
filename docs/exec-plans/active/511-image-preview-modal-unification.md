# Plan 511: Image Preview Modal Unification

> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-09-10
> **Related**: Plan 510 (Modal/Dialog Style Unification — leaves image previews out of scope; this plan picks them up)
> **Reference implementations**: [ImagePreviewModal.tsx](src/components/chat/ImagePreviewModal.tsx), [AttachmentPreviewModal.tsx](src/components/chat/AttachmentPreviewModal.tsx), [ToolImagePreviewModal.tsx](src/components/chat/tools/ToolImagePreviewModal.tsx), [preview.css](src/styles/preview.css), [mailbox.css](src/styles/mailbox.css) (lines 1-95), [skills.css](src/styles/skills.css) (lines 465-565)

---

## Context

duya has three read-only image preview modals, each implemented independently with divergent chrome (close button, overlay blur, backdrop alpha, animation) and divergent internal layout. They show up in user-facing places the user touches daily:

| Where it appears | Component | Visual |
|---|---|---|
| Inline markdown `![alt](url)` in chat | `ImagePreviewModal` | Full-screen black lightbox, 40×40 round close, big img + tiny alt caption underneath |
| Widget iframe image click (`WidgetRenderer`) | `ImagePreviewModal` | Same lightbox as above |
| Chat message attachment click (image/pdf/code/text/doc) | `AttachmentPreviewModal` | Centered card (max 92vw × 90vh), square 36×36 close, title+subtitle header, scrollable body |
| Tool row screenshots (`ScreenshotToolRow`) | `ToolImagePreviewModal` (with `hideTextPane`) | Centered card, two-pane shell with text pane hidden |
| Tool row vision analysis (`VisionToolRow`) | `ToolImagePreviewModal` | Centered card, two-pane (left image + right text panel with Question/Answer) |
| Bot-sent image bubble (`BotSendCard`) | `ToolImagePreviewModal` (with `hideTextPane`) | Centered card, two-pane shell with text pane hidden — visually identical to ScreenshotToolRow |

A screenshot of the three variants side by side shows the inconsistency immediately: same trigger ("show me the bigger picture"), three different visual languages. The lightbox uses `rgba(0,0,0,0.85)` + `blur(8px)` + round close; the panel uses `rgba(0,0,0,0.45)` + `blur(12px) saturate(1.05)` + square close; the sidebar variant adds a left/right split with a different close button entirely (and reuses the panel close class). The Z-index even differs (lightbox is `z-9999`, panel is `z-200`).

Three independent CSS files (`preview.css`, `mailbox.css` L1-95, `skills.css` L465-565) define the same conceptual elements (overlay, close, panel/canvas, header, body, image). The `.attachment-preview-overlay` / `.attachment-preview-close` classes are **shared by name** between the centered panel (`AttachmentPreviewModal`) and the sidebar variant (`ToolImagePreviewModal`) — the sidebar variant just doesn't use the inner `attachment-preview-modal` / `attachment-preview-header` / `attachment-preview-body` classes, and the corresponding CSS lives in a different file. This naming collision has already confused future maintainers (see CSS comments at sidebar.css:89-95 that explicitly list "image-preview-overlay / attachment-preview-overlay / attachment-preview-close" together as a glass-repair hack).

The cost: every fix (z-index, close button shape, blur tuning, dark-mode contrast) has to be made three times. New features (zoom, copy image, drag-to-pan) have to be built three times. The glass-repair override at `sidebar.css:82-98` exists *only* because three different overlay class names co-exist and the conductor overlay can't reliably target them.

Plan 510 covered the dialog story (`Modal` upgrade + 10 dialog migrations) and explicitly listed image-preview modals as out of scope:

> Out of scope (deferred to Plan 451+)
> - Image-preview modals (`ImagePreviewModal`, `AttachmentPreviewModal`, `ToolImagePreviewModal`) — read-only viewers, different shell needed.

This plan **is** the unification of those three.

---

## Goals

1. **One component, two variants.** `ImagePreview` with `variant: 'lightbox' | 'panel'`. The panel variant subsumes the current sidebar two-pane (VisionToolRow's "image + Question/Answer text") by rendering the text body inside the panel body region, not as a separate column.
2. **One CSS file, one class tree.** All preview-related styles move into `src/styles/preview.css`; the scattered blocks in `mailbox.css` (lines 1-95) and `skills.css` (lines 465-565) get deleted. The glass-repair override at `sidebar.css:82-98` collapses to a single selector.
3. **Unified chrome.** Same close button shape/size/position, same overlay alpha + blur, same Z-index, same Escape / click-outside semantics across both variants.
4. **All six call sites use the new component.** Markdown image, widget image, chat attachment (image/pdf/code/text/doc), screenshot tool, vision tool, bot-sent image.
5. **Test coverage.** `ImagePreview.test.tsx` covers both variants + Escape + click-outside + close button. Existing markdown-local-image.test.tsx / markdownComponents.test.tsx continue to pass against the new component.
6. **Drop the legacy sidebar layout.** The two-pane "left image / right text" layout is replaced by a centered panel with header + scrollable body. VisionToolRow's image+analysis still feels like a unit, but the text scrolls under the image instead of living in a separate column. (User confirmed this trade-off in the plan intake: "全部合并成一个 variant".)

---

## Non-goals

- Image zoom / pan / pinch (future). The new component accepts these as props so they're easy to add later, but doesn't ship them.
- Multi-image galleries (next/previous in lightbox). Future.
- The `<Modal>` dialog component (plan 510) is **not** used for image previews. The panel variant looks visually consistent with `<Modal>` (same close button, same overlay, same border + radius tokens) but is a separate component because image previews need:
  - No header chrome by default for the lightbox variant (a thin title/alt caption is built into the canvas).
  - The panel variant supports an image-as-body content (no padding around the image, object-fit: contain) which `<Modal>`'s body padding would interfere with.
  - Lightbox variant has the image fill the whole viewport with no panel chrome.
- Replacing `MarkdownRenderer`'s click handler, `WidgetRenderer`'s preview trigger, or any of the six call sites' state plumbing. Only the component name + props change at the call site.
- Removing `AttachmentPreviewModal.tsx`'s code-preview / pdf-preview / doc-preview / text-preview body content (those stay as content shapes within the new panel variant). What changes is the chrome around them.
- Touch / mobile gestures (future).

---

## Design

### New component — `src/components/chat/preview/ImagePreview.tsx`

```ts
export type ImagePreviewVariant = 'lightbox' | 'panel';

interface ImagePreviewProps {
  /** Whether the preview is rendered. Component returns null when false. */
  open: boolean;
  onClose: () => void;
  variant: ImagePreviewVariant;
  /** Source for the image content (data URL, http(s), duya-file://, file path that
   *  passes through rewriteMediaSrc internally). Required for any image-bearing
   *  usage; ignored if the body slot renders non-image content. */
  src?: string;
  alt?: string;
  /** Header title shown in the panel variant. In the lightbox variant, this
   *  becomes the caption underneath the image (when alt is also set, alt wins). */
  title?: ReactNode;
  /** Header subtitle shown in the panel variant. Ignored in lightbox. */
  subtitle?: ReactNode;
  /** Body content rendered inside the panel body region. When set, the
   *  component renders the body in addition to the image. The image and the
   *  body are siblings inside the scrollable panel-body. */
  body?: ReactNode;
  /** When true, the panel variant hides the image and renders only the
   *  body (e.g. for code/text/doc previews). Default false. */
  bodyOnly?: boolean;
}

export function ImagePreview(props: ImagePreviewProps): JSX.Element | null;
```

Shared chrome: overlay, close button, key handling, click-outside. Two render modes:

- **lightbox** — black immersive backdrop, image centered with optional caption underneath, no header chrome. Used for: markdown inline image, widget image, bot-sent image, screenshot tool (image-only).
- **panel** — centered card with title/subtitle header and image-at-top + body-below layout. Used for: chat attachment (image/pdf/code/text/doc), vision tool (image + analysis text in the body).

The internal image render uses `rewriteMediaSrc(src)` to normalize paths the same way the current `markdownComponents.tsx` does — moving that logic into the shared component removes a duplicate from `AttachmentPreviewModal.tsx` too.

### CSS — all in `src/styles/preview.css`

The unified CSS reuses tokens already established in `preview.css` (`var(--surface)`, `var(--border)`, `var(--text)`, `var(--muted)`, `var(--font-mono)`). Approximately 130 lines. Key normalization choices (each was divergent before):
- Overlay alpha: `rgba(0,0,0,0.55)` (was 0.45 / 0.85 — split the difference)
- Blur: `blur(10px) saturate(1.05)` (was 8px / 12px+saturate)
- Close button: `36×36` square `border-radius: 0.5rem` (was 40×40 round / 36×36 square)
- Z-index: `200` overlay, `201` close button (was 9999 / 200)

Both `lightbox` and `panel` variants share the same overlay, close button, fade-in animation, and key handling — only the inner content shape differs.

### Component file layout

`src/components/chat/preview/` is a new directory:

```
src/components/chat/preview/
├── ImagePreview.tsx              # the unified component (both variants)
├── ImagePreviewPanel.tsx         # body content for image/pdf/code/text/doc/placeholder
├── ImagePreview.test.tsx         # covers both variants + Escape + click-outside
```

`ImagePreviewPanel.tsx` is the body-only content from the current `AttachmentPreviewModal.tsx` (`CodePreview`, `TextPreview`, `PdfPreview`, `DocPreview`, `ImagePreview`, `UnknownPreview` sub-components, plus `getPreviewType`). `ImagePreview.tsx` wraps it for the panel-variant body or renders the image canvas for the lightbox variant.

### Backward compatibility

The three old components are deleted in Phase 3. The six call sites are all under our control and the migration is mechanical — no shim needed.

The only consumer that needs explicit updates is the test mocks:
- `src/components/chat/markdown-local-image.test.tsx` mocks `'./ImagePreviewModal'`
- `src/components/chat/markdownComponents.test.tsx` mocks `'./ImagePreviewModal'`

These mocks retarget to `'./preview/ImagePreview'`.

### Test strategy

`ImagePreview.test.tsx` (new):
1. Renders nothing when `open={false}`.
2. Lightbox variant renders overlay + close button + `<img>` with the right src.
3. Panel variant renders overlay + close button + panel header (title, subtitle) + body (img + text).
4. Escape closes in both variants.
5. Click on overlay closes; click on inner panel/canvas does not.
6. `bodyOnly` hides the image in panel variant.
7. Caption appears in lightbox variant when `alt` is set and not equal to `'page.png'`.

Existing tests:
- `markdownComponents.test.tsx`, `markdown-local-image.test.tsx`: update mock path from `./ImagePreviewModal` to `./preview/ImagePreview`.
- All other tests pass unchanged.

---

## Phases

### Phase 0 — TDD baseline

- [ ] **P0.1** Add `src/components/chat/preview/ImagePreview.test.tsx` with the 7 cases listed in §Test strategy.
- [ ] **P0.2** Run `npm run test src/components/chat/preview/ImagePreview.test.tsx`. Confirm it fails because the file doesn't exist yet.

### Phase 1 — Build the unified `ImagePreview` component

- [ ] **P1.1** Create `src/components/chat/preview/ImagePreviewPanel.tsx` with the body content from `AttachmentPreviewModal.tsx` (`CodePreview`, `TextPreview`, `PdfPreview`, `DocPreview`, `ImagePreview`, `UnknownPreview` + `getPreviewType`).
- [ ] **P1.2** Create `src/components/chat/preview/ImagePreview.tsx` with both variants per the design above. Internal `useEffect` listens for Escape and calls `onClose`. Overlay `onClick={onClose}`, panel/canvas `onClick={(e) => e.stopPropagation()}`.
- [ ] **P1.3** Replace contents of `src/styles/preview.css` with the unified `image-preview-*` rules. Append `@keyframes image-preview-fade-in` and `@keyframes image-preview-slide-up`.
- [ ] **P1.4** Run P0.1 tests; verify all pass.
- [ ] **P0.3** Run `npm run typecheck:web && npm run test src/components/chat/preview/ImagePreview.test.tsx`.

### Phase 2 — Migrate call sites

- [ ] **P2.1** `src/components/chat/markdownComponents.tsx` — replace `import { ImagePreviewModal } from './ImagePreviewModal'` with `import { ImagePreview } from './preview/ImagePreview'` and the usage `ImagePreviewModal({ src, alt, onClose })` → `ImagePreview({ open, onClose, src, alt, variant: 'lightbox' })`.
- [ ] **P2.2** `src/components/chat/WidgetRenderer.tsx` — same swap. Existing usage wraps in `previewImage && (<ImagePreviewModal .../>)`. Change to `previewImage && (<ImagePreview open onClose={...} src={previewImage.src} alt={previewImage.alt} variant="lightbox" />)`.
- [ ] **P2.3** `src/components/chat/BotSendCard.tsx` — replace `ToolImagePreviewModal` (with `hideTextPane`) → `ImagePreview({ variant: 'lightbox', src: resolvedSrc, title: altText || 'Image preview' })`. Drops `body=""` `hideTextPane` props.
- [ ] **P2.4** `src/components/chat/tools/rows/ScreenshotToolRow.tsx` — replace `ToolImagePreviewModal` (with `hideTextPane`) → `ImagePreview({ variant: 'lightbox', src: metadata.screenshot, title: subtitle || 'Browser screenshot', subtitle: width×height subtitle })`. Lightbox shows title as caption underneath.
- [ ] **P2.5** `src/components/chat/tools/rows/VisionToolRow.tsx` — replace `ToolImagePreviewModal` → `ImagePreview({ variant: 'panel', src, title, subtitle, body: analysis text + question callout })`. The Question becomes a small callout at the top of the body, the Answer is the main body text. Header keeps title + subtitle.
- [ ] **P2.6** `src/components/chat/MessageItem.tsx` — replace `AttachmentPreviewModal` → `ImagePreview({ variant: 'panel', src/title/subtitle/body })`. `getPreviewType` decision is now inside `ImagePreviewPanel` and dispatches to the right sub-component (image/pdf/code/text/doc).
- [ ] **P2.7** Update test mocks:
  - `src/components/chat/markdown-local-image.test.tsx`: `vi.mock('./ImagePreviewModal', ...)` → `vi.mock('./preview/ImagePreview', ...)`.
  - `src/components/chat/markdownComponents.test.tsx`: same.
- [ ] **P2.8** Run `npm run typecheck:all && npm run test`. Verify all 6 call sites compile + all 7 new tests pass + existing tests still pass.

### Phase 3 — Delete old components

- [ ] **P3.1** Delete `src/components/chat/ImagePreviewModal.tsx` (and `.js` if checked in; verify with `git ls-files src/components/chat/ImagePreviewModal.js`).
- [ ] **P3.2** Delete `src/components/chat/AttachmentPreviewModal.tsx` (and `.js` if checked in).
- [ ] **P3.3** Delete `src/components/chat/tools/ToolImagePreviewModal.tsx` (and `.js` if checked in).
- [ ] **P3.4** Run `npm run typecheck:all && npm run test`. Verify no orphan imports.

### Phase 4 — CSS cleanup

- [ ] **P4.1** Delete `.image-preview-overlay` / `.image-preview-close` / `.image-preview-content` / `.image-preview-image` / `.image-preview-filename` from `src/styles/mailbox.css` (lines 1-95). Keep `.markdown-image-button` / `.markdown-image` / `.markdown-video` (they're for the inline button, not the modal).
- [ ] **P4.2** Delete all `.attachment-preview-*` rules from `src/styles/preview.css`. The new `image-preview-*` rules replace them.
- [ ] **P4.3** Delete `.attachment-preview-sidebar-*` from `src/styles/skills.css` (lines 465-565).
- [ ] **P4.4** Collapse `src/styles/sidebar.css:82-98` glass-repair override from `image-preview-overlay`, `attachment-preview-overlay`, `attachment-preview-close` (three selectors) to `image-preview-overlay`, `image-preview-close` (two).
- [ ] **P4.5** Migrate `composer-panels.css:631` (`[data-lowpower] .attachment-preview-overlay`) to `[data-lowpower] .image-preview-overlay`.
- [ ] **P4.6** Verify: `grep -rn 'attachment-preview-' src/` returns zero hits. `grep -rn 'image-preview-overlay\|image-preview-close' src/styles/mailbox.css src/styles/skills.css` returns zero hits.

### Phase 5 — Visual regression with Playwright MCP

- [ ] **P5.1** Start `npm run dev`. Open Playwright MCP.
- [ ] **P5.2** Markdown image click → lightbox opens. Close via Escape, click-outside, X button.
- [ ] **P5.3** Chat attachment (image) click → panel opens with header + image. Close.
- [ ] **P5.4** Chat attachment (PDF) click → panel opens with header + thumbnail/placeholder. Close.
- [ ] **P5.5** Chat attachment (code, e.g. `.ts` file in messages) → panel opens with header + code body. Close.
- [ ] **P5.6** Screenshot tool row click → lightbox with caption. Close.
- [ ] **P5.7** Vision tool row click → panel with header (image label + format/size) + image + question callout + analysis text. Close.
- [ ] **P5.8** Bot-sent image click → lightbox. Close.
- [ ] **P5.9** Test light + dark theme for at least the markdown image case (CSS uses `data-theme` selectors).
- [ ] **P5.10** Capture screenshots into `docs/exec-plans/active/511-image-preview-modal-unification/screenshots/` for the spot-check.

### Phase 6 — Close-out

- [ ] **P6.1** Run `npm run typecheck:all` — must pass.
- [ ] **P6.2** Run `npm run test` — must pass.
- [ ] **P6.3** Run `npm run build:agent && npm run bundle:agent` — agent worker rebuilds clean.
- [ ] **P6.4** Update `docs/exec-plans/README.md` Active Plans table: add the row for this plan in the "Chat / Streaming" group.
- [ ] **P6.5** Append a "Decision log" section to this file.
- [ ] **P6.6** Atomic commit(s). Conventional commits, English, atomic per phase. Suggested split:
  - `feat(preview): add unified ImagePreview component with lightbox and panel variants`
  - `refactor(chat): migrate six preview call sites to unified component`
  - `chore(preview): delete legacy ImagePreviewModal/AttachmentPreviewModal/ToolImagePreviewModal`
  - `style(preview): consolidate preview CSS into preview.css; clean mailbox/skills/sidebar overrides`

---

## Files to modify

**New files:**
- `src/components/chat/preview/ImagePreview.tsx`
- `src/components/chat/preview/ImagePreviewPanel.tsx`
- `src/components/chat/preview/ImagePreview.test.tsx`
- `docs/exec-plans/active/511-image-preview-modal-unification.md` (this file)

**Files to modify:**
- `src/components/chat/markdownComponents.tsx` — swap import + usage
- `src/components/chat/WidgetRenderer.tsx` — swap import + usage
- `src/components/chat/BotSendCard.tsx` — swap import + usage
- `src/components/chat/tools/rows/ScreenshotToolRow.tsx` — swap import + usage
- `src/components/chat/tools/rows/VisionToolRow.tsx` — swap import + usage
- `src/components/chat/MessageItem.tsx` — swap import + usage
- `src/components/chat/markdownComponents.test.tsx` — mock path
- `src/components/chat/markdown-local-image.test.tsx` — mock path
- `src/styles/preview.css` — replace contents with unified `image-preview-*` rules
- `src/styles/mailbox.css` — delete `image-preview-*` modal rules (lines 1-95); keep markdown inline button styles
- `src/styles/skills.css` — delete `.attachment-preview-sidebar-*` rules (lines 465-565)
- `src/styles/sidebar.css` — collapse glass-repair selector list (lines 82-98)
- `src/styles/composer-panels.css` — migrate `[data-lowpower] .attachment-preview-overlay` (line 631)
- `docs/exec-plans/README.md` — add plan row

**Files to delete:**
- `src/components/chat/ImagePreviewModal.tsx` (+ `.js` if checked in)
- `src/components/chat/AttachmentPreviewModal.tsx` (+ `.js` if checked in)
- `src/components/chat/tools/ToolImagePreviewModal.tsx` (+ `.js` if checked in)

---

## Verification

Before claiming done:

1. `npm run typecheck:all` passes.
2. `npm run test` passes, including the 7 new `ImagePreview.test.tsx` cases.
3. Each of the 6 call sites renders identically (modulo the unified chrome) to before. Manual Playwright spot-check per Phase 5.
4. Light + dark theme screenshots captured in `docs/exec-plans/active/511-image-preview-modal-unification/screenshots/`.
5. `grep -rn 'attachment-preview-' src/` returns zero hits.
6. `grep -rn 'image-preview-overlay\|image-preview-close' src/styles/mailbox.css src/styles/skills.css` returns zero hits.
7. `grep -rn 'ImagePreviewModal\|AttachmentPreviewModal\|ToolImagePreviewModal' src/` returns zero hits.
8. The `bodyOnly` prop in panel variant renders text/code/pdf/doc with no image (regression target for the chat-code-attachment case).

---

## Decision log

_(filled at completion)_

### Phases executed

| Phase | Description | Status |
|---|---|---|
| 0 | Failing tests first — `ImagePreview.test.tsx` 7 cases | TBD |
| 1 | Build `ImagePreview` + `ImagePreviewPanel` + CSS | TBD |
| 2 | Migrate 6 call sites + update 2 test mocks | TBD |
| 3 | Delete 3 old components | TBD |
| 4 | CSS cleanup (mailbox.css / skills.css / sidebar.css / preview.css / composer-panels.css) | TBD |
| 5 | Visual regression with Playwright MCP | TBD |
| 6 | Close-out (typecheck/test/build/commit) | TBD |

### Key decisions made during execution

_(filled in as the work lands)_

1. **Lightbox backdrop alpha `0.55`** — was 0.45 (panel) and 0.85 (lightbox). Split the difference. If lightbox feels too dim during P5 verification, bump to 0.7 and update the CSS.
2. **Close button `36×36` square `0.5rem` radius** — was 40×40 round (lightbox) and 36×36 square (panel). Standardized on the panel variant's shape.
3. **Sidebar layout dropped** — VisionToolRow's image+analysis now renders image-at-top and analysis-text-below in the panel variant, instead of the original left-image-right-text split. This was an explicit user requirement at planning time: "全部合并成一个 variant" means sidebar layout doesn't survive the unification.
4. **Z-index `200`** — was 9999 (lightbox) and 200 (panel). Standardized on 200. Z-index 9999 was overkill (above the conductor overlay but rarely a real conflict); 200 is consistent with `<Modal>` and other chrome elements.
5. **`rewriteMediaSrc` centralized in `ImagePreview`** — the current `AttachmentPreviewModal.tsx` calls `rewriteMediaSrc` itself; the new component handles it once, removing the duplicate from the call sites.
6. **`src/components/chat/preview/` directory** — new directory under `chat/`. Three files: `ImagePreview.tsx`, `ImagePreviewPanel.tsx`, `ImagePreview.test.tsx`. Smaller scope than a top-level `src/components/preview/` because all six call sites are under `src/components/chat/`.