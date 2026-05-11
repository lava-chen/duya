import asyncio
import json
import os
import signal
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from registry import ParserRegistry

registry = ParserRegistry()
running = True
_stdin_executor: ThreadPoolExecutor | None = None


async def send_json(data: dict[str, Any]) -> None:
    line = json.dumps(data, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


async def send_progress(req_id: int, progress: float) -> None:
    await send_json({
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {"status": "parsing", "progress": progress},
    })


async def send_result(
    req_id: int,
    char_count: int,
    chunks: list[dict[str, Any]],
    extract_method: str | None = None,
) -> None:
    result: dict[str, Any] = {
        "status": "done",
        "charCount": char_count,
        "chunks": chunks,
    }
    if extract_method:
        result["extractMethod"] = extract_method
    await send_json({
        "jsonrpc": "2.0",
        "id": req_id,
        "result": result,
    })


async def send_error(req_id: int, code: int, message: str) -> None:
    await send_json({
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    })


async def handle_parse(req_id: int, params: dict[str, Any]) -> None:
    filepath = params.get("path", "")
    if not filepath:
        await send_error(req_id, -32602, "Missing required parameter: path")
        return

    if not os.path.isfile(filepath):
        await send_error(req_id, -32602, f"File not found: {filepath}")
        return

    ext = os.path.splitext(filepath)[1].lower()
    parser = registry.get_parser(ext)

    if parser is None:
        await send_error(req_id, -32603, f"Unsupported format: {ext}")
        return

    try:
        await send_progress(req_id, 0.1)
        raw_result = await parser.parse(filepath)
        await send_progress(req_id, 0.8)

        if isinstance(raw_result, dict):
            text = raw_result.get("text", "")
            images: list[dict[str, Any]] = raw_result.get("images", [])
            extract_method: str | None = raw_result.get("extractMethod")

            text_chunks = registry.chunk_text(text)

            image_chunks: list[dict[str, Any]] = []
            for idx, img in enumerate(images):
                image_chunks.append({
                    "type": "image",
                    "index": len(text_chunks) + idx,
                    "base64": img["base64"],
                    "mediaType": img.get("mediaType", "image/png"),
                })

            chunks = text_chunks + image_chunks
            await send_progress(req_id, 1.0)
            await send_result(req_id, len(text), chunks, extract_method)
        else:
            text = str(raw_result)
            chunks = registry.chunk_text(text)
            await send_progress(req_id, 1.0)
            await send_result(req_id, len(text), chunks)
    except Exception as e:
        error_msg = str(e) or type(e).__name__
        await send_error(req_id, -32603, f"Parse failed: {error_msg}")


async def handle_request(request: dict[str, Any]) -> None:
    req_id = request.get("id")
    method = request.get("method", "")

    if method == "parse":
        await handle_parse(req_id, request.get("params", {}))
    elif method == "health":
        await send_json({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"status": "ok"},
        })
    else:
        await send_error(req_id, -32601, f"Unknown method: {method}")


async def read_stdin() -> None:
    loop = asyncio.get_event_loop()
    global _stdin_executor
    _stdin_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stdin")

    while running:
        try:
            line_bytes = await loop.run_in_executor(_stdin_executor, sys.stdin.buffer.readline)
            if not line_bytes:
                break

            line_str = line_bytes.decode("utf-8").strip()
            if not line_str:
                continue

            try:
                request = json.loads(line_str)
                asyncio.create_task(handle_request(request))
            except json.JSONDecodeError:
                await send_error(None, -32700, "Parse error: invalid JSON")
        except EOFError:
            break
        except OSError:
            break
        except Exception:
            traceback.print_exc(file=sys.stderr)
            break


def shutdown() -> None:
    global running
    running = False


async def main() -> None:
    capabilities = registry.get_capabilities()
    await send_json({"type": "capabilities", **capabilities})

    signal.signal(signal.SIGTERM, lambda _s, _f: shutdown())
    signal.signal(signal.SIGINT, lambda _s, _f: shutdown())

    await read_stdin()


if __name__ == "__main__":
    asyncio.run(main())