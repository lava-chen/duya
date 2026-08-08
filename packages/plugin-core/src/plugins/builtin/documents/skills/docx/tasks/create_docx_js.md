# Creating new DOCX documents with docx-js

Generate `.docx` files with JavaScript using the `docx` npm package, then
validate and render. Install locally (not globally):

```bash
npm install docx
```

## Setup

```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
        Header, Footer, AlignmentType, PageOrientation, LevelFormat, ExternalHyperlink,
        InternalHyperlink, Bookmark, FootnoteReferenceRun, PositionalTab,
        PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader,
        TabStopType, TabStopPosition, Column, SectionType,
        TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
        VerticalAlign, PageNumber, PageBreak } = require('docx');

const fs = require('fs');

const doc = new Document({ sections: [{ children: [/* content */] }] });
Packer.toBuffer(doc).then(buffer => fs.writeFileSync("doc.docx", buffer));
```

## Validation

After creating the file, validate it. If validation fails, unpack, fix the
XML, and repack (see `tasks/edit_existing.md`).

```bash
python scripts/office/validate.py doc.docx
```

## Page size — auto by locale

duya is locale-aware. Set page size explicitly based on the user's locale:

```javascript
// Chinese / Asian locale → A4 (default for duya)
sections: [{
  properties: {
    page: {
      size: {
        width: 11906,   // A4 width in DXA (210mm)
        height: 16838   // A4 height in DXA (297mm)
      },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 inch margins
    }
  },
  children: [/* content */]
}]

// English / US locale → US Letter
// sections: [{
//   properties: {
//     page: {
//       size: { width: 12240, height: 15840 },  // 8.5 × 11 inches in DXA
//       margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
//     }
//   },
//   children: [/* content */]
// }]
```

**Common page sizes (DXA units, 1440 DXA = 1 inch):**

| Paper | Width | Height | Content Width (1" margins) |
|-------|-------|--------|---------------------------|
| A4 (duya default) | 11,906 | 16,838 | 9,026 |
| US Letter | 12,240 | 15,840 | 9,360 |

**Landscape orientation:** docx-js swaps width/height internally, so pass
portrait dimensions and let it handle the swap:

```javascript
size: {
  width: 11906,   // Pass SHORT edge as width
  height: 16838,  // Pass LONG edge as height
  orientation: PageOrientation.LANDSCAPE  // docx-js swaps them in the XML
},
// Content width = 16838 - left margin - right margin (uses the long edge)
```

## Styles (override built-in headings)

Set fonts explicitly based on locale. Do not inherit Word's Calibri default.

```javascript
// Chinese locale — 宋体 body, 黑体 headings
const doc = new Document({
  styles: {
    default: { document: { run: { font: "宋体", size: 24 } } }, // 12pt, SimSun
    paragraphStyles: [
      // IMPORTANT: Use exact IDs to override built-in styles
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "黑体" },  // SimHei for headings
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } }, // outlineLevel required for TOC
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "黑体" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("标题")] }),
    ]
  }]
});

// English locale — Arial throughout
// const doc = new Document({
//   styles: {
//     default: { document: { run: { font: "Arial", size: 24 } } },
//     paragraphStyles: [
//       { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
//         run: { size: 32, bold: true, font: "Arial" },
//         paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
//     ]
//   },
//   ...
// });
```

## Lists (NEVER use unicode bullets)

```javascript
// WRONG - never manually insert bullet characters
new Paragraph({ children: [new TextRun("• Item")] })  // BAD
new Paragraph({ children: [new TextRun("\u2022 Item")] })  // BAD

// CORRECT - use numbering config with LevelFormat.BULLET
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 },
        children: [new TextRun("Bullet item")] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 },
        children: [new TextRun("Numbered item")] }),
    ]
  }]
});

// Each reference creates INDEPENDENT numbering
// Same reference = continues (1,2,3 then 4,5,6)
// Different reference = restarts (1,2,3 then 1,2,3)
```

## Tables

**CRITICAL: Tables need dual widths** — set both `columnWidths` on the table
AND `width` on each cell. Without both, tables render incorrectly on some
platforms.

```javascript
// Always set table width for consistent rendering
// Use ShadingType.CLEAR (not SOLID) to prevent black backgrounds
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

// A4 with 1" margins: content width = 11906 - 2880 = 9026 DXA
new Table({
  width: { size: 9026, type: WidthType.DXA },  // Always use DXA
  columnWidths: [4513, 4513],  // Must sum to table width
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 4513, type: WidthType.DXA },  // Also set on each cell
          shading: { fill: "D5E8F0", type: ShadingType.CLEAR },  // CLEAR not SOLID
          margins: { top: 80, bottom: 80, left: 120, right: 120 },  // Cell padding
          children: [new Paragraph({ children: [new TextRun("Cell")] })]
        })
      ]
    })
  ]
})
```

**Table width calculation:**

Always use `WidthType.DXA`. Table width must equal the sum of `columnWidths`.
Cell `width` must match corresponding `columnWidth`. Cell `margins` are
internal padding — they reduce content area, not add to cell width. For
full-width tables: use content width (page width minus left and right
margins).

```javascript
// A4 with 1" margins: 11906 - 2880 = 9026 DXA
width: { size: 9026, type: WidthType.DXA },
columnWidths: [6000, 3026]  // Must sum to table width
```

## Images

```javascript
// CRITICAL: type parameter is REQUIRED
new Paragraph({
  children: [new ImageRun({
    type: "png",  // Required: png, jpg, jpeg, gif, bmp, svg
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "Title", description: "Desc", name: "Name" }  // All three required
  })]
})
```

## Page breaks

```javascript
// CRITICAL: PageBreak must be inside a Paragraph
new Paragraph({ children: [new PageBreak()] })

// Or use pageBreakBefore
new Paragraph({ pageBreakBefore: true, children: [new TextRun("New page")] })
```

## Hyperlinks

```javascript
// External link
new Paragraph({
  children: [new ExternalHyperlink({
    children: [new TextRun({ text: "Click here", style: "Hyperlink" })],
    link: "https://example.com",
  })]
})

// Internal link (bookmark + reference)
// 1. Create bookmark at destination
new Paragraph({ heading: HeadingLevel.HEADING_1, children: [
  new Bookmark({ id: "chapter1", children: [new TextRun("Chapter 1")] }),
]})
// 2. Link to it
new Paragraph({ children: [new InternalHyperlink({
  children: [new TextRun({ text: "See Chapter 1", style: "Hyperlink" })],
  anchor: "chapter1",
})]})
```

## Footnotes

```javascript
const doc = new Document({
  footnotes: {
    1: { children: [new Paragraph("Source: Annual Report 2024")] },
    2: { children: [new Paragraph("See appendix for methodology")] },
  },
  sections: [{
    children: [new Paragraph({
      children: [
        new TextRun("Revenue grew 15%"),
        new FootnoteReferenceRun(1),
        new TextRun(" using adjusted metrics"),
        new FootnoteReferenceRun(2),
      ],
    })]
  }]
});
```

## Tab stops

```javascript
// Right-align text on same line (e.g., date opposite a title)
new Paragraph({
  children: [
    new TextRun("Company Name"),
    new TextRun("\tJanuary 2025"),
  ],
  tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
})

// Dot leader (e.g., TOC-style)
new Paragraph({
  children: [
    new TextRun("Introduction"),
    new TextRun({ children: [
      new PositionalTab({
        alignment: PositionalTabAlignment.RIGHT,
        relativeTo: PositionalTabRelativeTo.MARGIN,
        leader: PositionalTabLeader.DOT,
      }),
      "3",
    ]}),
  ],
})
```

## Multi-column layouts

```javascript
// Equal-width columns
sections: [{
  properties: {
    column: {
      count: 2,          // number of columns
      space: 720,        // gap between columns in DXA (720 = 0.5 inch)
      equalWidth: true,
      separate: true,    // vertical line between columns
    },
  },
  children: [/* content flows naturally across columns */]
}]

// Custom-width columns (equalWidth must be false)
sections: [{
  properties: {
    column: {
      equalWidth: false,
      children: [
        new Column({ width: 5400, space: 720 }),
        new Column({ width: 3240 }),
      ],
    },
  },
  children: [/* content */]
}]
```

Force a column break with a new section using `type: SectionType.NEXT_COLUMN`.

## Table of contents

```javascript
// CRITICAL: Headings must use HeadingLevel ONLY - no custom styles
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })
```

## Headers / footers

```javascript
sections: [{
  properties: {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }  // 1440 = 1 inch
  },
  headers: {
    default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] })
  },
  footers: {
    default: new Footer({ children: [new Paragraph({
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })]
    })] })
  },
  children: [/* content */]
}]
```

## Full workflow

1. **Design** — pick a preset and form factors (see SKILL.md sections
   "Design Preset Contract" and "Form factor selection").
2. **Implement** — write the docx-js code following the patterns above.
3. **Validate** — `python scripts/office/validate.py doc.docx`
4. **Render** — `python scripts/render_docx.py doc.docx --out-dir pages/`
5. **Visual QA** — inspect each `pages/page-*.png` with `vision_analyze`.
6. **Fix and repeat** — until every page is clean. See the Visual
   Verification Gate section in `SKILL.md`.
