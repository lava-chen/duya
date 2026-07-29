# Edge Function Workflow

Scaffold, test, and deploy Supabase Edge Functions with the correct
auth context. Edge Functions run on Deno Deploy and have a different
runtime and security model than a typical Node service — this skill
codifies the patterns that prevent the common footguns.

## When to use

- The user says "write an Edge Function that ..." / "deploy the
  webhook handler to Supabase".
- A backend operation needs to run with the service-role key or
  needs to be invoked from a Supabase Auth trigger (e.g. new-user
  webhook).
- An existing Edge Function needs a behavior change and a redeploy.

## Process

1. Confirm the function name and the project's Edge Function
   directory layout (`supabase/functions/<name>/index.ts` by
   convention). Read the existing functions to match the project's
   patterns (logging, error response shape, auth header parsing).
2. Scaffold the function with the canonical structure:
   - `serve(async (req) => { ... })` entry point.
   - `Authorization: Bearer <jwt>` header parsing via
     `supabase.auth.getUser()` when the function should respect
     RLS.
   - Service-role client creation via
     `createClient(url, SERVICE_ROLE_KEY, { auth: { persistSession:
     false } })` when the function needs to bypass RLS — and
     document why.
3. Implement the handler. Use `std/http` for routing; do not pull
   in Node-only modules (`fs`, `path`) — Deno Deploy does not have
   them.
4. Test locally with `supabase functions serve` when available.
   Otherwise, write a small test that invokes the function via
   `fetch` against the local endpoint and asserts on the response
   shape.
5. Deploy via `supabase.deploy_edge_function(name, code)`. The
   deploy is atomic — a failed deploy leaves the previous version
   serving. Confirm the deploy with the user before invoking.
6. After deploy, fetch the function logs via
   `supabase.list_edge_function_logs` to verify the first
   invocation behaves as expected. Surface errors in chat with the
   log line that triggered them.

## Tool call patterns

- `supabase.list_edge_functions` returns deployed functions with
  their current version. Use it to confirm a redeploy is updating
  the right function.
- `supabase.get_edge_function(name)` returns the function's
  metadata (created_at, version, slug). It does not return the
  source code — keep the source in the project repo.
- `supabase.deploy_edge_function(name, code)` deploys from a
  string. For multi-file functions, bundle them into a single
  `index.ts` or use the Supabase CLI's `functions deploy` from
  the workspace shell.
- `supabase.list_edge_function_logs(name, limit)` returns recent
  invocation logs. Filter by `status >= 400` to find failures.

## Confirmation boundary

- Reading existing functions and logs: `read` tier, automatic.
- Writing the function file to disk: `write` tier, confirm the
  path with the user before the first write.
- Deploying the function: `modify` tier, confirm. Show the user
  the function name, the auth context (user JWT vs service-role),
  and a one-line summary of the change before the deploy call.
- Deleting a function: `destructive` tier, strong explicit
  confirmation. Functions are often referenced by webhooks or
  client code — deleting one breaks callers silently.

## Pitfalls

- Edge Functions run with a global Deno namespace. Module-level
  state persists across invocations within the same isolate, which
  causes stale config when env vars rotate. Read env vars inside
  the handler, not at module top-level.
- `import` from npm packages must use the `npm:` specifier
  (`import { createClient } from "npm:@supabase/supabase-js@2"`).
  Bare imports fail at deploy time.
- The service-role key bypasses RLS. Never log the key, never
  return it in a response, and prefer the user JWT when the
  operation can be RLS-scoped.
- Edge Function execution time is capped (currently 150s on
  Supabase's hosted platform). Long-running work must be chunked
  or offloaded to a queue.
- CORS is the function's responsibility. Add
  `Access-Control-Allow-Origin` headers explicitly; the Supabase
  hosted endpoint does not add them.
- `req.json()` consumes the body. Read it once and reuse the
  value; reading twice throws.
