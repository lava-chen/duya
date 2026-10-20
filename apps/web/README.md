# Duya local Web transport

This workspace currently provides the T40a Node BFF and a browser client that
mounts `@duya/ui` (see `src/main.tsx`). It connects to an existing standalone
Host and listens only on `127.0.0.1`.

Start the local Host with `duya serve`, then from the repository root:

```sh
npm run build:web-app
npm run web-app
```

The BFF discovers the standard Host runtime descriptor beneath
`DUYA_DATA_ROOT` (default `~/.duya`). `DUYA_HOST_ORIGIN` plus `DUYA_HOST_TOKEN`
can override discovery for another local Host. Neither is a browser setting.
`DUYA_WEB_PORT` optionally selects a port; the default is ephemeral.

Browser API routes:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/bootstrap` | Per-process CSRF token, never the Host bearer |
| GET | `/api/handshake` | Protocol/capability summary |
| GET | `/api/sessions` | Session list |
| GET | `/api/sessions/:id` | Session record |
| GET | `/api/sessions/:id/messages` | Messages with optional cursor/limit |
| GET | `/api/sessions/:id/runs` | Run list |
| GET | `/api/sessions/:id/approvals` | Pending worker permission requests |
| POST | `/api/runs/start` | Start `{sessionId, prompt}` |
| POST | `/api/runs/:id/cancel` | Cancel, optional `{reason}` |
| POST | `/api/approvals/:id/resolve` | `{decision: "allow" | "always" | "deny"}` |
| GET | `/api/runs/:id/events` | SSE; `afterSeq` or `Last-Event-ID` |

Mutation requests require exact same-origin `Origin`, JSON content type,
and `x-duya-csrf` from bootstrap. Cross-site fetches and foreign Host headers
are rejected. The server exposes no arbitrary proxy and adds no CORS grants.
SSE preserves Host envelopes/sequence numbers and aborts the upstream reader
on browser disconnect. This slice includes no App iframe,
remote deployment, or authentication for network access.

Tests use a real Host HTTP listener and temporary SQLite storage. Run
start/cancel mapping uses a controlled execution port; approval tests resolve
the real permission-request ledger with a simulated polling waiter. A full
worker/browser chat and refresh-recovery acceptance remain subsequent work.
