import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRepositoryBoundarySmoke } from './repository-boundary-smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('repository source boundary is clean', async () => {
  const result = await runRepositoryBoundarySmoke();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

/**
 * Copy production sources into a temp tree, apply a mutation, and assert the
 * boundary checker fails with an actionable message.
 */
async function withMutatedTree(mutate, expectMatch) {
  const dir = mkdtempSync(path.join(tmpdir(), 'muster-boundary-'));
  try {
    // Minimal tree: only what the checker reads.
    const files = [
      'src/task/sqlite/errors.ts',
      'src/task/sqlite/fault-inject.ts',
      'src/task/sqlite/worker.ts',
      'src/task/sqlite/client.ts',
      'src/task/sqlite/protocol.ts',
      'src/task/sqlite/schema-fingerprint.ts',
      'src/task/sqlite/connection.ts',
      'src/task/sqlite/backup.ts',
      'src/task/engine.ts',
      'src/extension.ts',
      'src/task/repository.ts',
      'src/task/repository-projection.ts',
      'src/host/workspace-patch.ts',
      'src/host/snapshot.ts',
      'src/host/repository-snapshot.ts',
      'src/host/transcript-page-route.ts',
      'src/task/engine-graph.ts',
      'package.json',
      'docs/plans/sqlite-entity-matrix.vi.md',
      // Phase 6 virtualization / docs boundaries
      'webview/src/components/ChatThread.svelte',
      'webview/src/components/TaskWorkspace.svelte',
      'docs/WEBVIEW.md',
      'scripts/sqlite-phase6-evidence-schema.mjs',
    ];
    for (const rel of files) {
      const src = path.join(ROOT, rel);
      const dest = path.join(dir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      try {
        cpSync(src, dest);
      } catch {
        // optional
      }
    }
    mutate(dir);
    const result = await runRepositoryBoundarySmoke(dir);
    assert.equal(result.ok, false, `expected failure, got: ${JSON.stringify(result.failures)}`);
    assert.match(result.failures.join('\n'), expectMatch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fails when ambient env fault is armed in fault-inject', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/task/sqlite/fault-inject.ts');
    writeFileSync(
      file,
      `
export function maybeInjectFault() {}
export function bootstrapFaultCapability() {}
const x = process.env['MUSTER_SQLITE_FAULT_INJECT'];
`,
    );
  }, /ambient MUSTER_SQLITE_FAULT|must not read ambient/i);
});

test('fails when claimRuntimeTurn swallows storage errors into false', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/task/engine.ts');
    writeFileSync(
      file,
      `
export class TaskEngine {
  private async claimRuntimeTurn(turnId: string, expiresAt: string): Promise<boolean> {
    try {
      return true;
    } catch {
      return false;
    }
  }
  private async heartbeatRuntimeTurn() {}
}
`,
    );
  }, /claimRuntimeTurn must not swallow/i);
});

test('fails when production client lacks terminal callback wiring', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    const text = readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
    writeFileSync(
      file,
      text
        .replace(/onTerminalStorageError:\s*\(err\)\s*=>\s*\{[\s\S]*?\},/, '')
        .replace(/handleTerminalStorage/g, 'unusedTerminal'),
    );
  }, /terminal|onTerminalStorageError|Reveal Storage/i);
});

test('fails when transaction fault runs before statement loop', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/task/sqlite/worker.ts');
    writeFileSync(
      file,
      `
import { serializeError } from './rpc';
import { maybeInjectFault, bootstrapFaultCapability } from './fault-inject';
bootstrapFaultCapability({});
export function handle() {
  switch ('transaction') {
    case 'transaction':
      maybeInjectFault('transaction');
      for (const stmt of []) {}
      break;
    case 'x':
      break;
  }
}
`,
    );
  }, /inject transaction faults after statements/i);
});

test('fails when terminal handler only disposes uatChatProvider', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    writeFileSync(
      file,
      `
import { DbClient, resolveWorkerPath } from './task/sqlite/client';
let uatChatProvider = { disposeRevisionPoller() {} };
let taskEngine = { shutdown() { return Promise.resolve(); } };
async function handleTerminalStorage() {
  uatChatProvider?.disposeRevisionPoller();
  await taskEngine?.shutdown();
}
const candidate = new DbClient({
  workerPath: resolveWorkerPath(),
  onTerminalStorageError: (err) => { void handleTerminalStorage(err); },
});
void candidate;
`,
    );
  }, /production chatProvider|quiesceForTerminalStorage/i);
});

test('fails when schema fingerprint only checks column names', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/task/sqlite/schema-fingerprint.ts');
    writeFileSync(
      file,
      `
export const REQUIRED_TABLE_COLUMNS = { tasks: ['id'] };
export function findSchemaFingerprintFailure(db) {
  return undefined;
}
`,
    );
  }, /full schema structure|FK|index columns|normalized SQL/i);
});

test('fails when protocol declares exactKeys without real validation', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/task/sqlite/protocol.ts');
    writeFileSync(
      file,
      `
function exactKeys() { return true; }
export function validateRpcErrorPayload() { return {}; }
export function parseWireSuccessResponse() { return { ok: true }; }
`,
    );
  }, /exactKeys must back|strict wire validators/i);
});

test('fails when errors forward raw SQLite message', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/task/sqlite/errors.ts');
    writeFileSync(
      file,
      `
export class MusterSqliteError extends Error {
  constructor(message) { super(message); this.message = message; }
}
export function serializeMusterError() {}
export class MusterDomainError {}
export class MusterInvariantError {}
export function mapToMusterSqliteError(error) {
  return new MusterSqliteError(error.message);
}
export function serializeBoundaryError(error) {
  return { message: error.message };
}
`,
    );
  }, /raw SQLite error\.message/i);
});

test('fails when backup.ts uses copyFile as the backup mechanism', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/task/sqlite/backup.ts');
    writeFileSync(
      file,
      `
import * as fs from 'node:fs';
export function preferredBackupMechanism() { return 'vacuum'; }
export function assertDestinationNotLiveSource() {}
export function verifyBackupArtifact() {}
export async function backupOpenDatabase(db, openPath, opts) {
  fs.copyFileSync(openPath, opts.destinationPath);
  return { mechanism: 'vacuum', schemaVersion: 7, workspaceRevision: 0, byteSize: 1 };
}
export function maybeInjectFault() {}
`,
    );
  }, /must not copyFile|copyFile\/cp the live source/i);
});

test('fails when host module calls node:sqlite.backup', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    const text = readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
    writeFileSync(
      file,
      `import { backup, DatabaseSync } from 'node:sqlite';\n${text}\nvoid backup(new DatabaseSync(':memory:'), '/tmp/x');\n`,
    );
  }, /must not call node:sqlite\.backup on the host thread/i);
});

test('fails when extension introduces telemetry sink for SQLite path', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    const text = readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
    writeFileSync(file, `${text}\nvoid sendTelemetryEvent('sqlite.open', { path: dbPath });\n`);
  }, /telemetry\/content sink/i);
});

test('fails when extension reintroduces legacy JSON store path', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    const text = readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
    writeFileSync(file, `${text}\nconst legacy = '.muster-tasks.json';\nvoid legacy;\n`);
  }, /legacy JSON store/i);
});

test('fails when sqlite debugMuster logs raw error.message without redaction', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    writeFileSync(
      file,
      `
import { DbClient, resolveWorkerPath } from './task/sqlite/client';
function debugMuster(event, details) {}
function handleOpen(error) {
  debugMuster('sqlite.activation.fail_closed', { message: error.message, stack: error.stack });
}
const candidate = new DbClient({
  workerPath: resolveWorkerPath(),
  onTerminalStorageError: () => undefined,
});
void candidate;
void handleOpen;
export async function activate() {
  // Reveal Storage recovery action required by other rules
  void 'Reveal Storage';
}
`,
    );
  }, /raw error\.message\/stack into sqlite debugMuster/i);
});

test('fails when sqlite debugMuster spreads redacted fields plus dbPath', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    const text = readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
    writeFileSync(
      file,
      text.replace(
        /debugMuster\(\s*'sqlite\.activation\.fail_closed'\s*,\s*redactedDiagnosticLogFields\(diagnostic\)\s*\)/,
        "debugMuster('sqlite.activation.fail_closed', { ...redactedDiagnosticLogFields(diagnostic), dbPath })",
      ),
    );
  }, /must not log path\/SQL\/params\/workspaceId/i);
});

test('fails when sqlite debugMuster logs content field', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    const text = readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
    writeFileSync(
      file,
      text.replace(
        /debugMuster\(\s*'sqlite\.activation\.fail_closed'\s*,\s*redactedDiagnosticLogFields\(diagnostic\)\s*\)/,
        "debugMuster('sqlite.activation.fail_closed', { content: diagnostic.message })",
      ),
    );
  }, /must not log path\/SQL\/params\/workspaceId.*content/i);
});

test('fails when appendLine receives raw sql identifier', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/extension.ts');
    const text = readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
    writeFileSync(file, `${text}\nensureMusterDebugChannel().appendLine(sql);\n`);
  }, /appendLine must not emit raw SQLite/i);
});

test('fails when maintenance commands show fsPath in notifications', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'src/host/sqlite-maintenance-commands.ts');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `
export async function handleBackupDatabaseCommand(deps) {
  const destination = await deps.showSaveDialog({ defaultFileName: 'x' });
  await deps.showInformationMessage('saved to ' + destination.fsPath);
  return { kind: 'success', fileName: 'x', meta: {}, path: destination.fsPath };
}
export async function handleDeveloperResetCommand() {}
export const MUSTER_BACKUP_DATABASE_COMMAND = 'muster.backupDatabase';
export const MUSTER_DEVELOPER_RESET_COMMAND = 'muster.developerResetGlobalDatabase';
`,
    );
  }, /must not show fsPath|must not include filesystem paths/i);
});

test('fails when ChatThread drops virtualization for full-list each', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'webview/src/components/ChatThread.svelte');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `
<script>
  // no Virtualizer
</script>
{#each thread.items as item (item.id)}
  <div data-transcript-id={item.id}>{item.text}</div>
{/each}
`,
    );
  }, /Virtualizer|full-list #each/i);
});

test('fails when WEBVIEW docs reintroduce legacy transcript aliases', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'docs/WEBVIEW.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `
# Webview
loadTranscriptPage and transcriptPageResult are current.
Also mentions loadHistory and historyChunk by mistake.
`,
    );
  }, /loadHistory\/historyChunk/i);
});

test('fails when TaskWorkspace drops tree virtualization', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'webview/src/components/TaskWorkspace.svelte');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `
<script></script>
{#if treeExpanded}
{#each treeRows as row (row.task.id)}
  <div data-testid="task-tree-row">{row.task.goal}</div>
{/each}
{/if}
`,
    );
  }, /virtualize expanded tree|full-list #each treeRows|treeVirtualItems/i);
});

test('fails when ChatThread CSS-hides a full thread list', async () => {
  await withMutatedTree((dir) => {
    const file = path.join(dir, 'webview/src/components/ChatThread.svelte');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `
<script>
  import { Virtualizer } from '@tanstack/svelte-virtual';
  let virtualItems = [];
</script>
{#each thread.items as item (item.id)}
  <div style="display: none" data-transcript-id={item.id}>{item.text}</div>
{/each}
{#each virtualItems as vRow (vRow.key)}
  <div></div>
{/each}
`,
    );
  }, /full-list #each thread\.items|CSS-hide/i);
});