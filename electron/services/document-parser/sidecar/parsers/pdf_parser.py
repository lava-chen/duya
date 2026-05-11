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
        confidence = "high" if avg_chars_per_page >= PDF_CONFIDENCE_THRESHOLD else "low"

        result: dict = {
            "text": extracted_text,
            "extractMethod": "text" if confidence == "high" else "vision",
            "confidence": confidence,
            "avgCharsPerPage": avg_chars_per_page,
            "pageCount": page_count,
        }

        if confidence == "low":
            try:
                images = self._render_pages_as_images(filepath, page_count)
                if images:
                    result["extractMethod"] = "hybrid"
                    result["images"] = images
            except Exception:
                pass

        return result

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