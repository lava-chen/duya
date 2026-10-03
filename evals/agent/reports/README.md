# evals/agent/reports

Generated eval output. **Gitignored**, deliberately.

A report names a HEAD, a wall clock, a node version, a platform and a SQLite ABI.
None of that is source, and all of it differs on every machine and every run — so
committing a report produces a diff that is noise on the commit that changed a
case and stale on the next commit that did not.

The report's *shape* is covered by tests (`suite.test.ts` asserts the totals, the
layer histogram, the exit-code policy and the `determinism` label on synthetic
reports), so nothing is lost by not tracking an instance. What a human reads is
produced on demand:

```bash
npm run eval:agent:smoke                          # -> reports/smoke.json
npm run eval:agent:extended                       # -> reports/extended.json
node scripts/eval-agent.mjs smoke --out /tmp/r.json
```

If an instance of a report needs to be shared or attached to a review, the report
file itself is the artefact — copy it, do not commit it. Its `environment` block
and `suiteId` are what make it attributable later.
