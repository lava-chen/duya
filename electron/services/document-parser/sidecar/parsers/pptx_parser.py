from pptx import Presentation


class PptxParser:
    async def parse(self, filepath: str) -> str:
        prs = Presentation(filepath)
        slides_text: list[str] = []

        for slide_num, slide in enumerate(prs.slides, 1):
            slide_parts: list[str] = [f"--- Slide {slide_num} ---"]

            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        if para.text.strip():
                            slide_parts.append(para.text)

                if shape.has_table:
                    table = shape.table
                    for row in table.rows:
                        cells = [cell.text for cell in row.cells]
                        slide_parts.append(" | ".join(cells))

            slides_text.append("\n".join(slide_parts))

        return "\n\n".join(slides_text)