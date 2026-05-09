# Contributing to DUYA

Thank you for your interest in contributing to DUYA! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Community](#community)

## Code of Conduct

This project and everyone participating in it is governed by our commitment to:

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on constructive feedback
- Respect different viewpoints and experiences

## Getting Started

### Prerequisites

- **Node.js** 18+ and **npm** 9+
- **Git**
- A code editor (VS Code recommended)

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/duya.git
   cd duya
   ```
3. Add the upstream repository:
   ```bash
   git remote add upstream https://github.com/lava-chen/duya.git
   ```

## Development Setup

```bash
# Install dependencies
npm install

# Start development server
npm run electron:dev

# Run type checking
npm run typecheck:all

# Run tests
npm run test
```

## How to Contribute

### Reporting Bugs

Before creating a bug report, please:

1. Check if the issue already exists in the [issue tracker](https://github.com/lava-chen/duya/issues)
2. Use the latest version to verify the bug still exists
3. Collect information about the bug (steps to reproduce, expected behavior, actual behavior)

When reporting a bug, include:

- **Clear title and description**
- **Steps to reproduce**
- **Expected behavior**
- **Actual behavior**
- **Screenshots** (if applicable)
- **Environment details** (OS, Node version, DUYA version)
- **Relevant logs** from `app.log` or DevTools console

### Suggesting Features

Feature requests are welcome! Please:

1. Check if the feature has already been suggested
2. Provide a clear use case and describe the problem it solves
3. Explain why this feature would be useful to most DUYA users

### Contributing Code

#### Finding Issues to Work On

- Look for issues labeled `good first issue` or `help wanted`
- Comment on the issue to let others know you're working on it
- Ask questions if anything is unclear

#### Creating a Branch

```bash
# Sync with upstream
git fetch upstream
git checkout main
git merge upstream/main

# Create your feature branch
git checkout -b feature/your-feature-name
```

Use descriptive branch names:
- `feature/add-calendar-widget`
- `fix/memory-leak-in-streaming`
- `docs/update-api-reference`

## Pull Request Process

1. **Ensure your code meets our standards**
   - Run `npm run typecheck:all` — must pass
   - Run `npm run test` — all tests should pass
   - Follow our coding standards (see below)

2. **Update documentation**
   - Update relevant documentation if needed
   - Add comments to complex code sections

3. **Create the pull request**
   - Fill out the PR template completely
   - Link any related issues with `Fixes #123` or `Closes #456`
   - Provide a clear description of what changed and why

4. **Review process**
   - Maintainers will review your PR
   - Address any requested changes
   - Once approved, a maintainer will merge your PR

### PR Title Format

```
<type>: <short description>

Examples:
feat: add Pomodoro widget to Conductor
fix: resolve SQLite connection leak
docs: update architecture diagram
refactor: simplify AgentProcessPool logic
```

Types:
- `feat` — New feature
- `fix` — Bug fix
- `docs` — Documentation changes
- `style` — Code style changes (formatting, semicolons, etc.)
- `refactor` — Code refactoring
- `test` — Adding or updating tests
- `chore` — Build process or auxiliary tool changes

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Enable strict mode checks
- Define explicit return types for public functions
- Avoid `any` type — use `unknown` with type guards instead

### Code Style

- Use meaningful variable and function names
- Keep functions small and focused
- Write self-documenting code; comments explain "why", not "what"
- Follow existing patterns in the codebase

### File Organization

```
src/
├── components/     # React components
│   └── feature/    # Group by feature
├── hooks/          # Custom React hooks
├── lib/            # Utility functions
├── stores/         # Zustand stores
└── types/          # TypeScript types
```

### Comments

- Use English for all code comments
- Document complex business logic
- Use JSDoc for public APIs

Example:
```typescript
/**
 * Spawns a new agent process with the given configuration.
 * @param config - The agent configuration
 * @returns The process ID of the spawned agent
 * @throws {AgentError} If the process fails to spawn
 */
async function spawnAgent(config: AgentConfig): Promise<string> {
  // Implementation
}
```

## Commit Message Guidelines

We follow conventional commits:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Rules

1. **Subject line**: Maximum 50 characters, use imperative mood
2. **Body**: Wrap at 72 characters, explain what and why
3. **Footer**: Reference issues and breaking changes

### Examples

```
feat(conductor): add TaskList widget with CRDT support

Implement the first Conductor widget with operational transform
for conflict resolution when user and agent edit simultaneously.

Closes #123
```

```
fix(agent): resolve race condition in MessagePort

Ensure proper cleanup of MessagePort connections when agent
process exits unexpectedly. Prevents memory leaks in main process.

Fixes #456
```

## Architecture Guidelines

Before making significant architectural changes:

1. Read [ARCHITECTURE.md](./ARCHITECTURE.md)
2. Read [AGENTS.md](./AGENTS.md) for development workflow
3. Discuss major changes in an issue first
4. Update architecture docs if your change affects the design

### Key Principles

- **Process isolation** — Agent runs in separate process
- **SQLite single-writer** — Only Main Process writes to database
- **MessagePort for streaming** — Use persistent channels for high-frequency data
- **Local-first** — All data stays on user's machine

## Testing

### Writing Tests

- Write tests for new features
- Update tests when modifying existing functionality
- Aim for meaningful test coverage, not just high percentages

### Test Structure

```typescript
describe('FeatureName', () => {
  describe('when condition', () => {
    it('should behave as expected', () => {
      // Test code
    });
  });
});
```

### Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

## Documentation

### Code Documentation

- Document public APIs with JSDoc
- Include examples in documentation
- Keep comments up-to-date with code changes

### User Documentation

- Update README.md if adding user-facing features
- Add entries to docs/product-specs/ for new features
- Update troubleshooting section for common issues

## Release Process

Maintainers handle releases:

1. Version bump follows [SemVer](https://semver.org/)
2. Update CHANGELOG.md
3. Create GitHub release with notes
4. Build and upload artifacts

## Community

### Getting Help

- GitHub Discussions: For questions and ideas
- GitHub Issues: For bugs and feature requests
- Check existing documentation first

### Recognition

Contributors will be:
- Listed in CONTRIBUTORS.md
- Mentioned in release notes for significant contributions
- Invited to collaborate on larger features after consistent contributions

## Questions?

If you're unsure about anything:

1. Check existing issues and discussions
2. Ask in a new discussion thread
3. Comment on the relevant issue

Thank you for contributing to DUYA! 🎉

---

## Contributor License Agreement

By contributing to DUYA, you agree that:

1. You have the right to submit your contribution
2. Your contribution is provided under the MIT License
3. You grant the project maintainers the right to use, modify, and distribute your contribution
4. Your contribution does not violate any third-party rights

This is a standard open source contribution agreement. It protects both contributors and the project.
