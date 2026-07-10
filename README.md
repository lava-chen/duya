# Duya

<p align="center">
  <img src="assets/icon.png" width="120" alt="Duya Logo">
</p>

<p align="center">
  <strong>A local-first desktop AI agent for research, files, code, and visible workflows.</strong>
</p>

<p align="center">
  Duya lets an AI agent work inside your desktop workspace — using your browser, local files, terminal, project references, plugins, skills, and MCP-style tools — while keeping important actions visible and permission-based.
</p>

<p align="center">
  <a href="https://github.com/lava-chen/duya/releases">Download</a>
  ·
  <a href="#demo">Demo</a>
  ·
  <a href="#what-can-duya-do">What can Duya do?</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#privacy-and-control">Privacy & control</a>
  ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <a href="https://github.com/lava-chen/duya/releases">
    <img src="https://img.shields.io/github/v/release/lava-chen/duya?style=flat-square" alt="GitHub release">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="MIT License">
  </a>
  <a href="https://github.com/lava-chen/duya/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/lava-chen/duya/ci.yml?style=flat-square" alt="CI">
  </a>
</p>

> Duya is currently in public beta. It is usable, but still rough. Expect fast iteration, visible bugs, and frequent release notes.

---

## Demo

![Duya demo](assets/demo.gif)

Duya is not just another chat box. It is a desktop workspace where an agent can browse, read files, edit files, run commands, inspect project references, create visual artifacts, and ask for permission before sensitive actions.

A good first task is:

```text
Research how local-first AI agents are different from cloud agents.
Use the browser to collect sources, then create a markdown note in this project.
```

---

## Why Duya?

Most AI agent tools fall into one of three buckets.

Some are powerful but live in terminals. They are great for developers, but intimidating for normal users.

Some are chat-first. They are easy to use, but they cannot really operate inside your local workspace.

Some are cloud agents. They can run long tasks, but they often hide execution details and move sensitive work away from your own computer.

Duya takes a different path.

It brings agent workflows into a local-first desktop app with visible tool execution, browser automation, file access, terminal integration, project references, plugins, skills, and permission prompts.

The goal is not blind autonomy.

The goal is controlled agency.

---

## What can Duya do?

### Research with a real browser

Duya can use browser actions instead of only fetching static HTML.

It can open pages, click elements, type into inputs, scroll, manage tabs, capture screenshots, read network output, and use browser snapshots to understand pages.

This makes it useful for research tasks where an agent needs to interact with the web like a user, not just call a search API.

Example task:

```text
Use the browser to research three recent AI coding agent tools.
Create a markdown comparison with links, strengths, weaknesses, and what Duya can learn from them.
```

### Work with local files

Duya can read, search, write, and edit files in your local workspace.

It supports common agent coding tools such as read, grep, glob, edit, write, bash, PowerShell, and file preview surfaces. It can also open generated or modified files from tool cards.

Example task:

```text
Read this project folder and create a short project brief:
- what the project does
- important files
- how to run it
- possible risks or TODOs
```

### Use project references

Duya supports project-level reference files.

You can curate files that should matter to the agent, such as project notes, `.duya` files, `.agents` files, `.claude` files, design docs, or task context. The agent can use these references as part of its working context instead of guessing from scattered files.

Example task:

```text
Use the project references and summarize the current product direction.
Then suggest the next three tasks for a public beta launch.
```

### Preview documents and code

Duya includes workspace panels for file preview and document-oriented work.

It can preview local files, source code, Office-style documents, and notebooks through the app's side panel, so you do not have to leave the agent workspace just to inspect context.

Example task:

```text
Read this report draft and the source data file.
Summarize what is missing, then suggest edits before submission.
```

### Run terminal workflows

Duya integrates a terminal surface through the desktop workspace.

The agent can run shell commands when permitted, inspect outputs, and use terminal results as part of the task loop. Sensitive commands can be permission-gated.

Example task:

```text
Run the test suite, inspect the first failing test, and propose a minimal fix.
Ask before editing files.
```

### Continue instructions during a run

Duya includes an Agent Mailbox-style interaction model.

While an agent is running, you can send follow-up instructions into the active task instead of waiting for the whole run to finish. This makes long-running tasks easier to steer.

Example:

```text
Actually focus more on the onboarding flow. Ignore the payment feature for now.
```

### Create visual artifacts

Duya can render widgets, diagrams, dashboards, charts, and mini visualizations inside the chat.

Generated widgets are passed through a visual self-review pipeline so the agent can inspect and improve the rendered result instead of only generating raw markup.

Example task:

```text
Create a visual flow diagram showing how a desktop agent should ask for permission before using local tools.
```

### Use Conductor canvas workflows

Duya includes an experimental Conductor mode for canvas-based agent work.

The Conductor stack supports canvas elements, smart layout, viewport-aware packing, alignment-first snapping, collision handling, auto layout tools, and agent-driven canvas operations.

This is experimental, but it points toward Duya's longer-term direction: not just chatting with an agent, but coordinating tasks, artifacts, context, and visual workflows in one desktop space.

---

## What makes Duya different?

| Type            | Good at                 | Limitation                                 | Duya's direction                               |
| --------------- | ----------------------- | ------------------------------------------ | ---------------------------------------------- |
| Chat assistants | Easy conversation       | Limited local action                       | Give the agent real desktop tools              |
| Coding agents   | Codebase tasks          | Often terminal or IDE-first                | Make agent work visible in a desktop app       |
| Browser agents  | Web interaction         | Often disconnected from files and projects | Combine browser + local workspace              |
| Cloud agents    | Long-running tasks      | Less local control and visibility          | Keep the user's computer as the main workspace |
| Duya            | Desktop agent workflows | Still beta                                 | Local-first, visible, permission-based agency  |

---

## Quick start

### 1. Download

Download the latest beta from:

```text
https://github.com/lava-chen/duya/releases
```

### 2. Install

Supported package targets:

| Platform | Installer                           |
| -------- | ----------------------------------- |
| Windows  | `.exe`                              |
| macOS    | `.dmg`                              |
| Linux    | `.AppImage` / related Linux targets |

Windows is currently the most tested path. macOS and Linux builds may need more smoke testing.

### 3. Configure a model provider

Open Duya and configure an AI provider.

Duya supports a multi-provider setup. You can add provider credentials, choose a default provider, fetch available model lists where supported, and switch providers per workflow.

Your API key is stored locally with OS-level protection and masked in the UI.

### 4. Run a first task

Try one of these tasks first:

```text
Use the browser to research one topic and create a markdown note.
```

```text
Read this project folder and summarize what the project does.
```

```text
Inspect this small codebase, run tests if needed, and suggest one safe fix.
Ask before editing files.
```

### 5. Review tool actions

When Duya uses tools, it renders visible tool cards.

For sensitive operations such as terminal commands, file edits, browser actions, or permission-specific tools, Duya can ask for approval before continuing.

---

## Example tasks

### Research

```text
Research the current state of local-first AI agents.
Use browser sources, compare several tools, and create a markdown note with links.
```

### Document review

```text
Read the report in this folder.
Find missing sections, unclear reasoning, formatting issues, and data-processing gaps.
Return a concise revision checklist.
```

### Code task

```text
Inspect this repository.
Find how the app starts, identify the key modules, and suggest one small improvement.
Do not edit files until I approve.
```

### File organization

```text
Read the files in this folder.
Group them by purpose, summarize each group, and create a TODO list for cleanup.
```

### Visual explanation

```text
Create a diagram explaining the flow:
user request → agent plan → tool permission → local action → artifact review.
```

---

## Privacy and control

Duya is designed as a local-first desktop app.

Your conversations and workspace data are stored locally by default. Duya does not require a Duya cloud workspace for your local agent sessions.

You choose your model provider and API key. Model requests are sent to the provider you configure.

Tool actions are visible. Sensitive actions can require explicit approval.

Duya uses local persistence so sessions, tool outputs, and task state are not tied to one fragile process.

Current control surfaces include:

* local SQLite-backed workspace data
* visible tool cards
* permission prompts for sensitive actions
* provider credential masking
* project-level references
* local file preview and generated artifact inspection
* CLI control-plane operations for advanced users

Security is not treated as a single switch. Duya's direction is to make agent actions visible, inspectable, and controllable.

---

## Current beta status

Duya is in active beta.

Recently landed work includes:

* multi-provider architecture
* Agent Mailbox for in-run instruction updates
* typed permission flow
* Codex-aligned chat composer
* right-side multi-tab workspace panel
* Office and notebook preview workspaces
* terminal panel
* project references panel
* plugin / skill / MCP-oriented extension layer
* CLI control plane
* widget rendering and visual self-review
* Conductor canvas smart layout
* stability audit across LLM clients, agent core, tools, worker/IPC, database, and research mode

Known beta caveats:

* onboarding still needs real-user testing
* some workflows are rough or experimental
* macOS and Linux packages may need more smoke testing
* Conductor/canvas features are experimental
* enterprise workspace features are not the current public-beta focus

---

## Architecture

Duya is built as a desktop application with separated UI, Electron main process, local persistence, and isolated agent runtime packages.

Core stack:

* Electron
* Vite
* React
* TypeScript
* SQLite / better-sqlite3
* child process based agent runtime
* HTTP + SSE / IPC bridge
* browser automation backend
* plugin / skill / MCP-oriented extension layer
* `@duya/agent`
* `@duya/cli`
* `@duya/conductor`
* `@duya/gateway`

At a high level:

```text
Renderer UI
  ↕
Electron Main Process
  ↕
Agent Server / IPC / SQLite
  ↕
Isolated Agent Worker Processes
  ↕
Tools: browser, files, shell, memory, skills, MCP, conductor
```

This structure is designed so agent runs can be isolated, persisted, interrupted, and recovered more reliably than a single in-process chat loop.

---

## Development

Install dependencies:

```bash
npm install
```

Run the desktop app in development:

```bash
npm run electron:dev
```

Build the app:

```bash
npm run electron:build
```

Package for the current platform:

```bash
npm run electron:pack
```

Run type checks:

```bash
npm run typecheck:all
```

Run tests:

```bash
npm run test
```

Useful scripts:

```bash
npm run build:agent
npm run build:cli
npm run build:conductor
npm run build:gateway
npm run electron:verify:packaged
npm run diagnose:env
```

---

## Repository structure

```text
src/                  Renderer UI
electron/             Electron main process, IPC, local services
packages/agent/       Agent runtime, tools, prompts, modes
packages/cli/         Desktop control-plane CLI
packages/conductor/   Canvas / conductor subsystem
packages/gateway/     External channel gateway package
scripts/              Build, bundle, packaging, diagnostics
docs/                 Architecture, execution plans, release notes
```

---

## Roadmap

Near-term focus:

* improve first-run onboarding
* make the first successful task easier
* polish browser and file workflows
* improve error messages and recovery
* add more real-world demo tasks
* refine permission prompts
* stabilize public beta packages

Longer-term direction:

* deeper local workflow orchestration
* better project memory and reference management
* stronger visual self-review loops
* more reliable long-running tasks
* team / workspace integration through controlled enterprise plugins

---

## Feedback

Duya is looking for early users who are willing to test real tasks and report rough edges.

The most useful feedback is:

* installation failed
* model provider setup was confusing
* first task did not complete
* tool permission felt unsafe or unclear
* browser automation failed
* file preview or file editing was confusing
* you would not open Duya a second time, and why

Open an issue, start a discussion, or contact the maintainer with a concrete task that failed.

---

## License

MIT
