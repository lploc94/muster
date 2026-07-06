import * as fs from 'fs';
import * as path from 'path';

export const SESSION_MIGRATION_MARKER = 'muster.sessionMigration.v1';
export const SESSIONS_FILE = '.muster-sessions.json';
export const SESSIONS_MIGRATED = '.muster-sessions.json.migrated';
export const SESSIONS_CORRUPT = '.muster-sessions.json.corrupt';

export type SessionMigrationAction = 'none' | 'archived' | 'corrupt_archived';

export interface SessionMigrationResult {
  action: SessionMigrationAction;
  message?: string;
}

function archivePath(workspaceRoot: string, suffix: string): string {
  return path.join(workspaceRoot, suffix);
}

function isValidSessionsShape(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Archive-only migration for legacy `.muster-sessions.json`.
 * Idempotent: no-op when marker is set or archive files already exist.
 */
export function migrateLegacySessions(
  workspaceRoot: string,
  _options?: { markerAlreadySet?: boolean },
): SessionMigrationResult {
  const migrated = archivePath(workspaceRoot, SESSIONS_MIGRATED);
  const corrupt = archivePath(workspaceRoot, SESSIONS_CORRUPT);
  if (fs.existsSync(migrated) || fs.existsSync(corrupt)) {
    return { action: 'none' };
  }

  const sessionsFile = archivePath(workspaceRoot, SESSIONS_FILE);
  if (!fs.existsSync(sessionsFile)) {
    return { action: 'none' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionsFile, 'utf8');
  } catch {
    return { action: 'none' };
  }

  if (!isValidSessionsShape(raw)) {
    fs.renameSync(sessionsFile, corrupt);
    return {
      action: 'corrupt_archived',
      message:
        'Legacy Muster chat sessions could not be read and were preserved as .muster-sessions.json.corrupt. New work starts as tasks.',
    };
  }

  fs.renameSync(sessionsFile, migrated);
  return {
    action: 'archived',
    message:
      'Legacy Muster chat sessions were archived to .muster-sessions.json.migrated. New work starts as tasks.',
  };
}