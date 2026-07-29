# Design Context Extraction

Pull the layout, design tokens, and assets of a Figma frame into the
chat context. This skill is the entry point for every other Figma
skill — `design-system-mapping`, `component-implementation`, and
`visual-comparison` all assume the context is already in the
conversation.

## When to use

- The user shares a Figma URL or file key and says "implement this" /
  "look at this design" / "what's in this frame?".
- A downstream skill (`component-implementation`,
  `visual-comparison`) needs the layout, tokens, and assets loaded.
- The user wants a structured summary of a frame without writing any
  code yet.

## Process

1. Parse the Figma URL or file key. A URL like
   `https://www.figma.com/design/<file-key>/<title>?node-id=<node-id>`
   yields both the file key and the target node.
2. Call `figma.get_metadata` on the file to confirm access and read
   the file name, last modified, and component set list.
3. Call `figma.get_code` on the target node. The server returns a
   structured description of the layout (children, styles, text).
   Do not assume the response is a one-shot render — read the
   hierarchy layer by layer for non-trivial frames.
4. Call `figma.get_variable_defs` to collect design tokens (colors,
   spacing, typography). These are the source of truth — do not
   eyeball colors from `get_image`.
5. For icon and image assets, call `figma.get_image` with
   `format=svg` for icons and `format=png` for raster. Cache the
   asset paths; the server rate-limits image fetches.
6. Summarize the extracted context in chat: layout tree, tokens,
   assets. Do not paste raw JSON unless the user asks.

## Tool call patterns

- `figma.get_metadata(file_key)` first to validate access; a 403 here
  means the token lacks Dev Mode scope.
- `figma.get_code(file_key, node_id)` returns the structured layout.
  For deep trees, request children explicitly rather than recursing
  blindly.
- `figma.get_variable_defs(file_key)` returns the variable
  collections. Map them to your project's token format
  (CSS custom properties, Tailwind config, etc.) in the summary.
- `figma.get_image(file_key, node_id, format)` is rate-limited. Batch
  asset fetches and prefer SVG over PNG for icons.

## Confirmation boundary

All tools in this skill are `read` tier and run automatically. If the
user asks to download a full design package to disk (zip of assets +
JSON), treat it as `write` and confirm first — the asset bundle can
be large and pollutes the workspace.

## Pitfalls

- A Figma URL may contain a `node-id` with a `-` separator
  (`1:2` → `1-2`). The MCP server accepts both, but be consistent.
- `figma.get_image` on a frame with nested images returns a flattened
  PNG; request per-asset exports when fidelity matters.
- Variable modes (light/dark, compact/default) change the resolved
  token values. Always note which mode the extraction is from.
- The Figma Dev Mode MCP Server requires the desktop app to be
  running for some endpoints. If `get_code` returns a connection
  error, fall back to the REST API or ask the user to open Figma.
