---
name: playwright-web-operator
description: Browser and web automation — navigate, extract, fill forms, verify frontends, run E2E tests
version: 0.1.0
author: DUYA Team
---

# Playwright Web Operator Plugin

Drive a real browser from chat using Microsoft's official
`@playwright/mcp` server. The positioning is **browser and web
automation**, not "a testing tool" — testing is one of five skills, not
the headline. Use this plugin whenever the user needs to interact with
a web page programmatically.

## What this plugin adds

- MCP server `playwright` (stdio) — wraps `@playwright/mcp` (aligned
  with the legacy preset in `src/data/preset-mcp-servers.ts`, which is
  now deprecated in favor of this plugin).
- Five skills:
  - `browser-navigation` — navigate, click, scroll, handle tabs.
  - `structured-extraction` — scrape structured data out of a page.
  - `form-operation` — fill forms, upload files, submit.
  - `frontend-verification` — verify a local page renders and behaves
    (satisfies the AGENTS.md Playwright verification gate).
  - `end-to-end-testing` — generate and run E2E tests from a spec.
- Four workflow templates (YAML drafts, activated when Plan 311 lands):
  operate-webpage, extract-structured-info, verify-local-frontend,
  run-e2e-test.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Navigation and
extraction run automatically. Form submission and file upload require
explicit confirmation before executing — these are the actions most
likely to mutate external state.

## When to suggest this plugin

Suggest when the user wants to drive a browser: scraping a page,
filling a repetitive form, verifying a local UI change rendered
correctly, or generating a regression E2E test. Do NOT suggest this
plugin for static content analysis (use WebFetch) or for headless HTML
parsing without a real browser.
