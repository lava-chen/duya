<p align="center">
  <img src="./assets/readme/hero.gif" width="100%" alt="Duya — a local-first desktop AI agent that turns research, files, and tool output into an editable project canvas">
</p>

<h1 align="center">Duya</h1>

<p align="center">
  A local-first desktop AI agent that works inside your projects while keeping its tools, changes, and permission decisions visible.
</p>

<p align="center">
  <a href="https://github.com/lava-chen/duya/releases">
    <img src="https://img.shields.io/github/v/release/lava-chen/duya?style=flat-square" alt="Latest GitHub release">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="MIT License">
  </a>
</p>

> **Public beta:** Duya is usable today, but onboarding, packaged builds, and some experimental workflows still need broader real-world testing. Expect visible rough edges and frequent releases.

Duya is for people who want an agent to do more than answer in a chat box. Open a project, give it a task, and let it research the web, inspect files, run commands, and create useful outputs without hiding the execution behind a remote job.

"Local-first" describes the workspace and application state, not every model call. Conversations, sessions, tool history, settings, and project references are kept on your computer. When you use a remote model provider, the prompt and the context needed for that request are sent to that provider. You can also connect a local Ollama instance when you want model inference to stay on your machine.

---

## One task, end to end

Start with one concrete task:

```text
Research how local-first AI agents differ from cloud agents.
Use the browser to collect reliable sources, then create a cited Markdown note in this project.
```

During the run, Duya can:

1. Open and navigate pages in its browser instead of relying only on search snippets.
2. Show browser, file, and terminal activity as tool cards you can inspect.
3. Pause for approval when the selected permission mode requires it.
4. Write the finished note into the project so it remains useful after the chat ends.

You can send a correction or new constraint while the task is still running. Duya will apply it at a safe checkpoint or queue it for the next turn rather than making you restart the session.

---

## Why a desktop agent?

- **Work where the files already are.** Choose a project folder and give the agent access to the context it needs instead of uploading the whole workspace to a separate environment.
- **See the work, not just the answer.** Browser actions, file operations, terminal output, permission requests, and generated artifacts stay attached to the conversation.
- **Keep control during long tasks.** Interrupt a run, add instructions, switch permission modes, or continue later from locally persisted session history.
- **Bring your own model.** Configure a hosted provider, an OpenAI- or Anthropic-compatible endpoint, or local Ollama, then choose which models are available in the app.

---

## What can Duya do?

<img src="./assets/readme/section-what.svg" width="100%" alt="What can Duya do? Browser, files, shell, canvas, and MCP capabilities">

### Research with an interactive browser

Open pages, click controls, type into forms, scroll, manage tabs, take screenshots, and inspect page or network output. This is useful when research requires interacting with a website rather than calling a search API once.

### Read and change project files

Search, read, create, and edit files in the selected workspace. File changes remain ordinary project files, and generated or modified files can be opened from their tool cards.

### Run terminal workflows

Execute shell commands, review their output, and use the result in the next step of a task. The default **Ask** permission mode separates routine reads from actions that require approval; **Auto** and **Bypass** are explicit opt-in modes with warnings.

### Give the agent durable project context

Pin the notes, specifications, agent instructions, and other reference files that should guide the work. Duya uses those references with the current project and session instead of guessing from unrelated files.

### Create and inspect artifacts

Render Markdown, diagrams, charts, dashboards, document previews, and interactive widgets inside the workspace. Keep the explanation in chat while opening the resulting file or visual beside it.

### Extend the tool surface

Install Skills, connect MCP servers, and use plugins to add specialized instructions and tools. These capabilities stay visible in the app rather than becoming an invisible global prompt.

### Organize work on a canvas

Conductor is an experimental project canvas for documents, shapes, tables, links, and agent-created diagrams. It is available for exploratory workflows, but it should not yet be treated as a fully stabilized core path.

---

## Quick start

### 1. Download a beta build

Get the latest package from [GitHub Releases](https://github.com/lava-chen/duya/releases).

| Platform | Package | Beta status |
| --- | --- | --- |
| Windows x64 | `.exe` installer | Primary packaged test path |
| macOS Intel / Apple silicon | `.dmg` | Available, with less smoke-test coverage |
| Linux | `.AppImage`, `.deb`, or `.rpm` | Available, with less smoke-test coverage |

### 2. Configure a model

In the provider settings, choose one of these paths:

- Connect a hosted provider or compatible API endpoint and enter its API key.
- Connect local Ollama, which does not require a hosted-model API key.

Duya includes presets for common providers and also accepts compatible custom endpoints. Provider availability, model access, pricing, and data handling remain subject to the provider you choose.

### 3. Open a project

Choose the folder Duya should work in. This folder becomes the task's project context and default working directory for file search, edits, commands, references, and generated outputs.

### 4. Run the first task

Use the end-to-end research prompt above. A successful first run should show browser activity in the conversation and produce a Markdown note inside the selected project.

---

## Privacy and control

<img src="./assets/readme/section-privacy.svg" width="100%" alt="Privacy and control with permission prompts enabled">

Duya keeps application state local, but local-first is not the same as offline or end-to-end encrypted.

### What stays on your computer

- Conversation history, session state, tool results, and project references are persisted locally.
- Project files are read and changed in the workspace you selected.
- Provider configuration is stored in Duya's local app-data directory.
- API keys are protected with Electron `safeStorage` when operating-system encryption is available, and Duya requests owner-only permissions for the configuration file on platforms that support them. If `safeStorage` is unavailable, the configuration remains local but should not be treated as encrypted at rest.

### What can leave your computer

- A remote model provider receives the prompts, conversation context, tool results, and file-derived context needed for each model request.
- Browser research contacts the websites you ask Duya to visit.
- Connected MCP servers, plugins, gateways, and other external services follow their own data paths and policies.

Using local Ollama can keep model inference local, but browser requests and any external tools you enable still use the network. Duya's local database and ordinary project files are not end-to-end encrypted by Duya itself, so operating-system account and disk security still matter.

### Permission modes

- **Ask** is the safe default. Routine reads can proceed while writes, edits, commands, or other protected actions can pause for a decision according to the active permission rules.
- **Auto** reduces prompts for approved categories of work.
- **Bypass** grants broad execution authority and should only be enabled when you understand the workspace and task.

Tool calls remain visible in the conversation, and switching to a less restrictive mode requires an explicit confirmation in the UI.

---

## Architecture

<img src="./assets/readme/workflow.svg" width="100%" alt="Duya architecture overview">

Duya separates responsibilities so one chat loop does not own the entire application:

- The **renderer** presents chat, tool cards, project panels, previews, and canvases.
- The **Electron main process** owns local persistence, application services, IPC, and agent-process lifecycle.
- **Agent workers** run in child processes and communicate through the local Agent Server and IPC boundaries.
- Browser, file, shell, Skill, MCP, memory, and canvas capabilities are exposed as tools rather than hidden side effects.

This process separation improves interruption, recovery, and session isolation. It is not a promise of a hardened operating-system sandbox on every platform.

Core stack: Electron, Vite, React 19, TypeScript, SQLite / better-sqlite3, HTTP + SSE, and child-process agent workers. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the detailed data flows and [docs/SECURITY.md](./docs/SECURITY.md) for the current security model and limitations.

---

## Beta status and known limits

Duya is still a public beta. Before relying on it for sensitive or irreplaceable work, keep normal backups and review the selected permission mode.

Current limits include:

- First-run onboarding and packaged upgrade paths still need broader real-user testing.
- macOS and Linux packages have less smoke-test coverage than the Windows build.
- Conductor and several advanced workspace workflows remain experimental.
- Process isolation is implemented, but sandbox guarantees and tool restrictions vary by platform and configuration.
- Provider behavior, availability, cost, and retention policies are controlled by the provider you connect.

---

## Development

```bash
npm install
npm run electron:dev   # start Vite and Electron
npm run electron:build # build the desktop application
npm run typecheck:all  # type-check every workspace
npm run test           # run unit tests
```

Useful packaging and diagnostic commands:

```bash
npm run electron:pack
npm run electron:verify:packaged
npm run diagnose:env
```

### Repository structure

```text
src/                  Renderer UI
electron/             Electron main process, IPC, and local services
packages/agent/       Agent runtime, tools, prompts, and modes
packages/cli/         Desktop control-plane CLI
packages/conductor/   Canvas and Conductor subsystem
packages/gateway/     External channel gateway package
scripts/              Build, bundle, packaging, and diagnostics
docs/                 Architecture, execution plans, and release notes
```

Before contributing, read [AGENTS.md](./AGENTS.md) and check the active work in [docs/exec-plans/README.md](./docs/exec-plans/README.md).

---

## License

[MIT](./LICENSE)
