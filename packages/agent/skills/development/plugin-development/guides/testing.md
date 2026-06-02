# Plugin Testing Guide

Comprehensive guide for testing DUYA plugins during development and before release.

---

## Testing Strategy

### Testing Levels

```
TESTING PYRAMID

        /\
       /  \
      / E2E \      End-to-end tests (manual)
     /--------\
    / Integration \  Integration tests (plugin + DUYA)
   /--------------\
  /    Unit tests    \  Component tests (individual files)
 /--------------------\
```

### Test Categories

| Category | What to Test | Tools |
|----------|--------------|-------|
| **Syntax** | Valid YAML, JSON, Markdown | yamllint, jsonlint |
| **Structure** | File layout, required files | Custom scripts |
| **Loading** | Plugin loads without errors | DUYA dev mode |
| **Functionality** | Features work as expected | Manual testing |
| **Integration** | Works with other plugins | DUYA with multiple plugins |
| **Performance** | No significant slowdown | Timing measurements |

---

## Unit Testing

### YAML Frontmatter Validation

```bash
# Install yamllint
pip install yamllint

# Validate plugin.md
yamllint -d relaxed plugin.md

# Or use Node.js
npx yaml-lint plugin.md
```

### JSON Validation

```bash
# Validate all JSON files
for file in hooks/*.json mcp-servers/*.json ui/*.json; do
  if [ -f "$file" ]; then
    python -m json.tool "$file" > /dev/null && echo "✓ $file"
  fi
done
```

### Markdown Linting

```bash
# Install markdownlint
npm install -g markdownlint-cli

# Check all markdown files
markdownlint '**/*.md'
```

---

## Integration Testing

### Local Development Setup

```bash
# 1. Create development plugin directory
mkdir -p ~/.duya/dev-plugins/my-plugin
cd ~/.duya/dev-plugins/my-plugin

# 2. Copy your plugin files
cp -r /path/to/your/plugin/* .

# 3. Start DUYA in development mode
# (This loads plugins from dev-plugins directory)
```

### Loading Tests

#### Test 1: Plugin Discovery

```
STEPS:
1. Place plugin in ~/.duya/dev-plugins/
2. Start DUYA
3. Run /plugins command

EXPECTED:
- Plugin appears in list
- Version matches plugin.md
- Status shows as "enabled" or "disabled"
```

#### Test 2: Capability Registration

```
STEPS:
1. Enable plugin in settings
2. Check each capability:
   - For commands: Run /help, verify command appears
   - For skills: Trigger skill context, verify activation
   - For hooks: Trigger event, verify hook executes
   - For MCP: Check MCP connections panel

EXPECTED:
- All declared capabilities are registered
- No errors in console/logs
```

### Functionality Testing

#### Testing Skills

```
TEST CASE: Skill Activation

SETUP:
- Plugin with skill "code-review" installed
- File: test.py with code issues

STEPS:
1. Open test.py in editor
2. Ask DUYA: "Review this code"

EXPECTED:
- Skill "code-review" is activated
- Agent provides code review feedback
- Feedback follows skill guidelines

VERIFICATION:
□ Skill triggered correctly
□ Response quality matches skill definition
□ No errors in execution
```

#### Testing Commands

```
TEST CASE: Command Execution

SETUP:
- Plugin with command /deploy installed
- Valid project with deployment config

STEPS:
1. Type /deploy in chat
2. Select environment (dev)
3. Confirm deployment

EXPECTED:
- Command recognized and parsed
- Deployment executes successfully
- Success/failure message displayed

VERIFICATION:
□ Command appears in autocomplete
□ Parameters parsed correctly
□ Action executes as defined
□ Error handling works
```

#### Testing Hooks

```
TEST CASE: Hook Execution

SETUP:
- Plugin with PreToolUse hook for Bash
- Hook configured to echo message

STEPS:
1. Enable plugin
2. Execute Bash tool: ls -la

EXPECTED:
- Hook triggers before Bash execution
- Echo message appears in output
- Bash command still executes

VERIFICATION:
□ Hook triggers on correct event
□ Matcher filters correctly
□ Command executes
□ No infinite loops
```

#### Testing MCP Servers

```
TEST CASE: MCP Connection

SETUP:
- Plugin with filesystem MCP server
- Valid path configured

STEPS:
1. Enable plugin
2. Ask: "List files in /allowed/path"

EXPECTED:
- MCP server starts
- Connection established
- Files listed successfully

VERIFICATION:
□ MCP server process starts
□ Connection successful
□ Tools available
□ No permission errors
```

---

## End-to-End Testing

### User Journey Tests

#### Journey 1: First-Time User

```
PERSONA: New DUYA user discovering plugins

STEPS:
1. Open DUYA for first time
2. Navigate to Settings > Capabilities
3. Browse marketplace
4. Install plugin
5. Use plugin features

VERIFICATION POINTS:
□ Plugin discovery is intuitive
□ Installation process clear
□ Plugin works immediately
□ Documentation helpful
```

#### Journey 2: Plugin Developer

```
PERSONA: Developer creating new plugin

STEPS:
1. Read plugin development docs
2. Use template to create plugin
3. Test locally
4. Publish to GitHub
5. Submit to marketplace

VERIFICATION POINTS:
□ Templates are complete
□ Documentation clear
□ Testing tools available
□ Publishing process smooth
```

---

## Automated Testing

### GitHub Actions Workflow

Create `.github/workflows/test-plugin.yml`:

```yaml
name: Test Plugin

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Validate YAML frontmatter
        run: |
          npm install -g yaml-lint
          yaml-lint plugin.md

      - name: Validate JSON files
        run: |
          for file in hooks/*.json mcp-servers/*.json; do
            if [ -f "$file" ]; then
              python -m json.tool "$file" > /dev/null
            fi
          done

      - name: Lint Markdown
        run: |
          npm install -g markdownlint-cli
          markdownlint '**/*.md'

      - name: Check file structure
        run: |
          test -f plugin.md || exit 1
          echo "✓ plugin.md exists"
```

### Pre-commit Hooks

Create `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.4.0
    hooks:
      - id: check-json
      - id: check-yaml
      - id: end-of-file-fixer
      - id: trailing-whitespace

  - repo: local
    hooks:
      - id: validate-plugin
        name: Validate Plugin Structure
        entry: scripts/validate-plugin.sh
        language: script
        files: \.(md|json)$
```

---

## Performance Testing

### Startup Time

```bash
# Measure plugin loading time
time duya --load-plugin-only my-plugin

# Acceptable thresholds:
# - Skill-only: < 100ms
# - With hooks: < 200ms
# - With MCP: < 500ms
```

### Memory Usage

```bash
# Monitor memory during plugin usage
# In DUYA DevTools: Memory tab

# Check for:
# - Memory leaks in long-running plugins
# - Excessive memory usage
# - Proper cleanup on disable
```

### Hook Performance

```
TEST: Hook Execution Time

SETUP:
- Plugin with multiple hooks
- High-frequency events

STEPS:
1. Enable plugin
2. Trigger events rapidly
3. Measure response time

EXPECTED:
- Hook execution < 100ms
- No UI freezing
- Event queue doesn't back up
```

---

## Compatibility Testing

### DUYA Version Compatibility

```
TEST MATRIX

DUYA Version | Plugin Version | Status
-------------|----------------|--------
v0.9.0       | v1.0.0         | ✓ Test
v0.9.1       | v1.0.0         | ✓ Test
v0.10.0      | v1.0.0         | ? Check
```

### Cross-Plugin Compatibility

```
TEST: Multiple Plugins

SETUP:
- Plugin A (hooks)
- Plugin B (commands)
- Plugin C (skills)

STEPS:
1. Install all three plugins
2. Enable simultaneously
3. Test each plugin's features

EXPECTED:
- No conflicts between plugins
- All capabilities work
- No duplicate registrations
```

---

## Debugging Failed Tests

### Plugin Not Loading

```bash
# Check DUYA logs
tail -f ~/.duya/logs/app.log | grep -i "plugin\|error"

# Common issues:
# 1. Invalid YAML frontmatter
# 2. Missing required files
# 3. Syntax errors in JSON
# 4. File permission issues
```

### Hook Not Firing

```bash
# Enable debug logging
export DUYA_LOG_LEVEL=debug

# Check hook registration
grep -i "hook" ~/.duya/logs/app.log

# Common issues:
# 1. Event name misspelled
# 2. Matcher pattern invalid
# 3. Hook disabled in settings
# 4. Execution error in hook
```

### MCP Connection Failed

```bash
# Test MCP server manually
npx @modelcontextprotocol/server-filesystem /test/path

# Check DUYA MCP logs
grep -i "mcp" ~/.duya/logs/app.log

# Common issues:
# 1. Command not in PATH
# 2. Missing arguments
# 3. Permission denied
# 4. Port conflicts
```

---

## Test Checklist

Before releasing your plugin, complete this checklist:

### Syntax & Structure
- [ ] All YAML frontmatter valid
- [ ] All JSON files valid
- [ ] All markdown files linted
- [ ] No broken internal links
- [ ] File structure follows convention

### Functionality
- [ ] Plugin loads without errors
- [ ] All skills activate correctly
- [ ] All commands execute correctly
- [ ] All hooks fire correctly
- [ ] All MCP servers connect

### Edge Cases
- [ ] Empty/invalid inputs handled
- [ ] Large files handled gracefully
- [ ] Network failures handled
- [ ] Concurrent operations safe
- [ ] Cleanup on disable/uninstall

### Documentation
- [ ] README is clear and complete
- [ ] Installation steps tested
- [ ] Examples work as written
- [ ] Changelog is up to date
- [ ] License file included

### Release Ready
- [ ] Version number updated
- [ ] Git tag created
- [ ] Release notes written
- [ ] Marketplace entry ready
- [ ] Announcement prepared