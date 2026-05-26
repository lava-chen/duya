---
name: task-decomposition
description: "Break down ambiguous or complex tasks into actionable steps. Use when receiving vague requests, large projects, or when the path forward is unclear. Identifies task types, splits work into atomic steps, maps dependencies, and finds parallelization opportunities."
---

# Task Decomposition

A systematic approach to breaking down complex or ambiguous tasks into clear, actionable steps.

---

## Core Principle

**Big problems are just collections of small problems. Find the seams.**

The goal is not just to split work, but to split it in ways that make execution clearer, dependencies explicit, and parallelization possible.

---

## Phase 1: Task Analysis

### Clarify the Request

Before decomposing, understand what you're being asked to do:

```
CLARIFICATION QUESTIONS

1. What is the desired outcome?
   - What does "done" look like?
   - How will success be measured?

2. What are the constraints?
   - Time limit?
   - Resources available?
   - Must-use technologies?
   - Must-avoid approaches?

3. What is the context?
   - Why is this needed?
   - Who is the audience/user?
   - What has been tried before?

4. What is the scope?
   - What's in scope?
   - What's explicitly out of scope?
```

### Task Type Identification

Different task types need different decomposition approaches:

| Type | Characteristics | Decomposition Strategy |
|------|-----------------|----------------------|
| **Exploratory** | Unknown solution space | Research → Hypothesize → Prototype → Validate |
| **Implementation** | Known solution, execution focus | Design → Build → Test → Deploy |
| **Analytical** | Data-driven, answer-seeking | Acquire → Clean → Analyze → Interpret |
| **Creative** | Open-ended, multiple valid outputs | Diverge → Evaluate → Refine → Select |
| **Integrative** | Combining existing components | Inventory → Map dependencies → Connect → Validate |
| **Troubleshooting** | Problem-solving, fix-oriented | Reproduce → Isolate → Hypothesize → Fix → Verify |

---

## Phase 2: Decomposition Strategies

### Strategy 1: Functional Decomposition

Break by what needs to happen:

```
TASK: "Build a user authentication system"

├── Input handling
│   ├── Login form validation
│   ├── Password input security
│   └── Session token generation
├── Authentication logic
│   ├── Credential verification
│   ├── Multi-factor authentication
│   └── Account lockout handling
├── Storage
│   ├── Password hashing
│   ├── Session persistence
│   └── Audit logging
└── Output/Integration
    ├── Redirect after login
    ├── Permission checking
    └── API token issuance
```

### Strategy 2: Temporal Decomposition

Break by sequence/phases:

```
TASK: "Launch a new product feature"

Phase 1: Discovery (Week 1)
├── User research
├── Competitive analysis
└── Technical feasibility

Phase 2: Design (Week 2-3)
├── UX wireframes
├── Technical design
└── Data model design

Phase 3: Implementation (Week 4-6)
├── Backend API
├── Frontend UI
└── Integration testing

Phase 4: Launch (Week 7)
├── Staging validation
├── Documentation
└── Production deployment
```

### Strategy 3: Object-Oriented Decomposition

Break by entities/components:

```
TASK: "Implement an e-commerce checkout"

├── User entity
│   ├── Cart management
│   ├── Address management
│   └── Payment method storage
├── Product entity
│   ├── Inventory checking
│   ├── Price calculation
│   └── Availability validation
├── Order entity
│   ├── Order creation
│   ├── Status tracking
│   └── Confirmation emails
└── Payment entity
    ├── Payment processing
    ├── Refund handling
    └── Receipt generation
```

### Strategy 4: Risk-Driven Decomposition

Break by uncertainty levels:

```
TASK: "Evaluate a new technology for our stack"

High Confidence (do first):
├── Documentation review
├── Basic feature checklist
└── Community/ ecosystem assessment

Medium Confidence (do second):
├── Proof of concept
├── Performance benchmarks
└── Integration complexity estimate

Low Confidence (do last):
├── Production-readiness evaluation
├── Team learning curve assessment
└── Migration path planning
```

---

## Phase 3: Dependency Mapping

### Identify Relationships

```
DEPENDENCY TYPES

Hard dependency: B cannot start until A completes
├── Database schema → API implementation
├── API contract → Frontend integration
└── Requirements → Design

Soft dependency: B benefits from A but can proceed
├── Research → Implementation (can build while learning)
├── Draft → Review (can start review before final)
└── Component A → Component B (can mock)

No dependency: Can be done in parallel
├── Frontend and Backend (with API contract)
├── Documentation and Testing
└── Independent features
```

### Visualize Dependencies

```
SEQUENTIAL (no parallelism possible)
A → B → C → D

PARALLEL (maximum parallelism)
A → B → C
↓   ↓   ↓
D → E → F

MIXED (realistic)
       ┌→ B ─┐
A ─────┼→ C ─┼→ E → F
       └→ D ─┘
```

---

## Phase 4: Atomic Step Definition

### What Makes a Step "Atomic"

An atomic step:
- Has a clear start and end
- Can be completed in one focused session (30 min - 2 hours)
- Has unambiguous completion criteria
- Produces a tangible output
- Can be tested/verified independently

### Atomic Step Template

```markdown
### Step [ID]: [Name]

**Objective**: [One sentence describing the goal]

**Input**: [What is needed to start]
- [Input 1]
- [Input 2]

**Actions**:
1. [First action]
2. [Second action]
3. [Third action]

**Output**: [What is produced]
- [Deliverable 1]
- [Deliverable 2]

**Completion Criteria**:
- [ ] [Specific, verifiable condition]
- [ ] [Specific, verifiable condition]

**Estimated Effort**: [time estimate]
**Dependencies**: [list of prerequisite steps]
**Blocked By**: [none | step IDs]
**Blocks**: [step IDs that depend on this]
```

---

## Phase 5: Parallelization Analysis

### Find Parallel Opportunities

```
PARALLELIZATION CHECKLIST

□ Can any steps be done simultaneously?
□ Are there independent workstreams?
□ Can we mock dependencies to start early?
□ Can we split a large step into parallel sub-steps?
□ Are there background tasks that can run during foreground work?
```

### Parallel Workstream Example

```
PROJECT: "Build a web application"

Workstream A: Backend
├── Design API contract (Day 1)
├── Implement authentication (Day 2-3)
├── Implement core endpoints (Day 4-6)
└── Add monitoring/logging (Day 7)

Workstream B: Frontend
├── Review API contract (Day 1)
├── Set up project structure (Day 1)
├── Build auth flows (Day 2-3)
├── Build UI components (Day 4-6)
└── Connect to API (Day 5-7)

Workstream C: Infrastructure
├── Set up CI/CD (Day 1-2)
├── Configure staging environment (Day 3)
├── Set up database (Day 2)
└── Production deployment prep (Day 6-7)

MERGE POINTS
├── Day 1: API contract agreed
├── Day 3: Auth integration test
├── Day 7: End-to-end validation
```

---

## Phase 6: Output Format

### Decomposition Summary

```markdown
# Task Decomposition: [Task Name]

## Overview
- **Type**: [Exploratory/Implementation/Analytical/etc.]
- **Estimated Total Effort**: [time]
- **Critical Path Length**: [number of sequential steps]
- **Maximum Parallelism**: [number of parallel workstreams]

## Work Breakdown Structure

### Phase 1: [Name]
- [ ] Step 1.1: [Description] ([effort])
- [ ] Step 1.2: [Description] ([effort])
  - [ ] Sub-step 1.2.1: [Description]
  - [ ] Sub-step 1.2.2: [Description]

### Phase 2: [Name]
- [ ] Step 2.1: [Description] ([effort])
- [ ] Step 2.2: [Description] ([effort])

## Dependency Graph

```
[ASCII diagram or reference to visual]
```

## Critical Path

[Step A] → [Step B] → [Step C] → [Step D]
Total: [X days]

## Risk Areas

1. **[Risk 1]**: [Description]
   - Mitigation: [Approach]
   - Contingency: [Fallback plan]

2. **[Risk 2]**: [Description]
   - Mitigation: [Approach]
   - Contingency: [Fallback plan]

## Next Actions

1. [Immediate next step]
2. [Following step]
3. [Preparation needed]
```

---

## Common Pitfalls

### Decomposition Errors

1. **Too granular**: Steps that take < 10 minutes
   - Fix: Combine related micro-steps

2. **Too coarse**: Steps that take > 1 day
   - Fix: Break into sub-steps with intermediate outputs

3. **Hidden dependencies**: Steps that seem independent but aren't
   - Fix: Explicitly map all inputs/outputs

4. **Ambiguous completion**: "Work on X" instead of "Complete X"
   - Fix: Define specific, verifiable completion criteria

5. **Missing integration**: Parallel workstreams never merge
   - Fix: Define explicit integration/validation points

### Planning Errors

1. **Optimistic estimation**: Assuming best case
   - Fix: Add 50% buffer for unknowns

2. **Ignoring setup**: Not accounting for environment prep
   - Fix: Include "Setup" as explicit phase

3. **No validation**: No steps for testing/verification
   - Fix: Every phase ends with validation

---

## Quick Reference

```
DECOMPOSITION CHECKLIST
□ Task type identified
□ Clarifying questions answered
□ Decomposition strategy selected
□ Steps defined (atomic, 30min-2hr each)
□ Dependencies mapped
□ Parallel opportunities identified
□ Critical path identified
□ Risks documented
□ Output format complete

ATOMIC STEP CHECKLIST
□ Clear objective
□ Defined inputs
□ Listed actions
□ Specified outputs
□ Verifiable completion criteria
□ Time estimate
□ Dependencies noted
```
