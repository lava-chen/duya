import os
import platform
import shutil
from typing import Any, Optional

from parsers.txt_parser import TxtParser
from parsers.docx_parser import DocxParser
from parsers.pdf_parser import PdfParser
from parsers.pptx_parser import PptxParser


class ParserRegistry:
    def __init__(self) -> None:
        self._parsers: dict[str, Any] = {
            ".txt": TxtParser(),
            ".md": TxtParser(),
            ".docx": DocxParser(),
            ".pdf": PdfParser(),
            ".pptx": PptxParser(),
        }
        self._libreoffice_path: Optional[str] = self._detect_libreoffice()

    def _detect_libreoffice(self) -> Optional[str]:
        system = platform.system()
        if system == "Darwin":
            candidates = [
                "/Applications/LibreOffice.app/Contents/MacOS/soffice",
            ]
        elif system == "Windows":
            candidates = [
                "C:/Program Files/LibreOffice/program/soffice.exe",
                "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
            ]
        else:
            candidates = [
                "/usr/bin/soffice",
                "/usr/local/bin/soffice",
            ]

        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate

        soffice = shutil.which("soffice")
        if soffice:
            return soffice

        return None

    def get_parser(self, ext: str) -> Any:
        return self._parsers.get(ext)

    def get_capabilities(self) -> dict[str, Any]:
        parsers_status = {
            "doc": self._libreoffice_path is not None,
            "docx": "python-docx",
            "pdf": "pdfplumber",
            "pptx": "python-pptx",
            "txt": "built-in",
        }
        return {
            "parsers": parsers_status,
            "libreoffice_path": self._libreoffice_path,
            "version": "1.0.0",
        }

    @staticmethod
    def chunk_text(text: str, max_chunk_size: int = 4000, overlap: int = 200) -> list[dict[str, Any]]:
        if not text:
            return [{"index": 0, "text": ""}]

        chunks: list[dict[str, Any]] = []
        paragraphs = text.split("\n\n")
        current_chunk = ""
        index = 0

        for para in paragraphs:
            if len(current_chunk) + len(para) + 2 <= max_chunk_size:
                if current_chunk:
                    current_chunk += "\n\n" + para
                else:
                    current_chunk = para
            else:
                if current_chunk:
                    chunks.append({"index": index, "text": current_chunk})
                    index += 1
                    overlap_text = current_chunk[-overlap:] if len(current_chunk) > overlap else current_chunk
                    if para.startswith(overlap_text):
                        current_chunk = para
                    else:
                        current_chunk = para
                else:
                    start = 0
                    while start < len(para):
                        end = min(start + max_chunk_size, len(para))
                        chunks.append({"index": index, "text": para[start:end]})
                        index += 1
                        start = end - overlap if end < len(para) else end

        if current_chunk:
            chunks.append({"index": index, "text": current_chunk})

        return chunks