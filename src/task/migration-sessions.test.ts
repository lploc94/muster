import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateLegacySessions,
  SESSIONS_CORRUPT,
  SESSIONS_FILE,
  SESSIONS_MIGRATED,
} from './migration-sessions';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-session-migration-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migrateLegacySessions', () => {
  it('archives a valid sessions file by atomic rename', () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, SESSIONS_FILE), JSON.stringify({ claude: 'sess-1' }), 'utf8');

    const result = migrateLegacySessions(ws);
    expect(result.action).toBe('archived');
    expect(fs.existsSync(path.join(ws, SESSIONS_FILE))).toBe(false);
    expect(fs.existsSync(path.join(ws, SESSIONS_MIGRATED))).toBe(true);
    expect(fs.readFileSync(path.join(ws, SESSIONS_MIGRATED), 'utf8')).toContain('sess-1');
  });

  it('preserves corrupt files as .corrupt without overwriting', () => {
    const ws = makeWorkspace();
    const corruptPath = path.join(ws, SESSIONS_FILE);
    fs.writeFileSync(corruptPath, 'not-json{{{', 'utf8');

    const result = migrateLegacySessions(ws);
    expect(result.action).toBe('corrupt_archived');
    expect(fs.existsSync(path.join(ws, SESSIONS_FILE))).toBe(false);
    expect(fs.existsSync(path.join(ws, SESSIONS_CORRUPT))).toBe(true);
    expect(fs.readFileSync(path.join(ws, SESSIONS_CORRUPT), 'utf8')).toBe('not-json{{{');
  });

  it('archives a later-present sessions file even when marker was set without a prior file', () => {
    const ws = makeWorkspace();
    const noFile = migrateLegacySessions(ws, { markerAlreadySet: true });
    expect(noFile.action).toBe('none');

    fs.writeFileSync(path.join(ws, SESSIONS_FILE), JSON.stringify({ grok: 'sess-3' }), 'utf8');
    const second = migrateLegacySessions(ws, { markerAlreadySet: true });
    expect(second.action).toBe('archived');
    expect(fs.existsSync(path.join(ws, SESSIONS_FILE))).toBe(false);
    expect(fs.existsSync(path.join(ws, SESSIONS_MIGRATED))).toBe(true);
  });

  it('is idempotent when archive file already exists', () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, SESSIONS_MIGRATED), '{}', 'utf8');
    fs.writeFileSync(path.join(ws, SESSIONS_FILE), JSON.stringify({ claude: 'x' }), 'utf8');

    const result = migrateLegacySessions(ws);
    expect(result.action).toBe('none');
    expect(fs.existsSync(path.join(ws, SESSIONS_FILE))).toBe(true);
  });
});