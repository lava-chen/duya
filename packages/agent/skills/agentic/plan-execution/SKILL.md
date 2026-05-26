---
name: plan-execution
description: Structured methodology for reading, interpreting, and executing pre-written task plans — including YAML task lists, Markdown checklists, structured project files, or any document that defines a sequence of steps the agent should carry out. Use this skill whenever the user provides or references a plan file, task list, execution spec, or work breakdown structure for the agent to follow. Also trigger when the user says things like "execute this plan", "work through these steps", "follow the spec", "carry out the tasks in", or "implement the plan". This skill is essential for harness-style agent workflows where a planner has already done the decomposition and the agent's job is faithful, traceable execution.
allowed-tools: [Read, Write, SearchReplace, Glob, Grep, RunCommand]
---

# Plan Execution

This skill governs how to interpret and faithfully execute a pre-written plan. The core discipline is: **read the whole plan before doing anything, then execute with precision, transparency, and the ability to recover from failure**.

## The Fundamental Obligation

When given a plan to execute, your job is to carry it out — not to redesign it. Resist the temptation to:
- Reorder steps because a different order "seems better"
- Skip steps that seem trivial or redundant
- Combine steps to save time
- Expand steps beyond what they specify

If you believe a step is wrong or should be changed, **flag it before executing**, not after. Unilateral deviation from a plan without surfacing it is a correctness failure, not a quality improvement.

---

## Phase 1: Plan Ingestion

Before executing any step, read and analyze the entire plan.

### 1.1 Parse the structure

Identify:
- **Total number of steps / tasks**
- **Dependencies**: which steps must precede others
- **Parallel opportunities**: steps with no dependency on each other
- **Ambiguities**: steps whose success criteria are unclear
- **Risks**: steps that are irreversible or have significant side effects

### 1.2 Classify each step

For each step, determine:

| Type | Description | Implication |
|------|-------------|-------------|
| **Deterministic** | Output is fully specified | Execute, verify against spec |
| **Generative** | Output requires judgment | Clarify criteria before executing |
| **Irreversible** | Cannot be undone (delete, publish, send) | Confirm before executing |
| **Blocked** | Depends on output of a prior step | Note dependency, do not skip ahead |
| **External** | Requires a tool, API, or human action | Check availability before starting |

### 1.3 Surface ambiguities before starting

If any step is unclear, raise **all ambiguities at once** before beginning execution. Do not discover ambiguities mid-execution and stop — this is maximally disruptive.

Format ambiguity questions as:
```
Before I begin, I need to clarify [N] points:

Step 3 ("Deploy to staging"): Which environment URL / credentials should I use?
Step 7 ("Update documentation"): Should I update the README only, or all docs in /docs?
```

Wait for resolution before proceeding.

---

## Phase 2: Execution

### 2.1 Announce the execution plan

Before the first step, briefly state what you're about to do:
```
Executing [plan name / description].
Total steps: N. Estimated irreversible actions: [list them].
Beginning with Step 1.
```

This gives the user one final chance to redirect before work begins.

### 2.2 Step execution protocol

For each step:

1. **Announce**: "Executing Step N: [step title]"
2. **Execute**: Do precisely what the step specifies, no more, no less
3. **Verify**: Check that the output matches the step's success criteria
4. **Record**: Write a brief outcome note (see checkpoint protocol below)
5. **Advance**: Move to the next step, or handle failure (see Phase 3)

### 2.3 Checkpoint protocol

After every step (or every N steps for large plans), write a checkpoint entry:

```
## Checkpoint — Step N Complete
- Status: ✓ Success / ✗ Failed / ⚠ Partial
- Output: [brief description of what was produced]
- Notes: [anything that deviated from expectation, even if minor]
- Next: Step N+1 — [title]
```

For multi-session or long-running plans, write checkpoints to a file (`plan-status.md` or similar) so execution can be resumed from the correct point if interrupted.

### 2.4 Handling parallel steps

When multiple steps have no dependency on each other and tools support parallelism:
- Group and execute them together
- Report results of all parallel steps before advancing
- If any parallel step fails, pause all others and report before continuing

---

## Phase 3: Failure Handling

Failures are expected. The key is: **never silently continue past a failed step**.

### 3.1 Failure classification

| Failure type | Response |
|-------------|----------|
| **Transient** (network timeout, rate limit) | Retry up to 3× with backoff, then escalate |
| **Input error** (wrong format, missing data) | Stop, report, request corrected input |
| **Logic error** (step output doesn't match expectation) | Stop, diagnose, report hypothesis, await instruction |
| **Blocked dependency** (prior step didn't produce needed output) | Stop, report which dependency is missing |
| **Irreversible side effect** (something unintended happened) | Stop immediately, report exact state, await instruction |

### 3.2 Failure report format

```
⚠ Step N Failed: [step title]

What I tried: [exact action taken]
What happened: [exact error or unexpected output]
Current state: [what exists / has been modified so far]
My hypothesis: [why I think this happened]
Options:
  A) [retry with modification X]
  B) [skip this step and note it]
  C) [abort execution and preserve current state]

Awaiting your decision.
```

Do not guess which option to take on a failure unless the plan explicitly specifies a fallback.

### 3.3 Rollback awareness

Before executing any irreversible step, identify:
- What is the rollback procedure if this goes wrong?
- Can this be done in a dry-run / preview mode first?

If no rollback is possible and the action is high-risk, **explicitly warn** before proceeding:
```
⚠ Step N is irreversible: [description of permanent effect].
I will proceed in 10 seconds unless you say stop.
```

---

## Phase 4: Completion

### 4.1 Completion summary

When all steps are complete (or when execution terminates for any reason), produce a summary:

```
## Execution Complete

Plan: [name]
Status: ✓ All N steps completed / ✗ Stopped at Step M / ⚠ N steps with warnings

Results:
- Step 1: ✓ [brief outcome]
- Step 2: ✓ [brief outcome]
- Step 3: ⚠ [completed with deviation: ...]
- Step 4: ✗ [failed: ...]

Artifacts produced: [list files, URLs, resources created]
Deviations from plan: [any steps where execution differed from spec]
Recommended follow-up: [anything the plan didn't cover that seems important]
```

### 4.2 Deferred items

If any step was skipped or deferred, include a clear deferred items list:
```
## Deferred / Incomplete

- Step 7: Skipped — [reason]. Action needed: [what human must do].
- Step 12: Partial — [what was done, what remains].
```

---

## Special Cases

### Resuming an interrupted execution

If given a plan and a previous checkpoint file:
1. Read the checkpoint to determine last completed step
2. Verify the current state matches what the checkpoint records
3. If state matches: resume from next step
4. If state is inconsistent: report the discrepancy before resuming

### Plan has conflicting instructions

If two steps contradict each other:
- Do not pick one silently
- Report the conflict: "Step 3 says X, Step 8 says the opposite. Which takes precedence?"
- Await resolution before executing either conflicting step

### Plan is underspecified

If a step says something like "improve the code quality" with no criteria:
- Ask: "What specific quality attributes matter? (readability, performance, test coverage, style compliance)"
- Do not proceed with a vague instruction — the output will be unverifiable

### Nested plans / sub-plans

If a step references another plan or spec file:
- Read that file before executing the parent step
- Apply this same execution protocol recursively
- Report completion of sub-plan before advancing in parent

---

## What Good Execution Looks Like

A well-executed plan leaves a clear audit trail:
- Every step's outcome is recorded
- Deviations (even minor) are noted
- The final state of all artifacts is documented
- A human could reconstruct exactly what happened from the execution log

If you would be uncomfortable showing your execution log to the person who wrote the plan, something is wrong.