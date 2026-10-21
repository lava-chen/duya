/**
 * Tests for Environment Variable Collector
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PromptSkill, RequiredEnvVar } from '../../src/skills/types.js';
import {
  loadEnvFile,
  saveEnvVar,
  isEnvVarSet,
  normalizeRequiredEnvVars,
  buildSkillEnvContext,
  formatRequiredEnvVars,
  setSecretCaptureCallback,
  checkSkillEnvRequirements,
} from '../../src/skills/envVarCollector.js';

const TEST_ENV_DIR = path.join(os.tmpdir(), 'duya-test-env');
const TEST_ENV_FILE = path.join(TEST_ENV_DIR, '.env');

describe('envVarCollector', () => {
  // Mock the ENV_FILE_PATH
  beforeEach(async () => {
    await fs.mkdir(TEST_ENV_DIR, { recursive: true });
    try {
      await fs.unlink(TEST_ENV_FILE);
    } catch {
      // File might not exist
    }
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_ENV_DIR, { recursive: true, force: true });
    } catch {
      // Directory might not exist
    }
  });

  describe('loadEnvFile', () => {
    it('should return empty object when file does not exist', async () => {
      const env = await loadEnvFile();
      expect(typeof env).toBe('object');
    });

    it('should parse simple key=value pairs', async () => {
      await fs.writeFile(TEST_ENV_FILE, 'KEY1=value1\nKEY2=value2\n', 'utf-8');

      // Temporarily override the path for testing
      const content = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      expect(content).toContain('KEY1=value1');
      expect(content).toContain('KEY2=value2');
    });

    it('should handle quoted values', async () => {
      await fs.writeFile(TEST_ENV_FILE, 'KEY="quoted value"\n', 'utf-8');

      const content = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      expect(content).toContain('KEY="quoted value"');
    });

    it('should ignore comments and empty lines', async () => {
      await fs.writeFile(
        TEST_ENV_FILE,
        '# This is a comment\nKEY=value\n\n# Another comment\n',
        'utf-8'
      );

      const content = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      expect(content).toContain('# This is a comment');
      expect(content).toContain('KEY=value');
    });
  });

  describe('saveEnvVar', () => {
    it('should create new env file if not exists', async () => {
      // Test by writing and reading back
      const testContent = 'TEST_VAR="test_value"\n';
      await fs.writeFile(TEST_ENV_FILE, testContent, 'utf-8');

      const content = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      expect(content).toContain('TEST_VAR="test_value"');
    });

    it('should append new variable to existing file', async () => {
      await fs.writeFile(TEST_ENV_FILE, 'EXISTING=value\n', 'utf-8');

      const content = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      expect(content).toContain('EXISTING=value');
    });

    it('should update existing variable', async () => {
      await fs.writeFile(TEST_ENV_FILE, 'KEY=old_value\n', 'utf-8');

      // Read, modify, write
      let content = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      content = content.replace('KEY=old_value', 'KEY=new_value');
      await fs.writeFile(TEST_ENV_FILE, content, 'utf-8');

      const updated = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      expect(updated).toContain('KEY=new_value');
      expect(updated).not.toContain('KEY=old_value');
    });

    it('should escape quotes in values', async () => {
      const valueWithQuotes = 'value with "quotes"';
      const escaped = valueWithQuotes.replace(/"/g, '\\"');
      await fs.writeFile(TEST_ENV_FILE, `KEY="${escaped}"\n`, 'utf-8');

      const content = await fs.readFile(TEST_ENV_FILE, 'utf-8');
      expect(content).toContain('\\"');
    });
  });

  describe('isEnvVarSet', () => {
    it('should return true when env var exists in snapshot', () => {
      const snapshot = { TEST_KEY: 'test_value' };
      expect(isEnvVarSet('TEST_KEY', snapshot)).toBe(true);
    });

    it('should return false when env var does not exist', () => {
      const snapshot = { OTHER_KEY: 'value' };
      expect(isEnvVarSet('TEST_KEY', snapshot)).toBe(false);
    });

    it('should return true when env var exists in process.env', () => {
      process.env.TEST_PROCESS_VAR = 'test_value';
      const snapshot = {};
      expect(isEnvVarSet('TEST_PROCESS_VAR', snapshot)).toBe(true);
      delete process.env.TEST_PROCESS_VAR;
    });

    it('should return false for empty string', () => {
      const snapshot = { EMPTY_KEY: '' };
      expect(isEnvVarSet('EMPTY_KEY', snapshot)).toBe(false);
    });
  });

  describe('normalizeRequiredEnvVars', () => {
    it('should handle string array format', () => {
      const frontmatter = {
        required_environment_variables: ['API_KEY', 'BASE_URL'],
      };

      const result = normalizeRequiredEnvVars(frontmatter);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'API_KEY',
        prompt: 'Enter value for API_KEY',
      });
      expect(result[1]).toEqual({
        name: 'BASE_URL',
        prompt: 'Enter value for BASE_URL',
      });
    });

    it('should handle object array format', () => {
      const frontmatter = {
        required_environment_variables: [
          {
            name: 'AWS_KEY',
            prompt: 'Enter AWS Key',
            help: 'https://aws.com',
            required_for: 'AWS auth',
          },
        ],
      };

      const result = normalizeRequiredEnvVars(frontmatter);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'AWS_KEY',
        prompt: 'Enter AWS Key',
        help: 'https://aws.com',
        required_for: 'AWS auth',
      });
    });

    it('should handle setup.collect_secrets format', () => {
      const frontmatter = {
        setup: {
          help: 'Setup help',
          collect_secrets: [
            {
              env_var: 'GITHUB_TOKEN',
              prompt: 'Enter GitHub token',
              provider_url: 'https://github.com/settings',
              secret: true,
            },
          ],
        },
      };

      const result = normalizeRequiredEnvVars(frontmatter);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('GITHUB_TOKEN');
      expect(result[0].prompt).toBe('Enter GitHub token');
      expect(result[0].help).toBe('https://github.com/settings');
    });

    it('should handle legacy prerequisites.env_vars format', () => {
      const frontmatter = {
        prerequisites: {
          env_vars: ['LEGACY_VAR1', 'LEGACY_VAR2'],
        },
      };

      const result = normalizeRequiredEnvVars(frontmatter);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('LEGACY_VAR1');
      expect(result[1].name).toBe('LEGACY_VAR2');
    });

    it('should merge multiple formats', () => {
      const frontmatter = {
        required_environment_variables: ['VAR1'],
        setup: {
          collect_secrets: [{ env_var: 'VAR2', prompt: 'Enter VAR2' }],
        },
      };

      const result = normalizeRequiredEnvVars(frontmatter);

      expect(result).toHaveLength(2);
      expect(result.map(r => r.name)).toContain('VAR1');
      expect(result.map(r => r.name)).toContain('VAR2');
    });

    it('should deduplicate variables', () => {
      const frontmatter = {
        required_environment_variables: ['DUPLICATE', 'DUPLICATE'],
      };

      const result = normalizeRequiredEnvVars(frontmatter);

      expect(result).toHaveLength(1);
    });

    it('should handle mixed string and object formats', () => {
      const frontmatter = {
        required_environment_variables: [
          'STRING_VAR',
          { name: 'OBJECT_VAR', prompt: 'Custom prompt' },
        ],
      };

      const result = normalizeRequiredEnvVars(frontmatter);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('STRING_VAR');
      expect(result[0].prompt).toBe('Enter value for STRING_VAR');
      expect(result[1].name).toBe('OBJECT_VAR');
      expect(result[1].prompt).toBe('Custom prompt');
    });
  });

  describe('buildSkillEnvContext', () => {
    it('should return empty object when skill has no required env vars', async () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'test-skill',
        description: 'Test skill',
        source: 'user',
        async getPromptForCommand() { return ''; },
      };

      const context = await buildSkillEnvContext(skill);
      expect(context).toEqual({});
    });

    it('should build context from env vars', async () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'test-skill',
        description: 'Test skill',
        source: 'user',
        requiredEnvVars: [
          { name: 'TEST_VAR1', prompt: 'Enter var1' },
          { name: 'TEST_VAR2', prompt: 'Enter var2' },
        ],
        async getPromptForCommand() { return ''; },
      };

      // Set process.env temporarily
      process.env.TEST_VAR1 = 'value1';

      const context = await buildSkillEnvContext(skill);

      expect(context.TEST_VAR1).toBe('value1');
      expect(context.TEST_VAR2).toBeUndefined();

      delete process.env.TEST_VAR1;
    });
  });

  describe('formatRequiredEnvVars', () => {
    it('should return empty string for empty array', () => {
      expect(formatRequiredEnvVars([])).toBe('');
    });

    it('should format required env vars', () => {
      const vars: RequiredEnvVar[] = [
        { name: 'API_KEY', prompt: 'Enter API key' },
        { name: 'BASE_URL', prompt: 'Enter base URL', optional: true },
      ];

      const formatted = formatRequiredEnvVars(vars);

      expect(formatted).toContain('Required environment variables:');
      expect(formatted).toContain('API_KEY');
      expect(formatted).toContain('BASE_URL (optional)');
    });

    it('should include help URLs', () => {
      const vars: RequiredEnvVar[] = [
        { name: 'AWS_KEY', prompt: 'Enter AWS key', help: 'https://aws.com' },
      ];

      const formatted = formatRequiredEnvVars(vars);

      expect(formatted).toContain('https://aws.com');
    });
  });

  describe('checkSkillEnvRequirements', () => {
    it('should return ready=true when no env vars required', async () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'test-skill',
        description: 'Test skill',
        source: 'user',
        async getPromptForCommand() { return ''; },
      };

      const result = await checkSkillEnvRequirements(skill);

      expect(result.ready).toBe(true);
      expect(result.missing).toHaveLength(0);
      expect(result.setupNeeded).toBe(false);
    });

    it('should return ready=true when all env vars are set', async () => {
      process.env.TEST_READY_VAR = 'value';

      const skill: PromptSkill = {
        type: 'prompt',
        name: 'test-skill',
        description: 'Test skill',
        source: 'user',
        requiredEnvVars: [
          { name: 'TEST_READY_VAR', prompt: 'Enter var' },
        ],
        async getPromptForCommand() { return ''; },
      };

      const result = await checkSkillEnvRequirements(skill);

      expect(result.ready).toBe(true);
      expect(result.missing).toHaveLength(0);

      delete process.env.TEST_READY_VAR;
    });

    it('should return ready=false when env vars are missing', async () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'test-skill',
        description: 'Test skill',
        source: 'user',
        requiredEnvVars: [
          { name: 'MISSING_VAR', prompt: 'Enter missing var' },
        ],
        async getPromptForCommand() { return ''; },
      };

      const result = await checkSkillEnvRequirements(skill);

      expect(result.ready).toBe(false);
      expect(result.missing).toContain('MISSING_VAR');
      expect(result.setupNeeded).toBe(true);
      expect(result.setupNote).toContain('MISSING_VAR');
    });

    it('should skip optional env vars', async () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'test-skill',
        description: 'Test skill',
        source: 'user',
        requiredEnvVars: [
          { name: 'OPTIONAL_VAR', prompt: 'Enter optional', optional: true },
        ],
        async getPromptForCommand() { return ''; },
      };

      const result = await checkSkillEnvRequirements(skill);

      expect(result.ready).toBe(true);
    });

    it('should include help URL in setup note', async () => {
      const skill: PromptSkill = {
        type: 'prompt',
        name: 'test-skill',
        description: 'Test skill',
        source: 'user',
        requiredEnvVars: [
          {
            name: 'HELP_VAR',
            prompt: 'Enter help var',
            help: 'https://example.com/help',
          },
        ],
        async getPromptForCommand() { return ''; },
      };

      const result = await checkSkillEnvRequirements(skill);

      expect(result.setupNote).toContain('https://example.com/help');
    });
  });
});
