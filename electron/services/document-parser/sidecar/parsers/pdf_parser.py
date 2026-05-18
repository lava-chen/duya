import base64
import io
import pdfplumber

PDF_CONFIDENCE_THRESHOLD = 100


class PdfParser:
    async def parse(self, filepath: str) -> dict:
        text_parts: list[str] = []
        total_chars = 0
        page_count = 0

        with pdfplumber.open(filepath) as pdf:
            for page in pdf.pages:
                page_count += 1
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
                    total_chars += len(page_text)

                for table in page.extract_tables():
                    if table:
                        for row in table:
                            cells = [str(cell) if cell else "" for cell in row]
                            line = " | ".join(cells)
                            text_parts.append(line)
                            total_chars += len(line)

        extracted_text = "\n\n".join(text_parts)
        avg_chars_per_page = total_chars / max(page_count, 1)

        # Determine if we need vision fallback:
        # - If no text extracted at all, definitely need vision (scanned doc)
        # - If some text extracted but confidence is low, we still keep the text
        #   but may add images if extraction seems incomplete (very few chars per page)
        result: dict = {
            "text": extracted_text,
            "extractMethod": "text",
            "confidence": "high" if avg_chars_per_page >= PDF_CONFIDENCE_THRESHOLD else "low",
            "avgCharsPerPage": avg_chars_per_page,
            "pageCount": page_count,
        }

        # Generate thumbnail from first page for UI preview
        try:
            thumbnail = self._render_thumbnail(filepath)
            if thumbnail:
                result["thumbnail"] = thumbnail
        except Exception:
            pass

        if total_chars == 0:
            # No text extracted — fully scanned document, render as images
            try:
                images = self._render_pages_as_images(filepath, page_count)
                if images:
                    result["images"] = images
                    result["extractMethod"] = "vision"
            except Exception:
                pass
        elif avg_chars_per_page < PDF_CONFIDENCE_THRESHOLD // 2 and page_count <= 5:
            # Very low confidence AND few pages — likely mixed content, add images as hybrid
            try:
                images = self._render_pages_as_images(filepath, page_count)
                if images:
                    result["images"] = images
                    result["extractMethod"] = "hybrid"
            except Exception:
                pass

        return result

    def _render_thumbnail(self, filepath: str) -> dict | None:
        try:
            from pdf2image import convert_from_path
        except ImportError:
            return None

        images = convert_from_path(
            filepath,
            dpi=100,
            first_page=1,
            last_page=1,
            fmt="png",
        )
        if not images:
            return None

        img = images[0]
        # Resize to thumbnail (max 300px width, maintaining aspect ratio)
        max_width = 300
        if img.width > max_width:
            ratio = max_width / img.width
            new_height = int(img.height * ratio)
            img = img.resize((max_width, new_height))

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        buf.close()

        return {
            "base64": b64,
            "mediaType": "image/png",
        }

    def _render_pages_as_images(self, filepath: str, page_count: int) -> list[dict]:
        try:
            from pdf2image import convert_from_path
        except ImportError:
            return []

        dpi = 200
        images = convert_from_path(
            filepath,
            dpi=dpi,
            first_page=1,
            last_page=min(page_count, 50),
            fmt="png",
        )

        result: list[dict] = []
        for i, img in enumerate(images):
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            result.append({
                "page": i,
                "base64": b64,
                "mediaType": "image/png",
            })
            buf.close()

        return result