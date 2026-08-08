# Comments in OOXML

Comments require wiring across multiple XML files. Use `comment.py` to handle
the boilerplate, then add range markers to `document.xml` manually.

## Adding comments with `comment.py`

`comment.py` handles the cross-file plumbing (comments.xml,
commentsExtended.xml, commentsExtensible.xml, commentsIds.xml, people.xml,
relationships, content-types). Pass pre-escaped XML text:

```bash
# Top-level comment (id=0)
python scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"

# Reply to comment 0
python scripts/comment.py unpacked/ 1 "Reply text" --parent 0

# Custom author (defaults to "Duya")
python scripts/comment.py unpacked/ 0 "Text" --author "Custom Author"
```

## Adding range markers to document.xml

After running `comment.py`, add `<w:commentRangeStart>` /
`<w:commentRangeEnd>` / `<w:commentReference>` markers to `word/document.xml`.

**CRITICAL: `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings
of `<w:r>`, never inside `<w:r>`.**

```xml
<!-- Comment markers are direct children of w:p, never inside w:r -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="Duya" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
```

## Reply nesting

For replies, use `--parent` flag when calling `comment.py`, and nest the
range markers inside the parent's range:

```xml
<!-- Comment 0 with reply 1 nested inside -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>text</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

## Verification

**Rendering does not reliably show comments** in headless PDF export. To
verify comments structurally:

1. Check `word/comments.xml` exists and contains the expected comment IDs.
2. Check `word/_rels/document.xml.rels` has relationships for
   `comments.xml`.
3. Check `[Content_Types].xml` declares the comments content type.
4. Check that every `<w:commentReference w:id="N"/>` in `document.xml` has
   a matching `<w:comment w:id="N">` in `comments.xml`.
5. Run `python scripts/office/validate.py unpacked/ --original original.docx`
   to verify schema compliance.

## Stripping all comments

For final delivery when all comments should be removed:

Use the Edit tool to remove all `<w:commentRangeStart>`,
`<w:commentRangeEnd>`, and `<w:commentReference>` elements from
`document.xml`, then delete `comments.xml` and related plumbing. Run
`validate.py` after to ensure no dangling references remain.
