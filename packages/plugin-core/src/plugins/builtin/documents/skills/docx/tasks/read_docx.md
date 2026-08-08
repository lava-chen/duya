# Reading and analyzing DOCX content

duya has a built-in `DocxParser` that extracts text and embedded images
from `.docx` files without external dependencies. Prefer it over `pandoc`
for most read/analyze tasks.

## Option 1: duya built-in DocxParser (preferred)

When you read a `.docx` file with the Read tool, duya's `DocxParser`
automatically extracts:

- Paragraph and table text (preserving structure)
- Embedded images from `word/media/` (returned as image content blocks)

No external tooling required. This is the default path for reading docx
content in duya.

**When to use:** general content review, text extraction, finding specific
content, extracting embedded images.

**Limitations:** does not show tracked changes inline, does not preserve
exact formatting, does not render the visual layout. For those, use the
options below.

## Option 2: pandoc (tracked changes aware)

Use `pandoc` when you need to see tracked changes or extract clean markdown:

```bash
# Show all tracked changes (insertions and deletions)
pandoc --track-changes=all document.docx -o output.md

# Accept all changes and extract clean text
pandoc --track-changes=accept document.docx -o clean.md

# Reject all changes and extract original text
pandoc --track-changes=reject document.docx -o original.md
```

**When to use:** reviewing tracked changes, extracting markdown-formatted
content, comparing original vs modified text.

**Limitations:** does not render visual layout, may lose some formatting
nuance.

## Option 3: unpack for raw XML access

When you need to inspect or modify the raw OOXML (e.g., to see exact
formatting, comments, or tracked change markup):

```bash
python scripts/office/unpack.py document.docx unpacked/
```

This extracts the XML files, pretty-prints them, merges adjacent runs, and
converts smart quotes to XML entities so they survive editing.

Key files to inspect:

| File | Contents |
|------|----------|
| `word/document.xml` | Main document body (paragraphs, tables, runs) |
| `word/styles.xml` | Style definitions (Heading1, Normal, etc.) |
| `word/numbering.xml` | List/bullet numbering definitions |
| `word/header*.xml` / `word/footer*.xml` | Headers and footers |
| `word/comments.xml` | Comments (if any) |
| `word/_rels/document.xml.rels` | Relationships (images, hyperlinks, etc.) |
| `[Content_Types].xml` | Content type declarations |

**When to use:** inspecting exact OOXML structure, preparing for edit
operations, debugging rendering issues.

**See also:** `tasks/edit_existing.md` for the full unpack → edit → repack
workflow.

## Option 4: render to PNG (visual review)

When you need to verify the visual layout of a docx:

```bash
python scripts/render_docx.py document.docx --out-dir pages/
```

Then inspect the generated `pages/page-*.png` files with the `vision_analyze`
tool. See the Visual Verification Gate section in `SKILL.md` for the full
workflow.

**When to use:** verifying layout, checking for clipping/overflow,
confirming visual quality before delivery.
