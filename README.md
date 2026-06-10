# DUYA

<p align="center">
 <img src="assets/icon.png" width="120" alt="DUYA Logo">
</p>

<p align="center">
 <strong>A local-first desktop workspace for AI agents.</strong>
</p>

<p align="center">
 Browser automation, coding workflows, local tools, plugins, and agent control — in one app built for normal users, not only terminal power users.
</p>

<p align="center">
 <a href="https://github.com/lava-chen/duya/releases">Download</a>
 ·
 <a href="#demo">Demo</a>
 ·
 <a href="#why-duya">Why DUYA</a>
 ·
 <a href="#features">Features</a>
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

---

## Demo

![DUYA demo](assets/demo.gif)

DUYA brings powerful agent workflows out of terminals, IDE extensions, and browser tabs — into a real desktop app.

It lets an AI agent work with your browser, files, terminal commands, research materials, plugins, skills, and MCP-style tools, while keeping important actions visible and approval-based.

> DUYA is currently in beta. Expect rough edges, fast iteration, and frequent improvements.

---

## Why DUYA?

AI agents are becoming powerful, but most of them still feel like tools for developers.

Some live in terminals. Some are tied to IDEs. Some hide tool execution behind logs. Some require config files before you can do anything useful. That makes them powerful, but also intimidating for many users.

DUYA takes a different path.

It brings agent workflows into a local-first desktop app with guided onboarding, visual tool execution, browser automation, local persistence, and explicit user control.

The goal is not blind autonomy. The goal is controlled agency.

---

## What makes DUYA different?

| Tool type | Strength | Gap DUYA tries to fill |
| --- | --- | --- |
| Coding agents | Great at project-level coding tasks | Often tied to terminal or IDE workflows |
| Autonomous local agents | Powerful long-running automation | Hard to supervise without clear controls |
| Browser chatbots | Easy to use | Limited access to local tools and real web interaction |
| Browser automation agents | Can operate websites | Often disconnected from local workspace and agent memory |
| DUYA | Desktop app + local tools + browser automation + visual control | A more approachable agent workspace for everyday users |

---

## Features

### A real desktop app

DUYA is not a terminal wrapper and not another browser tab. It is a native desktop application with sessions, settings, system integration, local persistence, and visual tool cards.

You install it, configure your provider, and start working from a familiar app interface.

### Strong browser automation

Many agents can fetch web pages. DUYA is designed to use the browser more like a real user.

Agents can open pages, click elements, type into inputs, scroll, manage tabs, execute browser actions, and capture screenshots. This makes DUYA useful for tasks that cannot be solved by simple HTML fetching.

### Local-first agent workflows

DUYA stores conversations and workspace data locally by default. Your data lives on your machine, not in a DUYA cloud service.

You choose your model provider, configure your own API key, and keep control of how agents connect to external services.

### Visual control over tool use

When an agent wants to run a command, touch files, browse the web, or use tools, DUYA can show the action before it happens.

Tool calls are displayed as visible UI cards instead of disappearing into logs. Sensitive actions can require approval, so you can inspect what the agent is about to do.

### Built for beginners, extensible for power users

DUYA is designed to be usable even if you have never used a terminal agent before.

At the same time, advanced users can customize providers, agent profiles, plugins, skills, and MCP-style integrations to build more powerful local workflows.

### Durable sessions

DUYA persists conversation history and agent state locally, so your work is not tied to one fragile process. If the app restarts or a session fails, your messages should remain recoverable.

---

## Screenshots

> Replace these placeholders with real screenshots before a public launch.

### Agent actions are visible

![Agent action cards](assets/screenshots/agent-run.png)

### Browser automation

![Browser automation](assets/screenshots/browser-automation.png)

### Local agent settings

![Agent settings](assets/screenshots/settings.png)

### Plugin, skill, and MCP control

![Capability management](assets/screenshots/capabilities.png)

---

## Download

DUYA is currently in beta.

Download the latest installer from [Releases](https://github.com/lava-chen/duya/releases).

| Platform | Installer |
| --- | --- |
| Windows | `.exe` |
| macOS | `.dmg` |
| Linux | `.AppImage` |

After installation, open DUYA, choose your language, configure an AI provider, paste your API key, and start a session.

---

## Quick start

1. Download DUYA from [Releases](https://github.com/lava-chen/duya/releases).
2. Open the app.
3. Choose your language.
4. Add an AI provider and API key.
5. Start chatting with an agent.
6. Approve or deny tool actions as they appear.

Your API key is stored with OS-level protection and used only when DUYA talks to your selected model provider.

---

## Privacy and security

DUYA is designed as a local-first desktop app.

Your conversations and workspace data are stored in a local SQLite database. DUYA does not rely on cloud storage for your workspace data, and it is designed to avoid telemetry-first behavior.

API keys are encrypted using OS-level protection and masked in the UI.

Sensitive actions are controlled by permission prompts. Terminal commands, file operations, browser actions, and other tools can require approval before execution.

DUYA also applies guardrails around risky surfaces, including protected system paths and browser-side protections for localhost and internal network access.

Security is not treated as a single switch. DUYA's direction is to make agent actions visible, inspectable, and controllable.

---

## Vision: beyond chat

Most agent interfaces are still chat-first: you type a message, the agent replies, and tools run somewhere in the background.

DUYA is moving toward a conductor-style interaction model.

The goal is to let users coordinate agents, tasks, browser sessions, documents, local tools, generated artifacts, and evolving context inside a shared desktop workspace — not just a message thread.

Instead of treating the agent as a chatbot, DUYA treats the agent as a visible participant in an ongoing workflow.

---

## Architecture

DUYA is built as a desktop application with separated UI, Electron main process, local persistence, and agent runtime packages.

Core stack:

- Electron
- React
- TypeScript
- SQLite
- browser automation backend
- isolated agent runtime
- plugin / skill / MCP-oriented extension layer
- packaged app verification scripts

The project is organized around a few core ideas:

- local-first storage
- visible tool execution
- approval-based sensitive actions
- isolated agent sessions
- extensible capability management

For development details, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Development

DUYA uses TypeScript, React, Electron, and SQLite.

```bash
git clone https://github.com/lava-chen/duya.git
cd duya
npm install
npm run electron:dev
```

Common commands:

| Command | Purpose |
| --- | --- |
| `npm run electron:dev` | Start DUYA in development mode |
| `npm run electron:build` | Build the Electron app |
| `npm run electron:pack` | Package the desktop app |
| `npm run typecheck:all` | Run TypeScript checks |
| `npm run test` | Run tests |

--
