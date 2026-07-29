---
name: notion-knowledge
description: Notion workspace search, research documentation, meeting knowledge capture, database maintenance, and spec-to-task — read-heavy with strict gate on delete
version: 0.1.0
author: DUYA Team
---

# Notion Knowledge Plugin

End-to-end Notion knowledge work: search the workspace, synthesize
research into a doc, capture meeting notes, maintain databases, and
turn a spec into a task list. Bundles the official Notion MCP server
with five skills that codify how Duya drives Notion from chat.

_status: transitional — Notion offers an official hosted Remote MCP
endpoint at `https://mcp.notion.com`. Until Plan 313 Phase 2a lands
the HTTP transport in `MCPServerConfig`, this plugin ships a stdio
fallback wrapping `@notionhq/notion-mcp-server`. It will migrate to
the hosted endpoint without breaking skills or workflows.

## What this plugin adds

- MCP server `notion` (stdio) — wraps
  `@notionhq/notion-mcp-server` so the agent can search pages,
  read blocks, create pages, update databases, and append comments
  against a Notion workspace.
- Five skills:
  - `workspace-search` — full-text search across the workspace,
    scoped to the integration's shared pages.
  - `research-documentation` — turn a chat thread or research
    notes into a structured Notion doc.
  - `meeting-knowledge-capture` — produce meeting notes with
    decisions, action items, and owners.
  - `database-maintenance` — keep a Notion database tidy: schema
    updates, dedup, archived-item cleanup.
  - `spec-to-task` — turn a spec doc into a database of tasks.
- Four workflow templates (YAML drafts, activated when Plan 311
  lands): search-and-synthesize, organize-conversation-to-doc,
  create-meeting-notes, spec-to-tasks.

## Authentication

The Notion MCP server requires a Notion internal integration token.
The token is scoped to the pages the integration is explicitly
shared with — share the relevant workspace pages with the
integration in Notion's share dialog. The token is stored in the
`notionApiKey` setup field (secret). When the Remote MCP transport
lands, the internal integration token will be exchanged for an
OAuth flow managed by Notion.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Searching
pages, reading blocks, and listing databases run automatically.
Creating or updating a page is `write` tier — confirm with the
user before the first write, and always show the proposed page
title and parent. Archiving a page is `modify` tier — confirm.
Deleting (permanently trashing) a page or a database is
`destructive` tier, strong explicit confirmation.

## When to suggest this plugin

Suggest when the user wants to search or write to a Notion
workspace, capture a meeting, or turn a spec into tasks. Do not
suggest this plugin for generic document writing (use the
workspace file tools) or for project management (use the Linear
plugin).
