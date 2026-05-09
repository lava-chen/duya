# DUYA

<p align="center">
  <img src="assets/icon.png" width="120" alt="DUYA Logo">
</p>

<p align="center">
  <strong>The AI agent that lives on your desktop — not a browser tab, not a terminal. A real app, for real people.</strong>
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

## Why DUYA?

Most AI agents live in terminals or browser tabs — tools built for developers, by developers. DUYA is different. It's a **native desktop application** for Windows, macOS, and Linux. Double-click to install. No command line required.

| Other agents | DUYA |
|-------------|------|
| CLI or web chat | **Real desktop app** — native windows, system tray, notifications |
| Basic web fetch at best | **Real browser automation** — navigate, click, type, screenshot. 23 actions across 3 backends |
| One agent, one session | **Multi-Agent Process Pool** — each session runs in its own process. One crash never kills another |
| Data in the cloud | **100% local** — SQLite on your machine. No cloud storage. No telemetry |
| Config files and env vars | **Guided onboarding** — pick your language, paste your key, start chatting in under a minute |
| Limited permissions | **Full approval control** — every tool action asks you first. Nothing runs behind your back |

---

## Download

Get the installer from [Releases](https://github.com/lava-chen/duya/releases). Double-click, install, done.

| Platform | File | How to install |
|----------|------|----------------|
| **Windows** | `DUYA Setup x.x.x.exe` | Double-click, follow the wizard |
| **macOS** | `DUYA-x.x.x-arm64.dmg` / `x64.dmg` | Open `.dmg`, drag to Applications |
| **Linux** | `DUYA-x.x.x.AppImage` | `chmod +x` then run |

> **Beta**: DUYA is in active development. Rough edges are expected — and your feedback makes them smooth.

---

## Getting Started

### 1. Install → 2. Configure → 3. Chat

**Install.** Download the installer. Run it. That's it.

**Configure.** First launch guides you through three steps: language, AI provider, API key. Your key is encrypted with OS-level protection and never leaves your device except when talking to your chosen provider.

**Chat.** Type a message. Hit Enter. Your agent answers questions, browses the web, reads files, runs commands, schedules tasks — and asks your permission before every action.

---

## What Makes DUYA Stand Out

**Real browser automation.** The hardest thing for an AI agent is actually *using* the web — not just fetching HTML, but clicking buttons, filling forms, taking screenshots. DUYA ships with a full browser engine (Playwright + Chrome DevTools Protocol). Your agent can navigate pages, click elements, type into inputs, scroll, hover, select dropdowns, execute JavaScript, manage multiple tabs, and take screenshots — 23 operations across 3 backends. And with SSRF protection, localhost and internal IPs are blocked by default.

**Visual UI that shows you what's happening.** Not a wall of text. Every tool action gets its own card with a dedicated icon — terminal, file, search, browser, sub-agent — and a real-time status dot: spinner while running, green check on success, red X on error. Tap to expand for full output. Permission prompts pop up inline showing exactly what the agent wants to do, with command and file path preview. Context usage bar tracks your LLM window with green/yellow/red gradient. Dark mode follows your OS. Glanceable, not guessable.

**Multi-Agent Profiles.** Different tasks need different agents. DUYA ships with 5 preset profiles — General, Code, Research, Explore, Plan — each with its own tool permissions and persona. Switch profiles per session. Need a specialist? Agents can spawn sub-agents for parallel research, code review, or task decomposition.

**Process isolation that actually works.** Every conversation runs in its own process. One agent crashes? Your other sessions keep running. Resource Governor caps CPU usage so your machine stays responsive. No single point of failure.

**Messages survive anything.** Every message hits the database before the agent touches it. Crash, power loss, force quit — your conversation history is intact. Reopen and pick up exactly where you left off.

**Privacy by default.** No cloud. No telemetry. No analytics. Your data is a SQLite file on your disk. The only network traffic goes to your AI provider. API keys are encrypted with OS-level safeStorage.

---

## Security

| Layer | What's protected |
|-------|-----------------|
| **API Keys** | OS-level encryption (safeStorage), masked in UI |
| **Bash Commands** | Sandboxed, sensitive env vars stripped, system paths write-protected |
| **Web Browsing** | localhost and internal IPs blocked by default (SSRF protection) |
| **File Access** | System directories (`/etc`, `C:\Windows`) unwritable |
| **Permissions** | Default mode = "ask" — you approve or deny every tool action |

---

## Development

DUYA is TypeScript, React 19, Electron 28, and SQLite. [CONTRIBUTING.md](CONTRIBUTING.md) has the full setup guide.

```bash
git clone https://github.com/lava-chen/duya.git
cd duya && npm install
npm run electron:dev
```

| Command | Purpose |
|---------|---------|
| `npm run electron:dev` | Dev mode |
| `npm run electron:build` | Production build |
| `npm run typecheck:all` | TypeScript check |
| `npm run test` | Run tests |

---

## License

MIT — [LICENSE](LICENSE)