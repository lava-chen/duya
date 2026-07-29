---
name: figma-design
description: Figma design context extraction, component mapping, implementation, and visual verification
version: 0.1.0
author: DUYA Team
---

# Figma Design Plugin

Bridge Figma designs and front-end code: extract design context from a
file, map it to a design system, implement the components, compare the
result against the source of truth, and write annotations back to Figma.
Bundles the official Figma MCP server with five skills that codify how
Duya drives Figma from chat.

_status: transitional — the Figma official Remote MCP endpoint
(`https://mcp.figma.com/cmc`) is the long-term transport. Until Plan 313
Phase 2a lands the HTTP transport in `MCPServerConfig`, this plugin
ships a stdio fallback wrapping the Figma Dev Mode MCP Server. It will
migrate without breaking skills or workflows.

## What this plugin adds

- MCP server `figma` (stdio) — wraps the Figma Dev Mode MCP Server so
  the agent can call `get_code`, `get_image`, `get_metadata`,
  `get_variable_defs`, `create_comment`, and `create_annotation`
  against a Figma file.
- Five skills:
  - `design-context-extraction` — pull the layout, tokens, and assets
    of a Figma frame into the chat context.
  - `design-system-mapping` — map Figma components/styles to the
    project's existing component library.
  - `component-implementation` — turn a Figma node into a working
    frontend component (React/Vue/etc.).
  - `visual-comparison` — capture the rendered implementation and
    compare it side-by-side with the Figma source.
  - `write-back-to-figma` — push annotations or comments back to the
    Figma file to close the loop with the designer.
- Four workflow templates (YAML drafts, activated when Plan 311 lands):
  implement-from-figma, extract-design-tokens,
  compare-implementation-vs-design, write-back-to-figma.

## Authentication

The Figma MCP server requires a Figma personal access token. Prefer a
**scoped Dev Mode token** over a long-lived full-scope token. Store the
token in the `figmaApiKey` setup field — it is treated as a secret and
never logged. When the Remote MCP transport lands, the token will be
exchanged for an OAuth flow managed by Figma; the stdio PAT path will
be retired.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Reading files,
frames, variables, and assets runs automatically. Writing comments and
annotations back to Figma is `modify` tier — confirm with the user
before the first write, and always show the proposed annotation text.
Deleting a Figma node or file is not exposed by this plugin; if the
underlying server adds it, it will be pinned to the `destructive` tier.

## When to suggest this plugin

Suggest when the user is implementing a UI from a Figma file, auditing
a design system, or closing the loop between design and code. Do not
suggest this plugin for general image inspection (use WebFetch or the
Playwright plugin) or for Figma account administration.
