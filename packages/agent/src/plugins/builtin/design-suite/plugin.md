---
name: design-suite
description: End-to-end design critique, research synthesis, accessibility, handoff, and UX-writing workflows
version: 1.0.0
author: DUYA Team
---

# Design Suite

Design Suite is a complete design-workflow bundle. It works immediately with
seven local skills and the local `design-audit` MCP server. Figma, Slack,
Linear, Notion, and Google Calendar are optional host-level connections: they
are not installed with the bundle and can be connected later, once, then
reused by every compatible Duya plugin.

## Included capabilities

- Critique and accessibility review of a screen or interaction flow.
- Design-system mapping, component handoff, and UX copy drafting.
- User-research synthesis into themes, decisions, and follow-up work.
- Local `design_audit` MCP tool for a structured visual and accessibility
  checklist without requiring an external account.

## Connection posture

The bundle declares external applications as optional. A workflow that needs a
Figma file, a Notion research database, or Linear issues should ask the user to
connect that application at first use. Disconnecting a shared application
does not uninstall this bundle, and uninstalling this bundle never revokes a
shared application grant.

## Safety posture

Local analysis is read-only. Creating or updating external artifacts, such as
comments, tickets, calendar events, or shared documents, requires the normal
Duya confirmation policy before the connector action executes.
