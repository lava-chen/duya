---
name: browser-automation
description: Drive real web pages on the user's behalf with the duya browser tool — fill and submit forms, walk multi-step flows, upload files, work across tabs, and confirm that each action actually landed. Covers the irreversible-write gate for payments, orders, credentials, account deletion and social posting, the verify-after-every-write discipline, stale refs after re-render, native dialog recovery, and the operations that are deliberately hidden from the tool schema. Use when the user asks you to log in, fill in a form, submit something, book or buy, post to a site, upload a file, or generally act on a website rather than just read it.
allowed-tools: browser, vision_analyze, Read, Write
---

# Web automation

Act on a live website on the user's behalf, and never claim an action
succeeded without checking that it did.

## Duya capability binding

The `browser` tool drives a real Chromium session over CDP and degrades
gracefully (extension -> sidebar webview -> static fetch) when a transport is
unavailable. It ships inside duya as `@duya/browser`, so there is nothing to
install, connect, or authenticate.

The tool publishes its own capability guide. **Read it once before your first
call**, in two steps: find the tool, then read it by its stable id.

```json
{"tool_id": "<the browser tool's stable tool_id>"}
```

Look that id up first with `{"query": "browser"}` or
`{"namespace": "builtin"}` rather than guessing it — `tool_catalog` accepts
only `query`, `tool_id`, `namespace` and `cursor`, and rejects any other
argument. The `tool_id` response carries `usage_guide`: the tool's own
operating manual. Read it before the first call — it documents the
operations, required arguments, and the failure modes that matter.

That guide is the single source of truth for the operation list, parameter
shapes, the ref-based versus coordinate-driven interaction paradigms, and the
safety rules. This skill carries what the guide cannot: the discipline for
multi-step flows and the approval posture for irreversible writes. Where this
skill and the guide appear to disagree, the guide wins.

## The one rule

**Observe -> act -> verify. Never assume a click worked.**

`navigate` already returns a `compactSnapshot` plus interactive refs, so
start there rather than calling `snapshot` immediately. After any action that
can change the page — `click`, `type` with `submit`, `select`, `press_key`,
`go_back`, `scroll_to` — re-observe and confirm the state moved the way you
intended before building the next step on top of it.

A click that returns without error may have opened a menu, submitted a form,
hit a dead link, or done nothing at all. The return value is not proof.

## Refs go stale

Refs (`@1`, `@2`, ...) are positions in a snapshot, not durable handles. Any
re-render, SPA route change, or modal invalidates them, and a stale ref
either fails or — worse — hits the wrong element.

Snapshot again after the page changes. If a `click` on a ref suddenly targets
something unrelated, that is a stale ref, not a mis-planned step: re-snapshot
and re-target rather than retrying the same ref.

## Filling a form

1. Snapshot and identify every field by its label, not by its position.
2. Type into one field at a time. Do not batch a whole form into one call.
3. Use `select` for dropdowns and `file_upload` for attachments — typing
   into a `<select>` or a file input silently does nothing.
4. `file_upload` is the exception to the ref rule: it takes a **CSS
   selector**, not a ref, plus absolute paths.

   ```json
   {"operation": "file_upload", "selector": "input[type=file]", "files": ["E:/Projects/report.pdf"]}
   ```

   Paths must be absolute and the files must already exist. Never invent a
   path, and never upload a file the user has not pointed you at.
5. Use `submit: true` on the **last** field only. Submitting early locks in a
   half-filled form and usually costs you the whole flow.
6. Verify the submit landed: a success page, a confirmation banner, or a
   changed URL. If none of those appear, assume it failed and read the page's
   error output.

Required fields, format validation, and CAPTCHA are the usual causes of a
silent no-op submit. Read the validation message before retrying — a blind
retry repeats the same mistake.

## The irreversible-write gate

Some actions cannot be undone. For any of these, do every reversible part
first, then stop and ask with the exact detail spelled out:

- Final payment, order placement, or booking
- Submitting credentials on a login or signup form
- Account deletion, plan downgrade, or subscription cancellation
- Sending a message to another person, or posting publicly

A result that carries a `safetyNote` means the host is already flagging the
step. When you see one: stop, state exactly what will happen and to whom, and
wait for explicit confirmation. Do not batch the approval request with a
question the user did not ask.

This plugin's permission policy is declared in `permissions/policy.json`:
write actions and destructive actions both require approval. Expect the
runtime to prompt, and structure your work so the user is asked **once**, at
the last irreversible step, rather than repeatedly through a long form.

## Posting to social platforms

Two operations publish content and are **deliberately absent from the
`operation` enum in the tool schema**. They are not in the schema so the model
does not self-advertise an irreversible public write; dispatch by operation
name still works, and the tool's guide tells the model they exist.

`post` — publish to a supported platform:

```json
{"operation": "post", "platform": "x", "text": "...", "images": [], "replyTo": "optional status URL or numeric id"}
```

`platform` is one of `x` | `twitter` | `weibo` | `linkedin`.

`twitter_post` — the X.com-specific path, which supports up to 4 images
(jpg/png/gif/webp):

```json
{"operation": "twitter_post", "text": "...", "images": [], "replyTo": "optional status URL or numeric id"}
```

Both require the user to already be signed in on that platform in the visible
browser. Read the composed draft back before publishing, confirm the text and
any attached image paths with the user, and only then publish. A published
post is visible to that audience immediately and cannot be recalled cleanly.

## Multi-tab work

Use tabs when tasks are genuinely independent, not to accumulate clutter:

```json
{"operation": "tabs_list"}
{"operation": "tabs_new", "url": "https://example.com"}
{"operation": "tabs_select", "target": 1}
{"operation": "tabs_close", "target": 1}
```

`target` is a tab index or tab id, and is optional on `tabs_close` (it
defaults to the current tab).

Track which tab you are acting in. After switching, re-snapshot — refs belong
to the page you snapshotted, and a ref from another tab targets nothing.

## When actions stop having any effect

A native JavaScript dialog blocks the page until it is answered, which makes
every subsequent interaction look like a silent no-op. If a click "does
nothing" and the page state is frozen:

```json
{"operation": "handle_dialog", "action": "accept"}
{"operation": "handle_dialog", "action": "dismiss"}
```

`action` is `accept` (OK / confirm) or `dismiss` (cancel / close), with
`promptText` for `prompt()` dialogs.

**Never accept a dialog that requests system-level or administrator
authorization.** Dismiss it and report it to the user.

## Operations that need a real transport

These fail outright in fallback mode (no CDP transport) with an error rather
than degrading: `file_upload`, `cookies`, `network_start`, `network_read`,
and the whole coordinate-driven set (`click_at`, `drag`, `key_combo`,
`mouse_move`, `scroll_to`). If you hit that error, you are in a static-fetch
mode: re-establish a real browser session before retrying, or tell the user
the action cannot be performed right now.

`cookies` takes an optional `domain` or `url` filter. Use it to check whether
a session is signed in before attempting a flow that needs one — do not guess
at login state by attempting a privileged page and reading the redirect.

## Output standards

- Report what you did as a sequence of completed steps, not intentions.
- Name the page and URL for every write, so the user can audit it.
- For a blocked flow, name the exact gate: approval required, CAPTCHA,
  validation error, login wall, dialog blocking, or transport unavailable.
- If a step's outcome is uncertain, say uncertain. Do not round up to
  "done".

## Cleanup

Call `{"operation": "close_window"}` when the task is finished, including
after a failure you are abandoning. It closes the automation window and
releases the page resources.
