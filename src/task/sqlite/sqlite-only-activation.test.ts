import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8');

describe('SQLite-only activation boundary', () => {
  it('has no filesystem JSON task-store path or watcher', () => {
    expect(extensionSource).not.toContain('.muster-tasks.json');
    expect(extensionSource).not.toContain('createFileSystemWatcher');
    expect(extensionSource).not.toMatch(/from ['"]\.\/task\/store['"]/);
    expect(extensionSource).not.toContain('JsonTaskRepository');
  });

  it('constructs the production engine from the SQLite repository only', () => {
    expect(extensionSource).toContain('new SqliteTaskRepository(');
    expect(extensionSource).toContain('TaskEngine.loadAsync({');
    expect(extensionSource).not.toContain('TaskEngine.load({');
  });

  it('treats a missing node:sqlite runtime as an activation error', () => {
    expect(extensionSource).toMatch(
      /if \(!sqliteProbe\.available\) \{[\s\S]*showErrorMessage\(message\);[\s\S]*throw new Error\(message\);/,
    );
  });
});
