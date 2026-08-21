---
name: skill-creator
description: "Guide for creating effective DUYA skills. Use when the user wants to create a new skill or update an existing one that extends DUYA with specialized knowledge, workflows, or tool integrations."
allowed-tools: "Bash, Read, Write, Edit, Glob, Grep"
user-invocable: true
---

# Skill Creator

Guide for designing effective DUYA skills.

## About Skills

Skills are modular, self-contained folders that extend DUYA by providing
specialized knowledge, workflows, and tools. They act as onboarding guides for
a domain or task — turning DUYA from a general-purpose agent into a specialized
one equipped with procedural knowledge that no model fully possesses.

## Duya skill anatomy

Every DUYA skill is a folder with a required `SKILL.md` plus optional bundled
resources:

```
skill-name/
├── SKILL.md          (required)  YAML frontmatter + Markdown instructions
├── scripts/          (optional)  Executable code (Python/Bash/etc.)
├── references/       (optional)  Docs loaded into context as needed
└── assets/           (optional)  Files used in output (templates, icons)
```

**SKILL.md frontmatter** — DUYA reads these fields to decide when to trigger:

- `name` (required) — lowercase, kebab-case, matches the folder name
- `description` (required) — the primary trigger; describe what it does AND
  the specific contexts/triggers for when to use it. Put all "when to use"
  guidance here, not in the body (the body only loads after triggering).
- `allowed-tools` (optional) — comma-separated Bash tool allowlist
- `user-invocable` (optional) — `false` hides it from the user-invocable list
- `platforms` (optional) — platform restrictions

Body (Markdown) is only loaded after the skill triggers. Keep it imperative.

## Core Principles

### Concise is key

The context window is a public good. Skills share it with the system prompt,
conversation history, other skills' metadata, and the real user request.
DUYA is already very smart — only add context it doesn't have. Ask of each
line: "Does DUYA really need this?" and "Does this justify its token cost?"
Prefer a concise example over a verbose explanation.

### Set appropriate degrees of freedom

Match specificity to the task's fragility and variability:

- **High freedom (text instructions)** — multiple approaches valid, decisions
  depend on context, or heuristics guide the approach.
- **Medium freedom (pseudocode / parameterized scripts)** — a preferred
  pattern exists, some variation is OK, config affects behavior.
- **Low freedom (specific scripts, few parameters)** — fragile, error-prone,
  consistency-critical, or a specific ordered sequence must be followed.

Think of DUYA as walking a path: a narrow bridge with cliffs needs guardrails
(low freedom); an open field allows many routes (high freedom).

### Protect validation integrity

You may use subagents to validate whether a skill works on realistic tasks or
whether a suspected problem is real. Treat that as an evaluation surface: the
goal is to learn whether the skill generalizes, not whether another agent can
reconstruct the answer from leaked context. Prefer raw artifacts (prompts,
outputs, diffs, logs, traces) and give the minimum task-local context needed.
Avoid passing the intended answer, suspected bug, intended fix, or prior
conclusions unless validation explicitly needs them.

## Progressive Disclosure

Use a three-level loading system to manage context:

1. **Metadata (name + description)** — always in context (~100 words)
2. **SKILL.md body** — when the skill triggers (<5k words)
3. **Bundled resources** — as needed (scripts run without loading into context)

Keep the body under 500 lines. When a skill supports multiple variants,
frameworks, or options, keep only the core workflow and selection guidance in
SKILL.md and move variant-specific details into reference files. Reference
files should link directly from SKILL.md (one level deep) and, if longer than
~100 lines, include a table of contents.

## What NOT to include

A skill should contain only essential files. Do NOT add README.md,
INSTALLATION_GUIDE.md, CHANGELOG.md, or similar auxiliary docs — they add
clutter without helping the agent. Information lives in either SKILL.md or a
reference file, not both; prefer references for detailed material.

## Skill Creation Process

1. **Understand with concrete examples.** Clarify what the skill should do and
   how it will be used. Ask the most important questions first, then follow up.
   Conclude once the functionality is clear.
2. **Plan reusable contents.** For each example, decide what scripts,
   references, and assets would help when the workflow is repeated.
3. **Create the skill folder.** Choose a location:
   - Built-in (ships with DUYA): `packages/agent/skills/<category>/<skill>/`
   - User: `~/.duya/skills/<skill>/`
   - Project: `.agent/skills/<skill>/` (cross-agent standard) or
     `.duya/skills/<skill>/`
   Create the folder and a `SKILL.md` with frontmatter + a body outline.
4. **Edit the skill.** Write it for another DUYA instance to use. Start with
   the reusable resources (scripts/references/assets), then write SKILL.md.
   Use imperative form. Keep the body lean and reference files for detail.
   Test any scripts you add by actually running them.
5. **Validate.** Re-read the skill with fresh eyes: does the description
   trigger correctly? Is the body under control? Do references resolve? If
   complex, forward-test with a subagent.
6. **Iterate.** Use the skill on real tasks, notice struggles, tighten
   SKILL.md or resources, and re-test.

### Skill naming

- Lowercase letters, digits, and hyphens only; normalize titles to kebab-case
  (e.g. "Plan Mode" → `plan-mode`).
- Keep names under 64 characters; prefer short, verb-led action phrases.
- Namespace by tool when it improves clarity or triggering (e.g.
  `gh-address-comments`, `wecomcli-msg`).
- Name the skill folder exactly after the skill name.

## Forward-testing

To forward-test, launch a subagent as a user would ask it to do a task, passing
the skill and a realistic request — not your diagnosis. The subagent should
not know it is testing the skill. Prompt like "Use skill-x at /path to solve
problem y", not "Review the skill; pretend a user asks you to...".

Decisions:

- Err on the side of forward-testing.
- Ask for approval if forward-testing would take a long time, need extra
  approvals, or touch live production systems.
- Use fresh threads for independent passes; pass raw artifacts, not your
  conclusions; avoid showing expected answers; clean up artifacts between
  iterations to avoid leaking context.

If forward-testing only succeeds when the subagent sees leaked context, tighten
the skill before trusting the result.

## Related

- Scaffolding a plugin (not just a skill): use the `plugin-development` skill
  and its scripts (`node scripts/create-basic-plugin.mjs`, `validate-plugin.mjs`).