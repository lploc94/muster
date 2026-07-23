/**
 * P5-W6 secret-canary privacy audit.
 *
 * A runtime-generated canary may exist only in intentional durable conversation
 * content and a user-requested SQLite backup of that content. It must not appear
 * in RPC/error/diagnostic/log/command/change-feed/snapshot-metadata surfaces.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DbClient, DbWorkerError } from './client';
import { SqliteTaskRepository } from '../repository';
import type { MusterTask, TaskMessage } from '../types';
import {
  MusterSqliteError,
  SQLITE_PRIMARY,
  serializeMusterError,
  safeMessageForCode,
  type SqliteErrorCode,
  type SqliteOperationClass,
} from './errors';
import {
  diagnoseSqliteError,
  redactedDiagnosticLogFields,
  recoveryGuidanceFor,
} from './diagnostics';
import {
  handleBackupDatabaseCommand,
  handleDeveloperResetCommand,
  RESET_CHOICE_WITHOUT_BACKUP,
} from '../../host/sqlite-maintenance-commands';
import { readRedactedDbIdentity } from '../../host/uat-commands';
import { MUSTER_APPLICATION_ID, SQLITE_SCHEMA_VERSION } from './schema';

const WORKER_TS = path.join(__dirname, 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];

const clients: DbClient[] = [];
const tempDirs: string[] = [];

function makeClient(opts: {
  faultCapability?: boolean;
  faultPlan?: {
    code: 'full' | 'readonly' | 'io' | 'busy' | 'corrupt' | 'not_a_database';
    operation: SqliteOperationClass;
    remaining: number;
  };
} = {}): DbClient {
  const client = new DbClient({
    workerPath: WORKER_TS,
    execArgv: TSX_ARGV,
    ...(opts.faultCapability ? { faultCapability: true } : {}),
    ...(opts.faultPlan ? { faultPlan: opts.faultPlan } : {}),
  });
  clients.push(client);
  return client;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-privacy-'));
  tempDirs.push(dir);
  return dir;
}

function makeCanary(): string {
  return `CANARY_${randomBytes(12).toString('hex')}_${Date.now()}`;
}

function makeTask(id: string, goal: string): MusterTask {
  const now = '2026-07-18T00:00:00.000Z';
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'draft',
    goal,
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMessage(id: string, taskId: string, content: string): TaskMessage {
  return {
    id,
    taskId,
    role: 'user',
    content,
    state: 'complete',
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

function assertNoSensitiveLeak(value: unknown, canary: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(text).not.toContain(canary);
  expect(text).not.toMatch(/\/Users\/|\/private\/|\\\\Users\\\\/i);
  expect(text).not.toMatch(/\bSELECT\s+\*|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i);
  expect(text).not.toMatch(/\bat\s+\S+\.(ts|js):\d+/i);
  expect(text).not.toMatch(/muster\.sqlite3-wal|muster\.sqlite3-shm/i);
}

/** Mirror of production debugMuster serialization (event + JSON details). */
function serializeDebugLine(event: string, details: Record<string, unknown>): string {
  return `${new Date().toISOString()} ${event} ${JSON.stringify(details)}`;
}

// Real Phase 5 evidence allowlist builder (JS module; no .d.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildPhase5Evidence } = require('../../../scripts/sqlite-phase5-evidence-schema.mjs') as {
  buildPhase5Evidence: (runtimes: unknown[]) => Record<string, unknown>;
};

const RAW_FAULT_SHAPES: Array<{
  label: string;
  operation: SqliteOperationClass;
  raw: Record<string, unknown>;
  expectedCode: SqliteErrorCode;
}> = [
  {
    label: 'full',
    operation: 'transaction',
    raw: {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.FULL,
      message: 'database or disk is full',
    },
    expectedCode: 'full',
  },
  {
    label: 'readonly',
    operation: 'write',
    raw: {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.READONLY,
      message: 'attempt to write a readonly database',
    },
    expectedCode: 'readonly',
  },
  {
    label: 'io',
    operation: 'write',
    raw: {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.IOERR,
      message: 'disk I/O error',
    },
    expectedCode: 'io',
  },
  {
    label: 'busy',
    operation: 'transaction',
    raw: {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.BUSY,
      message: 'database is locked',
    },
    expectedCode: 'busy',
  },
  {
    label: 'corrupt',
    operation: 'open',
    raw: {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.CORRUPT,
      message: 'database disk image is malformed',
    },
    expectedCode: 'corrupt',
  },
  {
    label: 'not_a_database',
    operation: 'open',
    raw: {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.NOTADB,
      message: 'file is not a database',
    },
    expectedCode: 'not_a_database',
  },
  {
    label: 'backup-full',
    operation: 'backup',
    raw: {
      code: 'ERR_SQLITE_ERROR',
      errcode: SQLITE_PRIMARY.FULL,
      message: 'database or disk is full during backup',
    },
    expectedCode: 'full',
  },
];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('P5-W6 privacy canary allowlist', () => {
  it('keeps a runtime canary only in durable content and user backup', async () => {
    const canary = makeCanary();
    const reasoningCanary = `${canary}_REASONING`;
    const dir = tempDir();
    const dbPath = path.join(dir, 'muster.sqlite3');
    const backupPath = path.join(dir, 'user-backup.sqlite3');

    const client = makeClient();
    await client.open(dbPath);
    const repo = new SqliteTaskRepository(client, 'ws');
    await repo.execute({
      kind: 'upsertWorkspace',
      workspaceId: 'ws',
      identityKey: 'privacy',
      displayName: 'Privacy',
      createdAt: 'now',
      lastOpenedAt: 'now',
    });
    const task = makeTask('t-privacy', `goal without canary`);
    const message = makeMessage('m-privacy', task.id, `user said ${canary}`);
    await repo.execute({
      kind: 'createRootAndInitialTurn',
      workspaceId: 'ws',
      task,
      message,
      turn: {
        id: 'turn-privacy',
        taskId: task.id,
        sequence: 1,
        status: 'succeeded',
        trigger: 'user',
        inputs: [{ kind: 'message', messageId: message.id }],
        createdAt: '2026-07-18T00:00:00.000Z',
        startedAt: '2026-07-18T00:00:00.000Z',
        finishedAt: '2026-07-18T00:00:01.000Z',
      },
      receipt: {
        clientRequestId: 'privacy-receipt',
        fingerprint: 'privacy-fp',
        taskId: task.id,
        messageId: message.id,
        turnId: 'turn-privacy',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    });
    await client.run(
      `INSERT INTO reasoning_segments
        (id, workspace_id, task_id, turn_id, ordering, content, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        'r-privacy',
        'ws',
        task.id,
        'turn-privacy',
        0,
        `thinking ${reasoningCanary}`,
        '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z',
      ],
    );

    const stored = await client.get<{ content: string }>(
      `SELECT content FROM messages WHERE id = ?`,
      ['m-privacy'],
    );
    expect(stored?.content).toContain(canary);
    const storedReasoning = await client.get<{ content: string }>(
      `SELECT content FROM reasoning_segments WHERE id = ?`,
      ['r-privacy'],
    );
    expect(storedReasoning?.content).toContain(reasoningCanary);

    const meta = await client.backup(backupPath, { overwrite: false });
    expect(meta.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    assertNoSensitiveLeak(meta, canary);
    assertNoSensitiveLeak(meta, reasoningCanary);

    // Independently reopen source and backup.
    const sourceReopen = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const srcMsg = sourceReopen
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get('m-privacy') as { content?: string };
      expect(srcMsg.content).toContain(canary);
    } finally {
      sourceReopen.close();
    }

    const artifact = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const appId = Number(
        Object.values(
          (artifact.prepare('PRAGMA application_id').get() as Record<string, number>) ?? {},
        )[0] ?? 0,
      );
      expect(appId).toBe(MUSTER_APPLICATION_ID);
      const msg = artifact
        .prepare(`SELECT content FROM messages WHERE id = ?`)
        .get('m-privacy') as { content?: string };
      expect(msg.content).toContain(canary);
      const reasoning = artifact
        .prepare(`SELECT content FROM reasoning_segments WHERE id = ?`)
        .get('r-privacy') as { content?: string };
      expect(reasoning.content).toContain(reasoningCanary);
    } finally {
      artifact.close();
    }

    // Table-drive distinct fault shapes with canary-tainted raw messages.
    for (const shape of RAW_FAULT_SHAPES) {
      const tainted = {
        ...shape.raw,
        message: `${String(shape.raw.message)} at /Users/secret/${canary}/muster.sqlite3 SELECT * FROM messages`,
        stack: `Error\n    at Object.<anonymous> (/Users/secret/${canary}/file.ts:1:1)`,
      };
      const wire = serializeMusterError(tainted, shape.operation);
      expect(wire.code).toBe(shape.expectedCode);
      expect(Object.keys(wire).sort()).toEqual(
        ['code', 'kind', 'message', 'name', 'operation'].sort(),
      );
      expect(wire.message).toBe(safeMessageForCode(wire.code));
      assertNoSensitiveLeak(wire, canary);

      const diagnostic = diagnoseSqliteError(
        new MusterSqliteError(shape.expectedCode as 'full' | 'readonly' | 'io' | 'busy' | 'corrupt' | 'not_a_database' | 'unknown', shape.operation),
        shape.operation,
      );
      const log = redactedDiagnosticLogFields(diagnostic);
      expect(Object.keys(log).sort()).toEqual(
        ['code', 'failClosed', 'kind', 'operation', 'recoveryAction', 'terminal'].sort(),
      );
      assertNoSensitiveLeak(log, canary);
      assertNoSensitiveLeak(recoveryGuidanceFor(diagnostic), canary);

      // Real debug/output serialization seam (same shape as debugMuster).
      const line = serializeDebugLine('sqlite.activation.fail_closed', log);
      assertNoSensitiveLeak(line, canary);
      expect(line).not.toContain(dbPath);
    }

    const workerish = new DbWorkerError({
      name: 'MusterSqliteError',
      code: 'full',
      message: `disk full while writing ${canary} at /Users/secret/path`,
      operation: 'transaction',
      kind: 'operational',
    });
    const fromWorker = diagnoseSqliteError(workerish, 'transaction');
    assertNoSensitiveLeak(fromWorker, canary);
    assertNoSensitiveLeak(redactedDiagnosticLogFields(fromWorker), canary);
    assertNoSensitiveLeak(
      serializeDebugLine('sqlite.storage.terminal', redactedDiagnosticLogFields(fromWorker)),
      canary,
    );

    const feed = await repo.getWorkspaceChangesSince(0);
    assertNoSensitiveLeak(feed, canary);
    assertNoSensitiveLeak(feed, reasoningCanary);
    if (feed.kind === 'changes') {
      for (const rev of feed.revisions) {
        for (const change of rev.changes) {
          expect(change).not.toHaveProperty('content');
          expect(change).not.toHaveProperty('payload');
          expect(JSON.stringify(change)).not.toContain(canary);
        }
      }
    }

    const identity = await readRedactedDbIdentity(
      repo,
      dbPath,
      (p) => {
        const stat = fs.statSync(p);
        return {
          size: stat.size,
          physicalIdentity: `${fs.realpathSync(p)}|${stat.dev}|${stat.ino}`,
        };
      },
      (input) => {
        let h = 0;
        for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) >>> 0;
        return h.toString(16).padStart(8, '0').slice(0, 16);
      },
      {
        pragma: (name) => client.pragma(name),
        get: <T>(sql: string, params?: unknown[]) => client.get<T>(sql, params as never),
      },
    );
    assertNoSensitiveLeak(identity, canary);
    expect(identity.dbFileToken).not.toContain('/');
    expect(identity.dbFileToken).not.toContain(canary);

    // Real Phase 5 evidence builder: canary-bearing extras must be dropped.
    const evidence = buildPhase5Evidence([
      {
        runtimeClass: '1.101.0',
        vscodeVersion: '1.101.0',
        nodeVersion: '22.15.1',
        secretCanary: canary,
        messageBody: `user said ${canary}`,
        scenarios: [
          {
            scenarioId: 'corrupt_open',
            resultCode: 'corrupt',
            verdict: 'PASS',
            durationMs: 1,
            content: canary,
            dbPath: `/Users/secret/${canary}`,
          },
        ],
      },
    ]);
    assertNoSensitiveLeak(evidence, canary);
    assertNoSensitiveLeak(JSON.stringify(evidence), reasoningCanary);
    expect(JSON.stringify(evidence)).not.toContain('secretCanary');
    expect(JSON.stringify(evidence)).not.toContain('messageBody');
    expect(JSON.stringify(evidence)).not.toContain('dbPath');

    const page = await repo.getTranscriptPage(task.id, undefined, 100);
    expect(JSON.stringify(page.items)).toContain(canary);
    assertNoSensitiveLeak(
      {
        hasMoreBefore: page.hasMoreBefore,
        beforeCursor: page.beforeCursor,
        workspaceRevision: page.workspaceRevision,
      },
      canary,
    );

    const showInfo: string[] = [];
    const showError: string[] = [];
    const backupResult = await handleBackupDatabaseCommand({
      showSaveDialog: async () => ({ fsPath: path.join(dir, 'cmd-backup.sqlite3') }),
      destinationExists: () => false,
      backup: async (destination, options) => client.backup(destination, options),
      showInformationMessage: (message) => {
        showInfo.push(message);
      },
      showErrorMessage: (message) => {
        showError.push(message);
      },
      isMaintenanceActive: () => false,
      setMaintenanceActive: () => undefined,
    });
    expect(backupResult.kind).toBe('success');
    if (backupResult.kind === 'success') {
      assertNoSensitiveLeak(backupResult.meta, canary);
      expect(backupResult.fileName).toBe('cmd-backup.sqlite3');
      expect(backupResult.fileName).not.toContain(dir);
    }
    for (const msg of [...showInfo, ...showError]) {
      assertNoSensitiveLeak(msg, canary);
      expect(msg).not.toContain(dir);
    }

    // Backup fault path with canary-tainted worker error surface.
    const faultClient = makeClient({
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'backup', remaining: 1 },
    });
    await faultClient.open(path.join(dir, 'fault-src.sqlite3'));
    try {
      await faultClient.backup(path.join(dir, 'fault-dst.sqlite3'), { overwrite: false });
      expect.unreachable('backup fault must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DbWorkerError);
      const detail = (error as DbWorkerError).detail;
      assertNoSensitiveLeak(detail, canary);
      expect(detail.code).toBe('full');
      const cmdErr = await handleBackupDatabaseCommand({
        showSaveDialog: async () => ({ fsPath: path.join(dir, 'fail-backup.sqlite3') }),
        destinationExists: () => false,
        backup: async () => {
          throw error;
        },
        showInformationMessage: (m) => {
          showInfo.push(m);
        },
        showErrorMessage: (m) => {
          showError.push(m);
        },
        isMaintenanceActive: () => false,
        setMaintenanceActive: () => undefined,
      });
      expect(cmdErr.kind).toBe('error');
      if (cmdErr.kind === 'error') {
        assertNoSensitiveLeak(cmdErr, canary);
        expect(cmdErr.message).toBe(safeMessageForCode('full'));
      }
    }

    // Reset failure with canary-tainted Error.message; host maps via fixed code only.
    const resetErrors2: string[] = [];
    const resetFail = await handleDeveloperResetCommand({
      showWarningMessage: async () => RESET_CHOICE_WITHOUT_BACKUP,
      runBackupFlow: async () => ({ kind: 'success', fileName: 'x', meta }),
      quiesceForMaintenance: async () => undefined,
      resetDatabase: async () => {
        throw Object.assign(new Error(`reset failed with ${canary} at ${dbPath}`), {
          code: 'busy',
        });
      },
      reloadWindow: async () => {
        throw new Error(`reload must not run ${canary}`);
      },
      showErrorMessage: (message) => {
        resetErrors2.push(message);
      },
      showInformationMessage: () => undefined,
      isMaintenanceActive: () => false,
      setMaintenanceActive: () => undefined,
    });
    expect(resetFail.kind).toBe('error');
    if (resetFail.kind === 'error') {
      assertNoSensitiveLeak(resetFail, canary);
      expect(resetFail.code).toBe('busy');
      expect(resetFail.message).toBe(safeMessageForCode('busy'));
    }
    for (const msg of resetErrors2) {
      assertNoSensitiveLeak(msg, canary);
      expect(msg).not.toContain(dbPath);
    }
  }, 60_000);
});
