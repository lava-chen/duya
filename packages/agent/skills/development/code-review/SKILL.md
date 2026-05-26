---
name: code-review
description: "Systematic code review methodology. Use when reviewing code for correctness, quality, security, or maintainability. Provides checklists for different review aspects and guidance on giving constructive feedback."
---

# Code Review

A systematic approach to reviewing code that improves quality while maintaining team velocity.

---

## Core Principle

**Code review is not about finding faults — it's about building shared understanding and improving the codebase together.**

---

## Phase 1: Preparation

### Before Reviewing

```
PREPARATION CHECKLIST

□ Understand the context
  - What problem does this solve?
  - Why was this approach chosen?
  - Are there related PRs/issues?

□ Check scope
  - How large is the change?
  - Is it focused or scattered?
  - Can it be split?

□ Set expectations
  - What's the timeline?
  - What's the risk level?
  - What areas need most attention?
```

### Review Order

```
SUGGESTED READING ORDER

1. Description/Context
   - Read PR description first
   - Understand the "why"

2. Tests
   - See what behavior is expected
   - Understand the contract

3. Public API/Interface
   - How will this be used?
   - Is the interface clear?

4. Implementation
   - How does it work?
   - Is it correct?

5. Documentation
   - Is it documented?
   - Are there examples?
```

---

## Phase 2: Review Dimensions

### Dimension 1: Correctness

```
CORRECTNESS CHECKLIST

Logic:
□ Algorithm is correct
□ Edge cases handled
□ Error cases handled
□ Race conditions considered
□ Off-by-one errors checked

Data:
□ Input validation present
□ Null/undefined handled
□ Type safety maintained
□ Data consistency ensured

Integration:
□ API contracts honored
□ Side effects documented
□ Dependencies correct
□ Resource cleanup handled
```

### Dimension 2: Security

```
SECURITY CHECKLIST

Input:
□ User input validated
□ SQL injection prevented
□ XSS prevented
□ Path traversal prevented

Authentication:
□ Auth checks present
□ Permissions verified
□ Session handling secure

Data:
□ Sensitive data encrypted
□ Secrets not hardcoded
□ Logging doesn't leak data

Dependencies:
□ No known vulnerabilities
□ Minimal privilege principle
```

### Dimension 3: Performance

```
PERFORMANCE CHECKLIST

Efficiency:
□ No unnecessary computation
□ Appropriate data structures
□ Caching where beneficial
□ Lazy loading if applicable

Resource usage:
□ Memory leaks checked
□ Connection pooling used
□ Large allocations justified
□ Async operations used appropriately

Scalability:
□ Algorithm complexity appropriate
□ Database queries optimized
□ N+1 queries avoided
□ Batch operations used
```

### Dimension 4: Maintainability

```
MAINTAINABILITY CHECKLIST

Readability:
□ Clear naming
□ Appropriate abstraction
□ Consistent style
□ Not overly clever

Organization:
□ Single responsibility
□ Appropriate module size
□ Clear dependencies
□ Minimal coupling

Testability:
□ Testable design
□ Dependencies injectable
□ Side effects isolated
□ Test coverage adequate

Documentation:
□ Complex logic explained
□ Public API documented
□ Non-obvious behavior noted
□ Examples provided
```

---

## Phase 3: Review Delivery

### Comment Categories

```
COMMENT SEVERITY

[CRITICAL] - Must fix before merge
- Security issues
- Correctness bugs
- Breaking changes

[MAJOR] - Should fix, discuss if disagree
- Design issues
- Performance problems
- Maintainability concerns

[MINOR] - Consider fixing
- Style issues
- Suggestions
- Questions

[NIT] - Optional, up to author
- Formatting
- Preferences
- Alternative approaches
```

### Constructive Feedback

```
FEEDBACK PATTERNS

Instead of:
"This is wrong"

Try:
"This might not handle the case where X. Consider adding a check for Y."

---

Instead of:
"Why did you do it this way?"

Try:
"I'm curious about the choice to use X here. Did you consider Y? What were the trade-offs?"

---

Instead of:
"This is confusing"

Try:
"I found this section hard to follow. Could we add a comment explaining the intent, or split it into smaller functions?"

---

Instead of:
"Fix this"

Try:
"Consider extracting this into a function named X. This would make the intent clearer and allow reuse."
```

### Review Comments Template

```markdown
## Summary
- **Overall**: [Brief assessment]
- **Status**: [Approve/Request changes/Comment]
- **Risk**: [Low/Medium/High]

## Critical Issues
1. [Issue]: [Location] - [Description]

## Major Suggestions
1. [Suggestion]: [Location] - [Description]

## Minor Notes
1. [Note]: [Location] - [Description]

## Questions
1. [Question]: [Location]

## Praise
- [What was done well]
```

---

## Phase 4: Review Process

### The Review Cycle

```
REVIEW WORKFLOW

1. Author submits PR
2. Reviewer reviews (within 24 hours)
3. Reviewer leaves comments
4. Author addresses feedback
5. Reviewer re-reviews
6. Repeat until approved
7. Merge

TIME GUIDELINES

- Initial review: < 24 hours
- Follow-up reviews: < 4 hours
- PR size: < 400 lines ideal
- Review rounds: < 3 ideally
```

### Handling Disagreements

```
DISAGREEMENT RESOLUTION

1. Assume good intent
   - Both want the best code
   - Different perspectives are valuable

2. Explain your reasoning
   - Why do you think this?
   - What are you worried about?

3. Consider trade-offs
   - Perfect vs. good enough
   - Time vs. quality
   - Consistency vs. improvement

4. Escalate if needed
   - Discuss in person/Zoom
   - Bring in third opinion
   - Document decision

5. Move forward
   - Don't let perfect be enemy of good
   - Can be improved later
```

---

## Phase 5: Special Cases

### Large Changes

```
LARGE PR STRATEGY

For PRs > 400 lines:

1. Suggest splitting
   - "Could we split this into X and Y?"
   - Review separately

2. If can't split:
   - Schedule review time
   - Review in chunks
   - Multiple reviewers

3. Focus on:
   - Architecture/design
   - Key algorithms
   - Interface contracts
   - Tests
```

### Emergency Reviews

```
HOTFIX REVIEW

When speed matters:

1. Focus on:
   - Correctness of fix
   - No new issues introduced
   - Rollback plan

2. Post-merge:
   - Full review after deploy
   - Follow-up improvements
   - Document what was skipped

3. Learn:
   - Why was emergency needed?
   - How to prevent next time?
```

---

## Quick Reference

```
REVIEW CHECKLIST

Correctness:
□ Logic is correct
□ Edge cases handled
□ Error handling present
□ Tests cover behavior

Security:
□ Input validated
□ Auth checked
□ No secrets exposed
□ Dependencies safe

Performance:
□ Efficient algorithms
□ Resource usage reasonable
□ Scalability considered

Maintainability:
□ Clear and readable
□ Well organized
□ Properly documented
□ Testable design

FEEDBACK PRINCIPLES
□ Be specific
□ Explain why
□ Suggest improvements
□ Acknowledge good work
□ Assume good intent

REVIEW TIMING
□ Initial: < 24 hours
□ Follow-up: < 4 hours
□ PR size: < 400 lines
□ Rounds: < 3 ideally
```
