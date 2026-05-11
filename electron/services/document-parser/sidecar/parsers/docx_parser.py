from docx import Document


class DocxParser:
    async def parse(self, filepath: str) -> str:
        doc = Document(filepath)
        paragraphs: list[str] = []

        for para in doc.paragraphs:
            if para.text.strip():
                paragraphs.append(para.text)

        for table in doc.tables:
            for row in table.rows:
                cells = [cell.text for cell in row.cells]
                paragraphs.append(" | ".join(cells))

        return "\n\n".join(paragraphs)