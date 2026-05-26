---
name: reflection-loop
description: "Self-evaluation and iterative improvement methodology. Use after completing work to assess output quality, identify gaps, and generate improvement prompts. Transforms single-pass execution into iterative refinement."
---

# Reflection Loop

A systematic approach to self-evaluation and iterative improvement after completing work.

---

## Core Principle

**The first output is never the best output. Reflection turns good into great.**

Reflection is not self-criticism — it's structured evaluation against explicit criteria to identify improvement opportunities.

---

## Phase 1: Output Assessment

### The Quality Dimensions

Evaluate your output across these dimensions:

| Dimension | Question | Rating (1-5) |
|-----------|----------|--------------|
| **Correctness** | Is it factually accurate? | ⭐⭐⭐⭐⭐ |
| **Completeness** | Does it cover all requirements? | ⭐⭐⭐⭐⭐ |
| **Clarity** | Is it easy to understand? | ⭐⭐⭐⭐⭐ |
| **Relevance** | Does it address the actual need? | ⭐⭐⭐⭐⭐ |
| **Actionability** | Can the user act on it? | ⭐⭐⭐⭐⭐ |
| **Efficiency** | Is it appropriately concise? | ⭐⭐⭐⭐⭐ |

### Assessment Prompts

**Correctness:**
- Are all facts verified?
- Are technical details accurate?
- Are citations/references correct?
- Would an expert agree?

**Completeness:**
- Did I address all parts of the request?
- Are there obvious gaps?
- Did I answer the implicit questions?
- What would a user still need to know?

**Clarity:**
- Is the structure logical?
- Is the language precise?
- Are technical terms explained?
- Would a non-expert understand?

**Relevance:**
- Did I answer what was asked?
- Did I avoid tangent topics?
- Is the level of detail appropriate?
- Does it match the user's context?

**Actionability:**
- Are next steps clear?
- Are there concrete examples?
- Are resources/tools specified?
- Can someone execute without further clarification?

**Efficiency:**
- Is there unnecessary content?
- Could it be said in fewer words?
- Is the signal-to-noise ratio high?
- Would a summary help?

---

## Phase 2: Gap Analysis

### Identify What's Missing

```
GAP ANALYSIS FRAMEWORK

1. EXPLICIT GAPS (user asked, I didn't answer)
   - [ ] Requirement not addressed
   - [ ] Question not answered
   - [ ] Deliverable not produced

2. IMPLICIT GAPS (user needs, but didn't ask)
   - [ ] Context that would help
   - [ ] Prerequisites not mentioned
   - [ ] Common follow-up questions
   - [ ] Edge cases not covered

3. QUALITY GAPS (could be better)
   - [ ] Explanation could be clearer
   - [ ] Examples could be more relevant
   - [ ] Structure could be improved
   - [ ] Depth could be adjusted

4. EXECUTION GAPS (how I worked)
   - [ ] Assumed without verifying
   - [ ] Didn't check for understanding
   - [ ] Missed optimization opportunity
   - [ ] Didn't validate approach
```

### The 5-Why for Gaps

For each significant gap, ask why 5 times:

```
GAP: "Didn't include error handling examples"

Why? → Forgot to consider edge cases
Why? → Focused on happy path
Why? → Rushed to complete main logic
Why? → Didn't allocate time for robustness
Why? → Underestimated scope

ROOT CAUSE: Scope estimation error
FIX: Add buffer time for edge cases in future
```

---

## Phase 3: Improvement Generation

### Generate Improvement Prompts

Transform gaps into specific improvement actions:

```
GAP → IMPROVEMENT PROMPT

Gap: "Explanation of algorithm is too abstract"
Prompt: "Add a concrete walkthrough with real numbers showing each step"

Gap: "No guidance on choosing between options"
Prompt: "Add decision matrix comparing approaches with criteria and recommendations"

Gap: "Code example doesn't handle errors"
Prompt: "Add error handling for [specific cases] with try-catch examples"

Gap: "User might not know prerequisite X"
Prompt: "Add brief explanation of X with link to detailed resource"
```

### Prioritize Improvements

```
PRIORITIZATION MATRIX

High Impact + Low Effort → DO FIRST
- Quick clarifications
- Missing links
- Format improvements

High Impact + High Effort → PLAN
- Major restructuring
- Additional research
- New sections

Low Impact + Low Effort → BATCH
- Minor wording tweaks
- Consistency fixes

Low Impact + High Effort → DEFER
- Nice-to-have additions
- Polishing beyond requirements
```

---

## Phase 4: Iteration Planning

### Decide: Refine or Deliver

```
REFINE IF:
□ Critical gaps exist (correctness, completeness)
□ User explicitly requested iteration
□ Output doesn't meet minimum quality bar
□ Major misunderstanding detected

DELIVER IF:
□ Minor improvements only remain
□ Time budget exhausted
□ User needs quick response
□ Further refinement has diminishing returns
```

### Iteration Scope

```
ITERATION TYPES

Quick Fix (5-10 min):
- Fix obvious errors
- Add missing links
- Clarify confusing sections
- Fix formatting

Medium Revision (30-60 min):
- Restructure for clarity
- Add examples
- Expand thin sections
- Improve explanations

Deep Rewrite (1+ hours):
- Reorganize completely
- Add significant content
- Change approach/strategy
- Research and incorporate new information
```

---

## Phase 5: Reflection Documentation

### Reflection Log Entry

```markdown
## Reflection: [Task Name] - [Date]

### Original Request
[Brief summary of what was asked]

### What I Delivered
[Summary of output]

### Self-Assessment

| Dimension | Score | Notes |
|-----------|-------|-------|
| Correctness | 4/5 | [Notes] |
| Completeness | 3/5 | [Notes] |
| Clarity | 4/5 | [Notes] |
| Relevance | 5/5 | [Notes] |
| Actionability | 3/5 | [Notes] |
| Efficiency | 4/5 | [Notes] |

### Key Gaps Identified
1. [Gap 1]: [Description and impact]
2. [Gap 2]: [Description and impact]
3. [Gap 3]: [Description and impact]

### Root Causes
- [Cause 1]: [Why it happened]
- [Cause 2]: [Why it happened]

### Improvement Prompts Generated
1. [Prompt 1]
2. [Prompt 2]
3. [Prompt 3]

### Action Taken
- [ ] Quick fixes applied
- [ ] Medium revision completed
- [ ] Deep rewrite completed
- [ ] Delivered as-is with notes

### Learnings for Next Time
- [Learning 1]
- [Learning 2]
```

---

## Phase 6: Pattern Recognition

### Track Recurring Issues

```
REFLECTION PATTERNS LOG

Date | Task Type | Gap Type | Root Cause | Fix Applied
-----|-----------|----------|------------|------------
[Date] | Coding | Missing edge cases | Rushed | Added time buffer
[Date] | Writing | Unclear structure | No outline | Now outline first
[Date] | Research | Shallow coverage | Time limit | Scope negotiation
```

### Build Personal Checklists

From your reflection patterns, create custom checklists:

```
MY COMMON GAPS CHECKLIST

Before delivering code:
□ Error handling considered
□ Edge cases identified
□ Tests included
□ Documentation updated

Before delivering writing:
□ Outline reviewed
□ Key points highlighted
□ Examples included
□ Proofread aloud

Before delivering analysis:
□ Assumptions stated
□ Limitations noted
□ Alternatives considered
□ Confidence level indicated
```

---

## Common Pitfalls

### Reflection Errors

1. **Too harsh**: Treating every imperfection as failure
   - Fix: Focus on gaps that matter to the user

2. **Too lenient**: Ignoring obvious improvements
   - Fix: Use explicit criteria, not gut feel

3. **Perfectionism**: Endless iteration on diminishing returns
   - Fix: Set iteration limits, define "good enough"

4. **No follow-through**: Identifying gaps but not fixing them
   - Fix: Generate specific prompts, schedule fixes

### Meta-Pitfalls

1. **Reflection without action**: Analysis paralysis
   - Fix: Every reflection must produce at least one action

2. **Inconsistent reflection**: Only reflecting on failures
   - Fix: Reflect on all significant work

3. **Isolated reflection**: Not connecting patterns across tasks
   - Fix: Maintain pattern log, review periodically

---

## Quick Reference

```
POST-WORK REFLECTION CHECKLIST
□ Assess against 6 quality dimensions
□ Identify explicit gaps
□ Identify implicit gaps
□ Find root causes (5-whys)
□ Generate improvement prompts
□ Prioritize improvements
□ Decide: refine or deliver
□ Document reflection
□ Update personal patterns

QUICK REFLECTION (2 minutes)
□ What was the goal?
□ Did I achieve it?
□ What's the biggest gap?
□ What's one thing to improve?

DEEP REFLECTION (15 minutes)
□ Full quality assessment
□ Complete gap analysis
□ Root cause analysis
□ Multiple improvement options
□ Iteration planning
□ Pattern update
```

---

## Integration with Workflow

### Reflection Triggers

```
AUTOMATIC REFLECTION
□ After completing any multi-step task
□ Before delivering final output
□ When user asks for revision
□ When feeling uncertain about quality

SCHEDULED REFLECTION
□ End of day: Review day's work
□ End of week: Pattern review
□ End of project: Project retrospective
```

### Making Reflection Habit

```
1. SET REMINDER: "Before marking done, reflect"
2. USE TEMPLATE: Don't start from scratch
3. TIME BOX: 5 min quick, 15 min deep
4. ACT ON IT: Every reflection → one action
5. REVIEW PATTERNS: Monthly pattern review
```
