# Tracked Changes (Redlines) in OOXML

Use these patterns when editing `word/document.xml` inside an unpacked DOCX
directory. See `tasks/edit_existing.md` for the unpack → edit → repack flow.

**Author:** Use `"Duya"` as the author for all tracked changes unless the user
explicitly requests a different name.

## Schema compliance

- **Element order in `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`,
  `<w:ind>`, `<w:jc>`, `<w:rPr>` last.
- **Whitespace**: Add `xml:space="preserve"` to `<w:t>` with leading/trailing
  spaces.
- **RSIDs**: Must be 8-digit hex (e.g., `00AB1234`).

## Insertion

```xml
<w:ins w:id="1" w:author="Duya" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

## Deletion

```xml
<w:del w:id="2" w:author="Duya" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Inside `<w:del>`**: Use `<w:delText>` instead of `<w:t>`, and
`<w:delInstrText>` instead of `<w:instrText>`.

## Minimal edits — only mark what changes

```xml
<!-- Change "30 days" to "60 days" -->
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Duya" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Duya" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
```

## Deleting entire paragraphs / list items

When removing ALL content from a paragraph, also mark the paragraph mark as
deleted so it merges with the next paragraph. Add `<w:del/>` inside
`<w:pPr><w:rPr>`:

```xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- list numbering if present -->
    <w:rPr>
      <w:del w:id="1" w:author="Duya" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Duya" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
```

Without the `<w:del/>` in `<w:pPr><w:rPr>`, accepting changes leaves an empty
paragraph/list item.

## Rejecting another author's insertion

Nest deletion inside their insertion:

```xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="Duya" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
```

## Restoring another author's deletion

Add insertion after (don't modify their deletion):

```xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="Duya" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
```

## Common pitfalls

- **Replace entire `<w:r>` elements**: When adding tracked changes, replace
  the whole `<w:r>...</w:r>` block with `<w:del>...<w:ins>...` as siblings.
  Don't inject tracked change tags inside a run.
- **Preserve `<w:rPr>` formatting**: Copy the original run's `<w:rPr>` block
  into your tracked change runs to maintain bold, font size, etc.
- **Use `python scripts/office/validate.py`** to verify redlining after
  packing. The validator checks that all tracked changes are attributed to
  the expected author.
