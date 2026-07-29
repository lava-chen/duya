# Write Back to Figma

Push annotations or comments back to the Figma file to close the loop
with the designer. This skill is the only write path in the Figma
plugin — every other skill is read-only.

## When to use

- The user says "leave a comment on this frame for the designer" /
  "annotate this token gap in Figma".
- `visual-comparison` identified design bugs or token gaps the
  designer needs to act on.
- `component-implementation` discovered a Figma main component that
  should be renamed or split — surface it as an annotation rather
  than a chat-only report.

## Process

1. Confirm the target Figma node (`file_key`, `node_id`) and the
   annotation text. Draft the text in chat first; never write
   directly to Figma without showing the user the proposed payload.
2. Classify the write:
   - **Comment** — a threaded discussion point. Use
     `figma.create_comment`. Comments are visible to everyone on
     the file and trigger notifications.
   - **Annotation** — a non-threaded marker pinned to a node. Use
     `figma.create_annotation`. Annotations are quieter and better
     for "FYI" notes the designer reviews at their leisure.
3. Pin the comment or annotation to the most specific node possible.
   A frame-level comment is less actionable than a child-node
   comment that points at the exact element.
4. After the write, report the permalink back to chat so the user
   can jump to it in Figma.
5. Do not edit the design itself (move nodes, change styles) from
   this skill. Design edits are out of scope; the source of truth
   is the designer, not the agent.

## Tool call patterns

- `figma.create_comment(file_key, node_id, text)` returns the
  comment ID and a permalink. Quote the comment text verbatim in
  the report so the user can audit it later.
- `figma.create_annotation(file_key, node_id, text, label)` is
  preferred for non-blocking notes. Use a short `label`
  (`Token gap`, `Design bug`, `Implementation note`) so the
  designer can filter annotations in Figma.
- Never batch-write annotations without confirming each one — a
  flood of annotations is worse than a single summary comment.

## Confirmation boundary

- Reading Figma context to draft the annotation: `read` tier,
  automatic.
- Posting a comment or annotation: `modify` tier, confirm. Always
  show the proposed text and target node to the user before the
  write. A comment posted to the wrong node is hard to delete
  cleanly and notifies everyone on the file.
- Deleting a comment or annotation: `destructive` tier, strong
  explicit confirmation. The MCP server may not expose this; if
  not, direct the user to delete it in Figma directly.

## Pitfalls

- Comments and annotations are visible to everyone with file
  access. Do not include code snippets, secrets, or internal
  identifiers the designer should not see.
- A pinned comment is bound to a node version. If the designer
  restructures the frame, the comment may detach or disappear.
  Prefer annotations for permanent markers.
- Figma notifications can be noisy. Consolidate multiple related
  observations into a single comment with a checklist rather than
  posting one comment per observation.
- Do not write back as a substitute for fixing the code. If the
  implementation is wrong, fix it; only annotate when the design
  itself is the source of the discrepancy.
