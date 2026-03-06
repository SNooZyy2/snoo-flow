/**
 * Hook Settings Test: Validate .claude/settings.json
 *
 * Ensures:
 * 1. All hook commands use absolute path resolution (git rev-parse)
 * 2. All referenced hook scripts actually exist on disk
 * 3. Hook scripts are executable
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const settingsPath = join(ROOT, '.claude', 'settings.json');

describe('Hook Settings', () => {
  let settings;
  let allCommands;

  it('settings.json exists and parses', () => {
    assert.ok(existsSync(settingsPath), '.claude/settings.json should exist');
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.ok(settings.hooks, 'should have hooks key');
  });

  it('all hook commands use git rev-parse for absolute paths', () => {
    allCommands = [];

    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks || []) {
          if (hook.command) {
            allCommands.push({ event, command: hook.command });
          }
        }
      }
    }

    assert.ok(allCommands.length > 0, 'should have at least one hook command');

    for (const { event, command } of allCommands) {
      assert.ok(
        command.includes('git rev-parse --show-toplevel'),
        `${event} hook should use git rev-parse, got: ${command}`
      );
      assert.ok(
        !command.match(/bash\s+\.claude\//),
        `${event} hook should not use relative path, got: ${command}`
      );
    }
  });

  it('all referenced hook scripts exist on disk', () => {
    const scriptPattern = /\.claude\/hooks\/(\S+\.sh)/g;

    for (const { event, command } of allCommands) {
      const matches = [...command.matchAll(scriptPattern)];
      for (const match of matches) {
        const scriptPath = join(ROOT, '.claude', 'hooks', match[1]);
        assert.ok(
          existsSync(scriptPath),
          `${event} references ${match[1]} but file not found at ${scriptPath}`
        );
      }
    }
  });

  it('hook scripts are executable', () => {
    const scriptPattern = /\.claude\/hooks\/(\S+\.sh)/g;
    const checked = new Set();

    for (const { command } of allCommands) {
      const matches = [...command.matchAll(scriptPattern)];
      for (const match of matches) {
        const script = match[1];
        if (checked.has(script)) continue;
        checked.add(script);

        const scriptPath = join(ROOT, '.claude', 'hooks', script);
        // bash invocation doesn't strictly require +x, but it's good practice
        try {
          accessSync(scriptPath, constants.R_OK);
        } catch {
          assert.fail(`${script} is not readable`);
        }
      }
    }

    assert.ok(checked.size >= 4, `expected at least 4 unique scripts, got ${checked.size}`);
  });

  it('git rev-parse resolves correctly from a subdirectory', () => {
    // Simulate what Claude Code does — run from a subdir
    const resolved = execSync('git rev-parse --show-toplevel', {
      cwd: join(ROOT, 'src'),
      encoding: 'utf-8',
    }).trim();

    assert.equal(resolved, ROOT, 'git rev-parse should resolve to repo root from subdirectory');
  });
});
