import os


class TxtParser:
    async def parse(self, filepath: str) -> dict:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            return {"text": f.read(), "extractMethod": "text"}