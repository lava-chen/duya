---
name: apple
description: Apple ecosystem integration on macOS — Notes, Reminders, Find My, and iMessage. Platform: macOS only (all sub-skills require macOS with iCloud).
sub_skills:
  - name: apple-notes
    description: Manage Apple Notes via the memo CLI on macOS (create, view, search, edit).
    directory: ./apple-notes
  - name: apple-reminders
    description: Manage Apple Reminders via remindctl CLI (list, add, complete, delete).
    directory: ./apple-reminders
  - name: findmy
    description: Track Apple devices and AirTags via FindMy.app on macOS using AppleScript and screen capture.
    directory: ./findmy
  - name: imessage
    description: Send and receive iMessages/SMS via the imsg CLI on macOS.
    directory: ./imessage
---

# Apple Suite

Comprehensive Apple ecosystem integration for macOS, bundling four first-party app capabilities under one skill entry point.

## Platform requirement

**macOS only.** All sub-skills require macOS with the respective Apple apps signed into iCloud. This skill will decline gracefully on Windows or Linux.

## Sub-skills

### apple-notes

Create, view, search, and edit Apple Notes via the `memo` CLI. Notes sync across all Apple devices via iCloud.

> See: [./apple-notes/SKILL.md](./apple-notes/SKILL.md)

**When to invoke**: User mentions "Apple Notes", "Notes app", creating a note, searching notes, or reading notes.

### apple-reminders

Manage Apple Reminders via `remindctl`. Tasks and lists sync to iPhone/iPad/Mac via iCloud.

> See: [./apple-reminders/SKILL.md](./apple-reminders/SKILL.md)

**When to invoke**: User mentions "reminder", "to-do", "task list", "Apple Reminders", or calendar-like task management.

### findmy

Track Apple devices and AirTags via FindMy.app. Uses AppleScript + screen capture + `peekaboo` for UI automation.

> See: [./findmy/SKILL.md](./findmy/SKILL.md)

**When to invoke**: User asks "where is my [device]", "find my AirTag", "track my [device]", or mentions Find My app.

### imessage

Send and receive iMessage/SMS via the `imsg` CLI. Works with any phone number or Apple ID contact.

> See: [./imessage/SKILL.md](./imessage/SKILL.md)

**When to invoke**: User asks to "text", "message", "iMessage", or "send a message to [contact]".

## Safety posture

- **apple-notes**: read operations are automatic; writes (create/edit/delete) require user confirmation.
- **apple-reminders**: create/complete/delete require user confirmation.
- **findmy**: read-only location queries; no write operations.
- **imessage**: send operations always require explicit user confirmation with recipient and message content before delivery.

## Prerequisites

Each sub-skill requires its own CLI tool installed via Homebrew:

| Sub-skill | CLI tool | Homebrew install |
|---|---|---|
| `apple-notes` | `memo` | `brew tap antoniorodr/memo && brew install memo` |
| `apple-reminders` | `remindctl` | `brew install steipete/tap/remindctl` |
| `findmy` | `peekaboo` (optional) | `brew install steipete/tap/peekaboo` |
| `imessage` | `imsg` | `brew install steipete/tap/imsg` |

Grant the necessary system permissions (Automation, Full Disk Access, Screen Recording) when prompted by macOS.

## Usage guidance

Do not suggest this skill for cross-platform scenarios. If the user is on iOS-only without a Mac, explain that these capabilities require macOS. If the user mentions a specific Apple first-party app (Notes, Reminders, Find My, Messages), route to the appropriate sub-skill.
