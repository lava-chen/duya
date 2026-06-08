import base64
import io
import os
import sys
import traceback

import pdfplumber

PDF_CONFIDENCE_THRESHOLD = 100
MAX_VISION_PAGES = 8
VISION_DPI = 140
VISION_MAX_WIDTH = 1400
VISION_JPEG_QUALITY = 80


class PdfParser:
    def __init__(self) -> None:
        self._poppler_path = self._resolve_poppler_path()

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

        result: dict = {
            "text": extracted_text,
            "extractMethod": "text",
            "confidence": "high" if avg_chars_per_page >= PDF_CONFIDENCE_THRESHOLD else "low",
            "avgCharsPerPage": avg_chars_per_page,
            "pageCount": page_count,
        }

        try:
            thumbnail = self._render_thumbnail(filepath)
            if thumbnail:
                result["thumbnail"] = thumbnail
        except Exception:
            print(f"[PdfParser] Thumbnail generation failed: {traceback.format_exc()}", file=sys.stderr)

        if total_chars == 0:
            try:
                images = self._render_pages_as_images(filepath, page_count)
                if images:
                    result["images"] = images
                    result["extractMethod"] = "vision"
            except Exception:
                print(f"[PdfParser] Vision fallback failed: {traceback.format_exc()}", file=sys.stderr)

        return result

    def _render_thumbnail(self, filepath: str) -> dict | None:
        try:
            from pdf2image import convert_from_path
        except ImportError as e:
            print(f"[PdfParser] pdf2image not installed: {e}", file=sys.stderr)
            return None

        images = convert_from_path(
            filepath,
            dpi=100,
            first_page=1,
            last_page=1,
            fmt="png",
            poppler_path=self._poppler_path,
        )
        if not images:
            return None

        img = images[0]
        max_width = 300
        if img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)))

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

        images = convert_from_path(
            filepath,
            dpi=VISION_DPI,
            first_page=1,
            last_page=min(page_count, MAX_VISION_PAGES),
            fmt="jpeg",
            poppler_path=self._poppler_path,
        )

        result: list[dict] = []
        for i, img in enumerate(images):
            if img.width > VISION_MAX_WIDTH:
                ratio = VISION_MAX_WIDTH / img.width
                img = img.resize((VISION_MAX_WIDTH, int(img.height * ratio)))

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=VISION_JPEG_QUALITY, optimize=True)
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            result.append({
                "page": i,
                "base64": b64,
                "mediaType": "image/jpeg",
            })
            buf.close()

        return result

    def _resolve_poppler_path(self) -> str | None:
        env_path = os.getenv("DUYA_POPPLER_PATH")
        if env_path and os.path.isdir(env_path):
            return env_path

        if getattr(sys, "frozen", False):
            runtime_base = os.path.dirname(sys.executable)
        else:
            runtime_base = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

        candidates = [
            os.path.join(runtime_base, "poppler", "Library", "bin"),
            os.path.join(runtime_base, "poppler", "bin"),
        ]
        for candidate in candidates:
            if os.path.isdir(candidate):
                return candidate
        return None
