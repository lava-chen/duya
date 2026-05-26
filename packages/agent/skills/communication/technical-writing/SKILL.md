---
name: technical-writing
description: "Write clear, effective technical documentation. Use when creating READMEs, design documents, API documentation, or any technical writing. Provides structure templates, clarity principles, and reader-centric approaches."
---

# Technical Writing

A systematic approach to writing clear, effective technical documentation that serves your readers.

---

## Core Principle

**Technical writing is not about showing what you know — it's about giving readers what they need.**

The best technical writing is invisible. Readers get what they need and move on without noticing the writing.

---

## Phase 1: Reader Analysis

### Know Your Audience

Before writing, be clear on who you're writing for:

```
READER PROFILE

Role: [Developer/Manager/End user/Researcher]
Technical level: [Beginner/Intermediate/Expert]
Context: [Evaluating/Implementing/Debugging/Learning]
Time available: [Quick scan/Deep read]
Goal: [What they need to accomplish]
```

### Reader-Centric Questions

| Question | Implication |
|----------|-------------|
| What do they already know? | Don't explain basics to experts |
| What are they trying to do? | Structure around tasks, not features |
| What's their urgency? | Put critical info first |
| What could confuse them? | Anticipate and address |
| What would delight them? | Add helpful extras |

---

## Phase 2: Document Types & Structures

### README Template

```markdown
# Project Name

One-sentence description of what this does and who it's for.

## Quick Start

```bash
# Installation
npm install package-name

# Basic usage
npx package-name --input file.txt
```

## Features

- ✨ Feature 1: Brief description
- 🚀 Feature 2: Brief description
- 🔧 Feature 3: Brief description

## Installation

### Prerequisites
- Node.js 18+
- Python 3.9+

### Setup
```bash
git clone https://github.com/user/repo.git
cd repo
npm install
```

## Usage

### Basic Example
```javascript
const lib = require('package-name');
const result = lib.process(data);
```

### Common Use Cases

#### Use Case 1: [Name]
```javascript
// Code example
```

#### Use Case 2: [Name]
```javascript
// Code example
```

## API Reference

### `functionName(param1, param2)`

Description of what this does.

**Parameters:**
- `param1` (string): Description
- `param2` (number): Description

**Returns:** (Type) Description

**Example:**
```javascript
// Usage example
```

## Configuration

| Option | Type