---
name: debug-strategy
description: "Systematic debugging methodology. Use when facing bugs, errors, or unexpected behavior. Provides structured approaches to reproduce, isolate, hypothesize, and verify fixes. Covers stack trace reading, minimum reproduction, and binary search debugging."
---

# Debug Strategy

A systematic approach to debugging that transforms guesswork into methodical problem-solving.

---

## Core Principle

**Debugging is the scientific method applied to software: observe, hypothesize, test, repeat.**

---

## Phase 1: Problem Characterization

### Gather Information

```
INITIAL ASSESSMENT

What happened:
□ Error message (exact text)
□ Stack trace (full trace)
□ Expected behavior
□ Actual behavior
□ When it started happening

Context:
□ Recent changes (code, config, data)
□ Environment (dev/staging/prod)
□ Frequency (always/sometimes/rare)
□ Scope (affects all users/some/one)
□ Reproducibility (reliable steps?)
```

### The Debugging Questions

```
KEY QUESTIONS

1. WHAT is failing?
   - Specific error or general malfunction?
   - One component or system-wide?

2. WHEN does it fail?
   - Specific time/condition/trigger?
   - After what event?

3. WHERE does it fail?
   - Which component/layer?
   - Which environment?

4. WHO is affected?
   - All users or specific subset?
   - Related to user permissions/data?

5. HOW has it changed?
   - What worked before?
   - What changed recently?
```

---

## Phase 2: Reproduction

### Create Minimal Reproduction

```
REPRODUCTION GOAL

Reduce to the smallest case that:
- Still shows the bug
- Has no unnecessary elements
- Can be run quickly
- Is self-contained

REPRODUCTION TEMPLATE

```
Steps to reproduce:
1. [First step]
2. [Second step]
3. [Third step]

Expected: [What should happen]
Actual: [What actually happens]

Environment:
- OS: [version]
- Runtime: [version]
- Dependencies: [versions]
```
```

### Reproduction Strategies

```
ISOLATION TECHNIQUES

Binary search on code:
1. Comment out half the code
2. Does bug still occur?
   - Yes: Bug is in remaining half
   - No: Bug is in commented half
3. Repeat until isolated

Binary search on data:
1. Split dataset in half
2. Which half triggers bug?
3. Repeat until minimal case

Configuration isolation:
- Default config + one change at a time
- Identify which setting triggers issue

Dependency isolation:
- Remove dependencies one by one
- Find which one causes conflict
```

---

## Phase 3: Hypothesis Formation

### Generate Hypotheses

```
HYPOTHESIS CATEGORIES

Code issues:
□ Logic error (wrong condition/algorithm)
□ Off-by-one error (loop bounds)
□ Null/undefined reference
□ Type mismatch
□ Race condition
□ Memory leak

Data issues:
□ Unexpected input format
□ Missing/invalid data
□ Encoding problems
□ Data too large/small

Environment issues:
□ Version mismatch
□ Missing dependency
□ Configuration error
□ Permission problem
□ Resource exhaustion

Integration issues:
□ API change
□ Protocol mismatch
□ Timing/ordering issue
□ Side effect from other component
```

### Prioritize Hypotheses

```
PRIORITIZATION CRITERIA

Likelihood (based on):
- Recent changes in that area
- Common causes for this symptom
- Your experience with similar bugs

Ease of testing:
- Can be checked quickly
- Doesn't require complex setup
- Has clear pass/fail criteria

Impact if true:
- Would explain all symptoms
- Leads to clear fix
- High confidence in solution
```

---

## Phase 4: Testing Hypotheses

### Design Experiments

```
EXPERIMENT DESIGN

For each hypothesis:
1. Prediction: "If X is true, then Y should happen"
2. Test: Specific action to check prediction
3. Result: What actually happened
4. Conclusion: Hypothesis supported/refuted

EXAMPLE

Hypothesis: "Bug is caused by null value in field X"
Prediction: "If I add null check, error should stop"
Test: Add logging for field X, run reproduction
Result: "Field X is null when error occurs"
Conclusion: "Hypothesis supported"
```

### Diagnostic Techniques

```
LOGGING STRATEGY

Strategic log points:
- Function entry/exit
- Before/after external calls
- State changes
- Decision points

What to log:
- Variable values
- Execution path taken
- Timing information
- Error details

LOGGING PATTERN

```
console.log(`[DEBUG] Entering function X`);
console.log(`[DEBUG] param1=${JSON.stringify(param1)}`);
// ... code ...
console.log(`[DEBUG] After step Y, value=${value}`);
console.log(`[DEBUG] Exiting function X, result=${result}`);
```
```

### Stack Trace Reading

```
STACK TRACE ANATOMY

ErrorType: Error message
    at functionName (file:line:column)
    at functionName (file:line:column)
    at functionName (file:line:column)

READING ORDER: Bottom to top
- Bottom: Where execution started
- Top: Where error occurred

KEY INFORMATION:
- Error type (what kind of problem)
- Error message (specific details)
- File:line (exact location)
- Call stack (how we got there)

COMMON ERROR TYPES:

TypeError: Cannot read property 'X' of undefined
→ Trying to access property on null/undefined

ReferenceError: X is not defined
→ Variable doesn't exist in scope

RangeError: Maximum call stack size exceeded
→ Infinite recursion

SyntaxError: Unexpected token
→ Code parsing error
```

---

## Phase 5: Fix and Verify

### Implement Fix

```
FIX CHECKLIST

□ Addresses root cause, not just symptom
□ Doesn't break other functionality
□ Includes test for the bug
□ Handles edge cases
□ Is minimal and focused
```

### Verify Fix

```
VERIFICATION STEPS

1. Reproduction test
   - Run original reproduction steps
   - Confirm bug no longer occurs

2. Regression test
   - Run existing test suite
   - Confirm no new failures

3. Edge case test
   - Test boundary conditions
   - Test with invalid inputs
   - Test under load (if relevant)

4. Environment test
   - Test in different environments
   - Test with different data
   - Test with different configurations
```

---

## Phase 6: Prevention

### Learn from the Bug

```
POST-MORTEM QUESTIONS

1. Why did this bug occur?
   - Missing validation?
   - Unclear requirements?
   - Complexity?

2. Why wasn't it caught earlier?
   - Missing test?
   - Test didn't cover this case?
   - Code review missed it?

3. How can we prevent similar bugs?
   - Add validation?
   - Improve tests?
   - Add documentation?
   - Change process?
```

### Defensive Coding

```
PREVENTION PATTERNS

Input validation:
```javascript
if (!input || typeof input !== 'string') {
  throw new Error('Invalid input: expected string');
}
```

Null checks:
```javascript
const value = obj?.nested?.property ?? defaultValue;
```

Type safety:
```typescript
function process(data: ValidatedData): Result {
  // TypeScript catches type errors at compile time
}
```

Assertions:
```javascript
console.assert(condition, 'Expected X but got Y');
```

---

## Common Pitfalls

### Debugging Errors

1. **Assuming the obvious**: First guess is often wrong
   - Fix: Form multiple hypotheses, test systematically

2. **Changing multiple things**: Can't tell what fixed it
   - Fix: One change at a time

3. **Not reproducing first**: Fixing without understanding
   - Fix: Always reproduce before fixing

4. **Ignoring the error message**: Not reading carefully
   - Fix: Read error messages completely

5. **Premature optimization**: Optimizing before correctness
   - Fix: Make it work, then make it fast

### Process Errors

1. **No version control**: Can't undo experiments
   - Fix: Commit before debugging

2. **Production debugging**: Testing fixes in production
   - Fix: Reproduce locally first

3. **Not asking for help**: Stuck for too long
   - Fix: Time-box, then escalate

---

## Quick Reference

```
DEBUGGING CHECKLIST
□ Information gathered
□ Minimal reproduction created
□ Hypotheses generated
□ Hypotheses prioritized
□ Experiments designed
□ Root cause identified
□ Fix implemented
□ Fix verified
□ Prevention considered

DEBUGGING TOOLS
- Console logging
- Debugger breakpoints
- Stack trace analysis
- Binary search isolation
- Unit tests
- Integration tests

TIME BOXES
Quick bug: 30 minutes
Medium bug: 2 hours
Hard bug: 1 day
Escalate if: >1 day with no progress
```
