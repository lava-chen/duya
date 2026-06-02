# Plugin Publishing Guide

Complete guide for publishing your DUYA plugin to GitHub, NPM, or the DUYA Marketplace.

---

## Pre-Publishing Checklist

Before publishing, ensure your plugin meets these requirements:

### Content Quality

- [ ] Plugin has a clear, unique name
- [ ] Description explains what the plugin does in one sentence
- [ ] All referenced files exist and are readable
- [ ] No placeholder text ({{...}}) remains in files
- [ ] No sensitive data (API keys, passwords) in plugin files
- [ ] License file included (MIT, Apache-2.0, etc.)

### Technical Validation

- [ ] `plugin.md` has valid YAML frontmatter
- [ ] All JSON files are syntactically valid
- [ ] No path traversal (`../`) in file references
- [ ] Hook events use valid event names
- [ ] MCP server configurations have required fields
- [ ] Plugin loads without errors in DUYA

### Documentation

- [ ] README.md explains plugin purpose and usage
- [ ] Installation instructions are clear
- [ ] Configuration options documented (if any)
- [ ] Changelog tracks version history
- [ ] Examples provided for complex features

---

## Publishing to GitHub

### Step 1: Create Repository

```bash
# Initialize git repository
cd my-plugin
git init

# Create initial commit
git add .
git commit -m "Initial plugin commit"

# Create GitHub repository (via CLI or web interface)
gh repo create my-duya-plugin --public --source=. --remote=origin

# Or manually:
git remote add origin https://github.com/yourname/my-duya-plugin.git
git push -u origin main
```

### Step 2: Add Documentation

Create a comprehensive README.md:

```markdown
# My DUYA Plugin

[![DUYA Plugin](https://img.shields.io/badge/DUYA-Plugin-blue)](https://duya.app)

Short description of what this plugin does.

## Features

- Feature 1
- Feature 2
- Feature 3

## Installation

### From GitHub

```bash
duya plugin install my-plugin@github
```

### Manual Installation

1. Clone this repository
2. Copy to `~/.duya/plugins/my-plugin/`
3. Restart DUYA or run `/plugins refresh`

## Usage

### Commands

- `/my-command` — Description

### Skills

- `my-skill` — Description

### Hooks

Describe what hooks this plugin provides.

## Configuration

Any configuration options or environment variables.

## Changelog

### 1.0.0
- Initial release

## License

MIT
```

### Step 3: Create Release

```bash
# Tag version
git tag v1.0.0

# Push tag
git push origin v1.0.0

# Create GitHub release (optional, for visibility)
gh release create v1.0.0 --title "v1.0.0" --notes "Initial release"
```

---

## Publishing to NPM

### Step 1: Prepare package.json

```json
{
  "name": "my-duya-plugin",
  "version": "1.0.0",
  "description": "DUYA plugin for ...",
  "main": "plugin.md",
  "files": [
    "plugin.md",
    "plugin.json",
    "commands/",
    "skills/",
    "agents/",
    "hooks/",
    "mcp-servers/",
    "ui/"
  ],
  "keywords": [
    "duya",
    "duya-plugin",
    "ai",
    "agent"
  ],
  "author": "Your Name",
  "license": "MIT",
  "duya": {
    "plugin": {
      "name": "my-plugin",
      "entry": "./plugin.md"
    }
  }
}
```

### Step 2: Publish

```bash
# Login to NPM (first time)
npm login

# Publish
npm publish

# Or publish with access public (for scoped packages)
npm publish --access public
```

### Step 3: Verify

```bash
# Check published package
npm view my-duya-plugin

# Install test
npm install -g my-duya-plugin
```

---

## Submitting to DUYA Marketplace

### Marketplace Requirements

Plugins submitted to the official marketplace must meet additional criteria:

1. **Functionality**: Plugin works as described
2. **Security**: No malicious code or security vulnerabilities
3. **Documentation**: Clear README with usage instructions
4. **Maintenance**: Author commits to maintaining the plugin
5. **Compatibility**: Works with current DUYA version

### Submission Process

#### Step 1: Fork Marketplace Repository

```bash
# Fork https://github.com/lava-chen/duya-marketplace
git clone https://github.com/yourname/duya-marketplace.git
cd duya-marketplace
```

#### Step 2: Add Your Plugin Entry

Edit `marketplace.json`:

```json
{
  "name": "official",
  "version": 1,
  "plugins": {
    "existing-plugin": { ... },
    "my-plugin": {
      "name": "my-plugin",
      "description": "What this plugin does",
      "version": "1.0.0",
      "source": {
        "type": "github",
        "repo": "yourname/my-duya-plugin"
      },
      "author": {
        "name": "Your Name",
        "email": "you@example.com"
      },
      "categories": ["development", "productivity"],
      "tags": ["git", "automation"],
      "minDuyaVersion": "0.9.0",
      "homepage": "https://github.com/yourname/my-duya-plugin"
    }
  }
}
```

#### Step 3: Submit Pull Request

```bash
# Create branch
git checkout -b add-my-plugin

# Commit changes
git add marketplace.json
git commit -m "Add my-plugin to marketplace"

# Push and create PR
git push origin add-my-plugin
gh pr create --title "Add my-plugin" --body "Description of your plugin"
```

#### Step 4: Review Process

1. Automated checks run (schema validation)
2. Manual review by DUYA team (2-3 days)
3. Feedback or approval
4. Merge and publish

---

## Version Management

### Semantic Versioning

Follow [SemVer](https://semver.org/) for version numbers:

```
MAJOR.MINOR.PATCH

MAJOR — Breaking changes (1.0.0 → 2.0.0)
MINOR — New features, backward compatible (1.0.0 → 1.1.0)
PATCH — Bug fixes (1.0.0 → 1.0.1)
```

### Version Bump Checklist

**Patch Release:**
- [ ] Bug fixes only
- [ ] No breaking changes
- [ ] Update CHANGELOG.md
- [ ] Tag new version
- [ ] Update marketplace entry (if applicable)

**Minor Release:**
- [ ] New features added
- [ ] Backward compatible
- [ ] Documentation updated
- [ ] Update CHANGELOG.md
- [ ] Tag new version
- [ ] Update marketplace entry

**Major Release:**
- [ ] Breaking changes documented
- [ ] Migration guide provided
- [ ] Documentation fully updated
- [ ] Update CHANGELOG.md
- [ ] Tag new version
- [ ] Update marketplace entry
- [ ] Announce in community channels

---

## Post-Publishing

### Monitoring

After publishing, monitor:

- Installation success rate
- User feedback and issues
- Compatibility with new DUYA versions
- Security vulnerabilities

### Maintenance

Regular maintenance tasks:

- Respond to issues within 1 week
- Update for new DUYA versions
- Fix bugs promptly
- Add features based on user feedback
- Keep dependencies updated

---

## Troubleshooting

### Plugin Not Appearing in Marketplace

- Check marketplace.json syntax
- Verify source URL is accessible
- Ensure version follows semver
- Check minDuyaVersion compatibility

### NPM Publish Fails

```bash
# Check if name is taken
npm view my-duya-plugin

# Use scoped name if needed
npm init --scope=@yourusername

# Check login status
npm whoami
```

### GitHub Release Issues

```bash
# Check remote URL
git remote -v

# Verify tag exists
git tag -l

# Push tags
git push origin --tags
```