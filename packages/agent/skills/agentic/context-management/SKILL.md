---
name: context-management
description: "Manage context in long-running tasks and conversations. Use when working on extended projects, handing off work between sessions, or compressing information to stay within context limits. Essential for maintaining coherence across multiple interactions."
---

# Context Management

Strategies for managing information in long-running tasks, maintaining coherence, and handling context limitations.

---

## Core Principle

**Context is a scarce resource. Manage it intentionally.**

What you keep in context determines what you can access and how effectively you can work. Good context management is about keeping the right information accessible at the right time.

---

## Phase 1: Context Audit

### Understand Your Context Budget

```
CONTEXT AWARENESS

Current context size: [approximate tokens/characters]
Context limit: [maximum capacity]
Headroom: [remaining capacity]

High-cost items:
- Large code files
- Long conversation history
- Extensive outputs
- Multiple file contents

Monitor context usage like memory — know when you're approaching limits.
```

### Identify Context Components

```
CONTEXT INVENTORY

Active Context (currently loaded):
├── Conversation history
├── Open files
├── Current task description
├── Recent tool outputs
└── Working memory (variables, state)

External Context (available on demand):
├── File system
├── Documentation
├── Previous conversations
├── Saved checkpoints
└── Reference materials
```

---

## Phase 2: Information Triage

### The Retention Decision

For each piece of information, decide:

```
RETENTION FRAMEWORK

KEEP IN CONTEXT:
□ Needed for immediate next steps
□ Required for coherence (references back)
□ Frequently accessed
□ Small but critical details
□ Current task state

SUMMARIZE:
□ Important but lengthy
□ Historical context
□ Previous decisions
□ Completed work details

EXTERNALIZE (write to file):
□ Large reference materials
□ Completed analysis
□ Code implementations
□ Research findings
□ Checkpoints

DISCARD:
□ Transient calculations
□ Obsolete information
□ Successfully completed steps
□ Redundant details
```

### Compression Strategies

**Summarization:**
```
BEFORE: 500 lines of conversation about debugging
AFTER: "Debugged auth issue: root cause was expired token 
        caching, fixed by adding TTL check in middleware"
```

**Reference by pointer:**
```
BEFORE: Full content of 3 related files
AFTER: "See [file1.ts:45-67], [file2.ts:12-34], [file3.ts:89-120] 
        for implementation details"
```

**Key extraction:**
```
BEFORE: Complete meeting transcript
AFTER: "Decisions: 1) Use Postgres, 2) Ship MVP by Friday
        Action items: [list] Owner: [name]"
```

---

## Phase 3: Checkpoint Strategy

### When to Write Checkpoints

```
CHECKPOINT TRIGGERS

Time-based:
□ Every 30 minutes of active work
□ End of work session
□ Before switching tasks

Event-based:
□ Completing a major phase
□ Making significant decisions
□ Before risky operations
□ When context feels "full"

State-based:
□ Before context-limiting operations
□ When starting complex multi-step task
□ Before handing off to another agent/session
```

### Checkpoint Content

```markdown
## Checkpoint: [Timestamp]

### Current State
**Task**: [What we're doing]
**Phase**: [Current phase/stage]
**Status**: [In progress/Blocked/Ready for next]

### Key Information (Retained in Context)
- [Critical fact 1]
- [Critical fact 2]
- [Current decision/approach]

### Completed Work
- [Summary of what's done]
- [Links to outputs/files]

### Decisions Made
1. [Decision]: [Rationale]
2. [Decision]: [Rationale]

### Open Questions/Issues
- [Question/Issue 1]
- [Question/Issue 2]

### Next Steps
1. [Immediate next action]
2. [Following action]

### Context Summary
- Files open: [list]
- Key variables: [list]
- Pending operations: [list]
```

---

## Phase 4: Handoff Protocol

### Preparing for Handoff

```
HANDOFF PREPARATION CHECKLIST

□ Current state documented
□ Recent decisions recorded
□ Open issues listed
□ Next steps clear
□ Relevant files identified
□ Context compressed/summarized
□ Checkpoint written
□ Handoff message prepared
```

### Handoff Message Format

```markdown
## Handoff: [Task Name]

### Quick Summary
[2-3 sentence status]

### What's Been Done
- [Key accomplishment 1]
- [Key accomplishment 2]

### Current State
- [Where we are in the process]
- [Any blockers or issues]

### Key Context
- [Critical information needed to continue]
- [Recent decisions and why]

### Next Steps (Prioritized)
1. [Next action - highest priority]
2. [Following action]
3. [Nice to have]

### Resources
- Checkpoint file: [path]
- Key files: [list with relevance]
- References: [links]

### Notes
[Anything else the next agent should know]
```

### Resuming from Handoff

```
RESUMPTION CHECKLIST

□ Read handoff message thoroughly
□ Load checkpoint file
□ Review key files
□ Understand current state
□ Confirm next steps
□ Ask clarifying questions if needed
□ Update status to "resumed"
```

---

## Phase 5: Progressive Disclosure

### Layered Information Access

```
LEVEL 1: Summary (always in context)
- Current task
- Recent decisions
- Blockers
- Next step

LEVEL 2: Details (load on demand)
- Full checkpoint
- Specific file contents
- Previous analysis
- Reference materials

LEVEL 3: Archive (external storage)
- Old checkpoints
- Completed phases
- Historical context
- Full conversation history
```

### On-Demand Loading

```
WHEN YOU NEED SOMETHING NOT IN CONTEXT:

1. Identify what you need
   "I need to see the API contract we defined"

2. Locate it
   "It should be in the checkpoint or design.md"

3. Load selectively
   Read only the relevant section, not entire file

4. Integrate
   "Based on the API contract [reference], I can now..."

5. Discard when done (if not needed ongoing)
   "The specific endpoint details are in the file if needed again"
```

---

## Phase 6: Working Memory Management

### Maintain Active State

```
WORKING MEMORY ITEMS

Current Focus:
- Active task: [what we're doing right now]
- Current step: [specific step in progress]
- Expected outcome: [what completion looks like]

Key Facts:
- [Fact that affects current work]
- [Constraint or requirement]
- [Decision that guides approach]

Open Loops:
- [Task started but not completed]
- [Question to answer later]
- [Issue to investigate]
```

### State Update Pattern

```
AFTER EACH SIGNIFICANT ACTION:

1. Update working memory
   "Completed: X"
   "Now working on: Y"
   "Still pending: Z"

2. Check for completed open loops
   "Can close: [item] - resolved by [action]"

3. Add new open loops if discovered
   "New: Need to check [thing] before proceeding"

4. Summarize current state
   "Status: X done, Y in progress, Z blocked by W"
```

---

## Phase 7: Recovery Strategies

### When Context is Lost

```
CONTEXT RECOVERY CHECKLIST

□ Check for checkpoint file
□ Read most recent handoff message
□ Review file system for recent changes
□ Look for TODO comments in code
□ Check for saved state files
□ Reconstruct from git history if applicable
□ Ask user for key context if critical
```

### Reconstruction from Artifacts

```
RECOVERY SOURCES (in order of reliability)

1. Checkpoint files (most reliable)
   - Explicit state save
   - Structured format
   - Recent timestamp

2. Handoff messages
   - Human-readable summary
   - May miss details
   - Check date

3. File system state
   - Modified files show work done
   - File contents show current implementation
   - Timestamps show sequence

4. Git history
   - Commit messages describe changes
   - Diffs show what changed
   - Branches show parallel work

5. Tool outputs (if logged)
   - Previous command results
   - Search results
   - File reads
```

---

## Common Pitfalls

### Context Management Errors

1. **Hoarding**: Keeping everything "just in case"
   - Fix: Be ruthless about externalizing

2. **Over-summarizing**: Losing critical details
   - Fix: Keep specific facts that matter

3. **No checkpoints**: Working for hours without saves
   - Fix: Set checkpoint reminders

4. **Poor handoffs**: Assuming context carries over
   - Fix: Always write explicit handoff messages

5. **Context blindness**: Not noticing when context is full
   - Fix: Regularly audit context size

### Recovery Errors

1. **Assuming continuity**: Acting like previous context exists
   - Fix: Explicitly verify what you know

2. **Ignoring checkpoints**: Starting from scratch
   - Fix: Always check for checkpoints first

3. **Silent recovery**: Not acknowledging context loss
   - Fix: State what you're reconstructing from

---

## Quick Reference

```
CONTEXT MANAGEMENT CHECKLIST

Before starting work:
□ Load relevant checkpoint if exists
□ Audit current context
□ Identify what needs to be in context

During work:
□ Summarize completed sections
□ Externalize large outputs
□ Update working memory
□ Watch context size

Before ending session:
□ Write checkpoint
□ Summarize current state
□ Document next steps
□ Prepare handoff if needed

When resuming:
□ Read checkpoint/handoff
□ Reconstruct context
□ Verify understanding
□ Confirm next steps

CONTEXT COMPRESSION TECHNIQUES
□ Summarize long conversations
□ Reference files by path/line
□ Extract key decisions
□ Remove completed steps
□ Use pointers instead of full content
```

---

## Integration with Duya's Research Journal

### Research Journal as External Context

```
RESEARCH JOURNAL INTEGRATION

When researching:
1. Document findings in Research Journal
2. Keep only summary in context
3. Reference specific entries

When resuming research:
1. Read Research Journal entries
2. Load relevant findings into context
3. Continue from where you left off

When handing off:
1. Ensure Research Journal is current
2. Reference key entries in handoff
3. Note any in-progress investigations
```

### Context Handoff to Research Journal

```
PATTERN: Long-running research task

1. Initial session:
   - Set up Research Journal entry
   - Document research questions
   - Start gathering sources

2. Mid-research checkpoint:
   - Summarize findings so far
   - Note promising directions
   - Document dead ends
   - Write checkpoint

3. Context pressure:
   - Move detailed notes to Research Journal
   - Keep only current focus in context
   - Reference journal entries

4. Handoff:
   - Finalize Research Journal entry
   - Write handoff with journal references
   - Next agent reads journal to resume
```
