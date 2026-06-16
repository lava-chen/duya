---
name: intent-alignment
description: "Pre-execution intent alignment. Use before any non-trivial task — coding, writing, research, design, planning, content creation — to eliminate ambiguity before acting. Identify the decisions that would cause the user to say 'that's not what I meant', resolve those precisely, then act. Do not gather exhaustive requirements; find the intent boundary and confirm it."
---
 
# Intent Alignment
 
Acting on a misunderstood task is one of the most expensive mistakes an agent can make. The output looks complete, the user has to explain what was wrong, and the work has to be redone — sometimes from scratch. A single well-placed question before starting costs ten seconds. Redoing a completed task costs ten minutes.
 
This skill is not about gathering requirements exhaustively. It is about locating the **intent boundary** — the point where what the user asked for ends and what they didn't ask for begins — and confirming it before any real work begins.
 
---
 
## The core question before every task
 
Before doing anything, ask yourself: **if I make a reasonable-sounding assumption here and I'm wrong, will the result need to be substantially redone?**
 
If yes — that assumption is the intent boundary. Surface it.
If no — make the choice, state it briefly, and proceed.
 
This is the filter. Not every unknown needs to be asked about. Only the ones that would cause a wrong outcome if guessed incorrectly.
 
---
 
## What to align on
 
### Scope boundary
 
This is the most common source of misalignment, and the easiest to miss because users assume it's obvious. It isn't.
 
"Summarize this paper" could mean a 3-sentence abstract or a 3-page structured breakdown. "Fix this bug" could mean patch this specific line or refactor the function it lives in. "Write a project proposal" could mean a half-page outline or a formal 10-page document with budget breakdown.
 
Before starting, know where the task ends. If the scope is genuinely ambiguous, ask — but ask about the specific dimension that's unclear, not "what do you mean by that."
 
Bad: "Can you clarify what you mean by summarize?"
Good: "How long should this be — a few sentences or a full-page breakdown?"
 
### Success criteria
 
What does done look like from the user's perspective? Not your definition of done — theirs. 
 
A user who asks for help with a presentation might want a polished final draft, or they might want a rough structure to iterate on themselves. A user who asks to "improve" a piece of writing might want better flow, or might want the argument restructured entirely. These are different tasks that can sound identical in the request.
 
The question to ask: "When you see the result, what will make you think it hit the mark?" For complex tasks, making this explicit prevents the common failure of delivering something technically correct but wrong in spirit.
 
### Hard constraints
 
Hard constraints are almost always unstated because the user assumes they're obvious. They're not.
 
A coding task might have implicit constraints: don't change the public API, don't add new dependencies, keep it compatible with the existing test suite. A writing task might have constraints: must stay under 500 words, must match the existing tone, must not reference competitor products. A research task might have constraints: only peer-reviewed sources, must focus on the last 5 years.
 
Surface constraints by asking: "Is there anything this solution must not do, or any boundaries it must stay within?" For tasks in an existing codebase or document, scan for what looks like established conventions and treat those as implicit constraints unless told otherwise.
 
### Priority when scope must be cut
 
On any sufficiently complex task, doing everything perfectly is not always possible within the expected effort. Knowing what matters most in advance prevents the wrong thing from being built first.
 
"If you had to pick one thing this needs to nail above everything else, what would it be?" — this question is especially valuable for open-ended tasks like writing, design, or feature development, where tradeoffs are inherent.
 
---
 
## How many questions to ask
 
**Calibrate to the task, not to a fixed number.**
 
Simple, unambiguous tasks need no alignment. State your interpretation and act:
> "Fixing the null check on line 34 — proceeding."
 
Tasks with one meaningful unknown need one question, then action.
 
Complex, open-ended tasks need a different approach: ask the single highest-leverage question, then act on a minimal version. Show it early. Users respond to concrete things far better than hypotheticals — a rough draft, a skeleton structure, a quick mockup surfaces misalignments that no amount of upfront questioning would have caught.
 
**Never ask more than two questions before producing something.** The questionnaire anti-pattern — listing five clarifying questions before doing anything — fails for two reasons. First, it puts the full burden of specification on the user, which is exactly what they hired an agent to avoid. Second, users often can't accurately answer questions about things they haven't seen yet. Show them something, then ask.
 
After answering one question, reassess. A good answer often resolves two or three other unknowns at once. Only ask the next question if genuine ambiguity remains.
 
---
 
## How to ask
 
The quality of an alignment question is determined by its stake: a good question has two possible answers that would lead to meaningfully different executions. If both answers would lead to roughly the same result, don't ask the question.
 
**Good alignment questions have concrete stakes:**
- "Should this function handle empty arrays, or can the caller guarantee non-empty input?" — two different implementations
- "Do you want the essay to take a clear position or present multiple sides?" — fundamentally different structure
- "Should I restructure the existing code or add to it as-is?" — different scope entirely
- "Is this for a technical audience or a general one?" — changes vocabulary, depth, and example choice
**Bad alignment questions are open-ended:**
- "What are your expectations for this?"
- "Can you tell me more about what you want?"
- "Is there anything else I should know?"
These questions don't work because they put the burden on the user to figure out what information you need. They can't — they don't know what decisions you're about to make. Ask for the specific decision, not for more context.
 
---
 
## Stating assumptions explicitly
 
When you choose not to ask — because the stakes are low, or the answer is reasonably inferable from context — say what you're assuming before acting:
 
> "I'm treating the word limit as a hard cap and will cut examples before cutting the main argument if space gets tight. Say the word if that's wrong."
 
> "I'll add tests for the new behavior only and leave existing tests untouched — let me know if you want me to revise those too."
 
> "I'm assuming this is meant for a technical reader, so I'll skip explaining the basics. Correct me if the audience is different."
 
This is not hedging. It is giving the user a precise correction target. An unstated assumption that turns out to be wrong means redoing work. A stated assumption that turns out to be wrong means a one-line correction before work begins.
 
The key is specificity. "I'll use my best judgment" is not a stated assumption — it tells the user nothing about what you're actually going to do. Name the choice you made.
 
---
 
## Using concrete artifacts to align
 
For some task types, showing something early is faster and more effective than any question.
 
When a task involves something the user will evaluate visually — a UI layout, a document structure, a diagram, a formatted output — produce a minimal version and present it as an alignment artifact, not a deliverable:
 
> "Here's a rough structure before I write the full thing — does this match the direction you had in mind?"
 
> "I've sketched the component layout in a quick mockup. Does this match what you envisioned, or should we adjust before I implement?"
 
The artifact doesn't need to be polished. It needs to be concrete enough that the user can point to what's right and what's wrong. A skeleton is enough. The goal is to make misalignment visible while it's still cheap to fix.
 
---
 
## The confirmation before acting
 
Once alignment is complete, close the loop. Restate the understood scope in one sentence before beginning:
 
> "So I'll [specific action], [specific constraint], leaving [specific thing] unchanged — proceeding."
 
For higher-stakes or longer tasks, wait for an explicit confirmation rather than proceeding on silence. For shorter tasks, "proceeding unless you say otherwise" is enough.
 
This restatement does two things: it confirms you understood correctly, and it gives the user one last chance to correct the scope before real work begins. It also makes the handoff explicit — the user knows work is starting, and they know exactly what was agreed to.
 
If the user's response to your restatement is ambiguous ("sounds good", "yeah", "ok"), treat it as a go signal for shorter tasks but ask for an explicit confirmation on anything that would take significant effort to redo.
