# Images in OOXML

When editing an unpacked DOCX, adding an image requires touching four
places: the media file, the relationship, the content type, and the drawing
element in `document.xml`.

## Step 1: Add the image file

Copy the image into `word/media/`:

```
unpacked/
  word/
    media/
      image1.png   <-- add your image here
```

## Step 2: Add the relationship

In `word/_rels/document.xml.rels`, add a `<Relationship>` entry with a unique
`Id` (e.g., `rId5` — pick a number not already used):

```xml
<Relationship Id="rId5"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
  Target="media/image1.png"/>
```

## Step 3: Add the content type (if new extension)

In `[Content_Types].xml`, ensure the image extension is declared. Add a
`<Default>` entry if missing:

```xml
<Default Extension="png" ContentType="image/png"/>
```

Common content types:

| Extension | ContentType |
|-----------|-------------|
| png | image/png |
| jpg / jpeg | image/jpeg |
| gif | image/gif |
| bmp | image/bmp |
| svg | image/svg+xml |
| tif / tiff | image/tiff |

## Step 4: Reference the image in document.xml

Insert a `<w:drawing>` element inside a `<w:r>` (run) inside a `<w:p>`
(paragraph):

```xml
<w:p>
  <w:r>
    <w:drawing>
      <wp:inline>
        <wp:extent cx="914400" cy="914400"/>
        <!-- cx = width, cy = height in EMUs. 914400 EMU = 1 inch = 72pt = 96px@96dpi -->
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:blipFill>
                <a:blip r:embed="rId5"/>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm>
                  <a:off x="0" y="0"/>
                  <a:ext cx="914400" cy="914400"/>
                </a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>
  </w:r>
</w:p>
```

## EMU conversion reference

OOXML uses English Metric Units (EMU) for drawing dimensions.

| Unit | EMU value |
|------|-----------|
| 1 inch | 914400 |
| 1 cm | 360000 |
| 1 pt (point) | 12700 |
| 1 px @ 96 dpi | 9525 |

Example: a 4-inch × 3-inch image → `cx="3657600" cy="2743200"`.

## Verification

1. Run `python scripts/office/validate.py unpacked/ --original original.docx`
   to check schema compliance.
2. Run `python scripts/render_docx.py output.docx --out-dir pages/` and
   inspect the rendered PNG with `vision_analyze` to confirm the image
   appears at the expected size and position.

## Common pitfalls

- **Missing relationship**: If the image doesn't appear, check that the `Id`
  in `document.xml.rels` matches the `r:embed` in `<a:blip>`.
- **Wrong content type**: If Word reports a repair error, the extension in
  `[Content_Types].xml` may be missing or mismatched.
- **Size in wrong units**: Drawing dimensions are EMU, not DXA or pixels.
  Use the conversion table above.
- **Image not in a paragraph**: `<w:drawing>` must be inside `<w:r>` inside
  `<w:p>`. A bare `<w:drawing>` produces invalid XML.
