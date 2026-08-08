---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, or general coding tasks unrelated to document generation."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files. Visual defects (clipping,
overflow, broken tables, header/footer drift, missing glyphs) cannot be detected
by reading XML or text alone — they only surface after rendering. This skill
enforces a render-and-verify loop as a hard shipping gate.

## Duya capability binding

This skill is bound to duya's own capabilities. Do not assume foreign tooling.

- **`vision_analyze` tool** — visual QA of rendered pages. After rendering a
  docx to PNG, call `vision_analyze` to inspect layout, spacing, overflow,
  table geometry, page breaks, header/footer position, and font rendering.
- **Built-in `DocxParser`** — reads docx text and extracts embedded images
  without external deps. Prefer it over `pandoc` for read/analyze tasks
  (see `tasks/read_docx.md`).
- **Agent name "Duya"** — default author for tracked changes and comments.
  Never use "Claude" or any other name unless the user explicitly requests it.
- **`duya_cli`** — `duya_cli skill info docx` for self-inspection.
- **External tooling** (LibreOffice, Poppler, pandoc, docx-js) — see
  Dependencies below for detection and fallback paths.

## Quick Reference

| Task | Approach | Reference |
|------|----------|-----------|
| Read / analyze content | duya `DocxParser` (preferred) or `pandoc` | `tasks/read_docx.md` |
| Create new document | `docx-js` (primary) or `python-docx` | `tasks/create_docx_js.md` |
| Edit existing document | unpack → edit XML → repack | `tasks/edit_existing.md` |
| Tracked changes (redlines) | OOXML `<w:ins>` / `<w:del>` | `ooxml/tracked_changes.md` |
| Comments | `comment.py` + XML markers | `ooxml/comments.md` |
| Images in OOXML | media + rels + content type | `ooxml/images.md` |
| Render to PNG (visual QA) | `scripts/render_docx.py` | Visual Verification Gate below |

### Converting legacy `.doc` to `.docx`

```bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
```

### Accepting tracked changes

```bash
python scripts/accept_changes.py input.docx output.docx
```

---

## Visual Verification Gate (HARD)

**You do not "know" a DOCX is satisfactory until you have rendered it and
visually inspected page images.** DOCX text extraction or XML reading will
miss layout defects: clipping, overlap, missing glyphs, broken tables,
spacing drift, and header/footer issues.

**Shipping gate — before declaring any docx task complete:**

1. Run the renderer to produce per-page PNGs:
   ```bash
   python scripts/render_docx.py output.docx --out-dir pages/ [--dpi 150]
   ```
2. For each generated `pages/page-<N>.png`, call the `vision_analyze` tool
   with concrete acceptance criteria: layout, spacing, alignment, overflow,
   clipping, occlusion, table geometry, page breaks, header/footer position,
   font rendering, and reference-image fidelity if the user supplied one.
3. If any defect is found → fix the docx → re-render → re-inspect. Repeat
   until every page is clean at 100% zoom.
4. **Do not deliver** if visual verification was not performed or failed.
   If the environment lacks LibreOffice or Poppler, report the limitation
   explicitly and fall back to the built-in `DocxParser` (text + embedded
   image extraction) as a **weak** verification — never claim full visual
   acceptance in that case.

**Deliverable discipline:** Rendered PNGs and intermediate PDFs are for
internal QA only. Unless the user explicitly asks for intermediates, return
only the requested final `.docx` deliverable.

### What rendering does and does not validate

- **Great for:** layout correctness, fonts, spacing, tables, headers/footers,
  and whether tracked changes visually appear.
- **Not reliable for:** comments (often not rendered in headless PDF
  export). For comments, also do structural checks (comments.xml + anchors
  + rels + content-types) — see `ooxml/comments.md`.

---

## Design Preset Contract

For new DOCX creation and major rewrites, a design preset is **mandatory**
unless the user explicitly asks for a different visual system. For
existing-document edits, preserve the original document and apply minimal
local edits (see `tasks/edit_existing.md`).

Picking a preset is not enough. Resolve the preset into exact numeric tokens
and apply those numbers in the docx-js implementation. Do not rely on Word
defaults, built-in list styles, theme defaults, inherited paragraph spacing,
or renderer-dependent behavior for any preset-controlled value.

### Paper size — auto by locale

duya is locale-aware. Default paper size follows the user's language/region:

| User locale | Paper | DXA (W × H) | Content width (1" margins) |
|-------------|-------|-------------|------------------------------|
| zh / Asian / 中国 / 国内场景 | **A4** (default) | 11906 × 16838 | 9026 |
| en / US | US Letter | 12240 × 15840 | 9360 |

If the user's locale is ambiguous, prefer **A4** (duya is a Chinese-first
product). The user can always override with an explicit paper request.

### Presets

Choose exactly one preset before drafting. Keep it stable throughout the
document — do not mix body spacing, heading colors, list indents, table
fills, or page furniture from multiple presets.

- `standard_report` — **default** for formal reports, school reports, work
  summaries. A4, 宋体/Arial body, black hierarchy, simple title treatment,
  restrained accent color. Readable, professional, no decorative excess.
- `business_memo` — memos, decision briefs, RFI responses. Compact,
  callout-driven, single accent color for emphasis.
- `compact_reference` — launch guides, checklists, dense operator
  references. Smaller type, tighter rhythm, table-heavy but audited.
- `narrative_proposal` — grants, proposals, persuasive documents with
  longer prose. Generous spacing, readable type scale, minimal tables.

### Typography defaults

| Locale | Body font | Heading font | Body size |
|--------|-----------|--------------|-----------|
| Chinese | 宋体 (SimSun) or 微软雅黑 (Microsoft YaHei) | 黑体 (SimHei) or 微软雅黑 | 12pt (24 half-points) |
| English | Arial | Arial Bold | 12pt (24 half-points) |

Always set fonts explicitly in the `Document.styles.default` block — do not
inherit Word's Calibri default.

### Table geometry (hard rule)

Tables must use explicit Word geometry. Set both `columnWidths` on the
table AND `width` on each cell, both in `WidthType.DXA`. Table width must
equal the sum of `columnWidths`. Never use `WidthType.PERCENTAGE`.
Set cell margins explicitly for readable padding.

### Lists (hard rule)

Use real numbering definitions via `LevelFormat.BULLET` /
`LevelFormat.DECIMAL`. Never fake bullets with Unicode `•`, hyphen-prefixed
paragraphs, manual numbers, or newline-separated items in one paragraph.

---

## Form factor selection

For new documents and major rewrites, choose content form factors
deliberately before drafting. Use the lightest readable structure that
helps the reader understand, compare, act on, or fill in the information.

Map each major content unit to a form factor:

- **PROSE SECTION** — narrative, explanation, background. Paragraphs under
  clear headings.
- **LEAD CALLOUT** — decision, recommendation, key takeaway. Short labeled
  paragraph or callout.
- **NUMBERED STEPS** — sequence, workflow, procedure. Step blocks with
  action verbs.
- **GROUPED BULLETS** — loose factors, pros/cons, requirements. Bullets
  when order is not the main point.
- **CHECKLIST** — actions, acceptance checks. Compact labels, scannable.
- **NOTE BOX** — warnings, caveats, constraints. Callout with restrained
  emphasis.
- **TABLE** — repeated comparable records, status grids, schedules with
  shared fields. See Table Gate below.
- **FORM LAYOUT** — forms, questionnaires. Readable fields, sectioning.

### Table Gate

Use a table **only** when the content is truly row/column data: repeated
items with shared fields and useful comparison or lookup.

Do not use tables to package normal prose. If cells become mini-paragraphs,
switch to prose sections, bullets, steps, callouts, or appendix material.

Before finalizing, run a table-overuse audit:

- If most cells in a table are sentence- or paragraph-length prose, convert
  that section to prose, bullets, steps, callouts, or labeled paragraphs.
- If two or more adjacent sections use tables, check whether at least one
  should become bullets or paragraphs for readability.

---

## Critical rules for docx-js

- **Set page size explicitly** — see Paper Size table above. docx-js
  defaults to A4 but always set it explicitly for consistent results.
- **Landscape: pass portrait dimensions** — docx-js swaps width/height
  internally; pass short edge as `width`, long edge as `height`, and set
  `orientation: PageOrientation.LANDSCAPE`.
- **Never use `\n`** — use separate Paragraph elements.
- **Never use unicode bullets** — use `LevelFormat.BULLET` with numbering
  config.
- **PageBreak must be in a Paragraph** — standalone creates invalid XML.
- **ImageRun requires `type`** — always specify `png` / `jpg` / etc.
- **Always set table `width` with DXA** — never `WidthType.PERCENTAGE`.
- **Tables need dual widths** — `columnWidths` array AND cell `width`, both
  must match and sum to table width.
- **Always add cell margins** — `margins: { top: 80, bottom: 80, left: 120,
  right: 120 }` for readable padding.
- **Use `ShadingType.CLEAR`** — never SOLID for table shading.
- **Never use tables as dividers/rules** — cells have minimum height and
  render as empty boxes (including in headers/footers); use
  `border: { bottom: { ... } }` on a Paragraph instead.
- **TOC requires HeadingLevel only** — no custom styles on heading
  paragraphs.
- **Override built-in styles** — use exact IDs: "Heading1", "Heading2",
  etc. Include `outlineLevel` (0 for H1, 1 for H2) — required for TOC.
- **Use "Duya" as author** for tracked changes and comments, unless the
  user explicitly requests a different name.

For full code examples (setup, styles, lists, tables, images, hyperlinks,
footnotes, tab stops, multi-column, TOC, headers/footers), see
`tasks/create_docx_js.md`.

---

## Editing existing documents

Follow all 3 steps in order. See `tasks/edit_existing.md` for details.

1. **Unpack**: `python scripts/office/unpack.py document.docx unpacked/`
2. **Edit XML**: edit files in `unpacked/word/`. Use the Edit tool directly
   for string replacement — do not write Python scripts for one-off edits.
   Use smart quotes (XML entities `&#x2019;` etc.) for new content.
3. **Pack**: `python scripts/office/pack.py unpacked/ output.docx --original document.docx`

---

## Dependencies

| Tool | Purpose | Required | Detection |
|------|---------|----------|-----------|
| LibreOffice (`soffice`) | docx → PDF | For visual QA | `scripts/office/soffice.py` auto-detects |
| Poppler (`pdftoppm`) | PDF → PNG | For visual QA | `scripts/render_docx.py` checks |
| `pandoc` | Text extraction (fallback) | Optional | duya `DocxParser` preferred |
| `docx` (npm) | New documents via docx-js | For creation | `npm install docx` locally |
| Python 3 | Run scripts/ helpers | Yes | — |
| `defusedxml` (pip) | XML processing | Yes | used by pack/unpack/validate |

If LibreOffice or Poppler is missing, visual QA cannot run. Report the
limitation explicitly and fall back to `DocxParser` for weak structural
verification. Do not claim visual acceptance was completed.

---

## Where to go next

- **Reading/reviewing a docx** → `tasks/read_docx.md`
- **Creating a new docx** → `tasks/create_docx_js.md`
- **Editing an existing docx** → `tasks/edit_existing.md`
- **Tracked changes (redlines)** → `ooxml/tracked_changes.md`
- **Comments** → `ooxml/comments.md`
- **Images in OOXML** → `ooxml/images.md`
- **Visual verification** → Visual Verification Gate section above
