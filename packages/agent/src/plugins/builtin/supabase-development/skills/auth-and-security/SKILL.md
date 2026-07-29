# Auth and Security

Audit Supabase auth configuration, RLS coverage, and service-role
key exposure. This skill is the security gate for every Supabase
project — run it before shipping and after any change to auth
providers, RLS policies, or backend code that handles the
service-role key.

## When to use

- The user says "audit auth" / "is this project secure?" / "are we
  leaking data via the API?".
- A new table was added and you need to verify RLS is enabled and
  the policies are correct.
- An Edge Function was deployed that uses the service-role key and
  you need to confirm it doesn't leak the key or expose
  privileged data.

## Process

1. List the project's auth providers via
   `supabase.list_auth_providers`. Confirm only the intended
   providers are enabled. Disable any provider the project does
   not use (every enabled provider is an attack surface).
2. Read the auth configuration via `supabase.get_auth_config`.
   Verify:
   - `SITE_URL` and `API_EXTERNAL_URL` point at the production
     origin, not localhost.
   - `JWT_EXPIRY` is sane (default 3600 is fine; multi-day
     expiries are a risk).
   - `MFA_*` settings match the project's policy.
3. For every table, run `supabase.list_policies` and check:
   - RLS is enabled (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`).
   - Every policy has a predicate (`USING (...)`) — a policy
     without a predicate is "allow all".
   - The `anon` role grants match the intended public surface.
   - The `authenticated` role grants respect
     `auth.uid() = <user_column>`.
4. For every Edge Function, verify the service-role key is not
   exposed in:
   - Response bodies (search the function source for
     `SERVICE_ROLE_KEY` references that get serialized).
   - Client-side code (search the workspace for the literal key
     — it should never appear in a frontend bundle).
   - Logs (`supabase.list_edge_function_logs` should not contain
     the key; if it does, the function is logging it).
5. Report findings as a checklist: provider audit, RLS coverage,
  service-role exposure. Classify each finding as critical / warn /
  info. Propose concrete fixes but do not apply them without
  confirmation — auth changes touch every user.

## Tool call patterns

- `supabase.list_auth_providers` returns the enabled providers.
  Cross-check with the project's intended auth surface — every
  extra enabled provider is an attack surface.
- `supabase.get_auth_config` returns the auth server settings.
  Look for `external_url`, `site_url`, `jwt_expiry`,
  `mailer_otp_exp`, `mfa_enabled`.
- `supabase.list_policies(table)` returns RLS policies. Pair with
  `supabase.list_tables` to iterate every table — missing tables
  in the audit is a common gap.
- `supabase.list_edge_function_logs(name, status >= 400)` finds
  failing invocations. Look for stack traces that include the
  service-role key.

## Confirmation boundary

- Reading providers, policies, and logs: `read` tier, automatic.
- Updating auth configuration via `supabase.update_auth_config`:
  `write` tier, confirm. Show the diff before applying.
- Altering an auth provider (enable/disable) via
  `supabase.alter_auth_provider`: `modify` tier, confirm.
  Disabling a provider logs out every user authenticated via it.
- Rotating the service-role key via `supabase.rotate_service_key`:
  `destructive` tier, strong explicit confirmation. Rotation
  invalidates every backend using the old key; coordinate the
  deploy of updated backends before rotating.

## Pitfalls

- A table with `FORCE ROW LEVEL SECURITY` applied enforces RLS
  even for the table owner. Without `FORCE`, the `postgres`
  superuser and the table owner bypass RLS. Verify which mode each
  table is in.
- `auth.uid()` returns NULL inside a `BEFORE INSERT` trigger that
  runs as the `postgres` role. Policies that depend on
  `auth.uid()` silently fail to match in this path.
- The `service_role` key is not redacted in Edge Function logs by
  default. Do not log the headers or the env object; log only the
  function's logical state.
- Storing the service-role key in a client-side env file
  (`.env.local`) is fine for local dev but the same file must
  never ship to production. Search the repo for the key prefix
  before reporting "no exposure".
- Supabase's auto-generated PostgREST API exposes every table by
  default. Revoking the `anon` role grant is the only way to
  fully hide a table from the public API — RLS alone leaves the
  schema visible.
