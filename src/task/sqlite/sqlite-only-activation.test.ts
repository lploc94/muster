import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8');
const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as { contributes: { commands: Array<{ command: string; title: string }> } };

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

  it('registers orphan reclamation through the path-free storage adapters and contributes it to VS Code', () => {
    expect(extensionSource).toContain('registerCommand(MUSTER_RECLAIM_ORPHANED_FILES_COMMAND');
    expect(extensionSource).toContain('handleReclaimOrphanedFilesCommand({');
    expect(extensionSource).toContain('readStorageDirectoryEntries: () => readStorageDirectoryEntries(storageDirectory)');
    expect(extensionSource).toContain('classifyStorageOrphans: (entries) => classifyStorageOrphans(entries, Date.now(), 60_000)');
    expect(extensionSource).toContain('removeStorageOrphans: (report) => removeStorageOrphans(storageDirectory, report)');
    expect(packageJson.contributes.commands).toContainEqual({
      command: 'muster.reclaimOrphanedFiles',
      title: 'Muster: Reclaim Orphaned Files',
    });
  });

  it('keeps orphan reclamation explicit-command-only with no automatic lifecycle caller', () => {
    const reclaimHandlerReferences = extensionSource.match(/handleReclaimOrphanedFilesCommand/g) ?? [];

    // One import and one direct invocation in the Command Palette registration are
    // the complete production topology. A timer, watcher, activation hook, or
    // retention path must not gain another call site.
    expect(reclaimHandlerReferences).toHaveLength(2);
    expect(extensionSource).toMatch(
      /registerCommand\(MUSTER_RECLAIM_ORPHANED_FILES_COMMAND,[\s\S]*?handleReclaimOrphanedFilesCommand\(\{[\s\S]*?\}\),/,
    );
    expect(extensionSource).not.toMatch(
      /(?:setInterval|setTimeout|createFileSystemWatcher|applyRetentionToRepository|runRetentionPass)[\s\S]{0,800}handleReclaimOrphanedFilesCommand/,
    );
  });

  it('registers storage report and user-invocable compaction through the redacted client surface', () => {
    expect(extensionSource).toContain("registerCommand('muster.storageReport'");
    expect(extensionSource).toContain('registerCommand(MUSTER_COMPACT_STORAGE_COMMAND');
    expect(extensionSource).toContain('handleCompactStorageCommand({');
    expect(extensionSource).toContain('reclaimStorage: () => client.reclaimStorage()');
    expect(extensionSource).toContain('sqliteClient.storageReport()');
    expect(extensionSource).toContain('readStorageDirectoryEntries(');
    expect(extensionSource).toContain('classifyStorageOrphans(');
    for (const field of [
      'fileBytes',
      'walBytes',
      'shmBytes',
      'pageCount',
      'freelistCount',
      'pageSize',
      'autoVacuum',
      'tableBytesSource',
    ]) {
      expect(extensionSource).toContain(`report.${field}`);
    }
  });

  it('wires storage lifecycle UAT commands to activated repository, SQLite client, and retention report singletons', () => {
    expect(extensionSource).toContain('registerCommand(UAT_COMMANDS.seedStorageWorkload');
    expect(extensionSource).toContain('seedStorageWorkload(repository, workspaceId)');
    expect(extensionSource).toContain('registerCommand(UAT_COMMANDS.storageLifecycleState');
    expect(extensionSource).toContain('readStorageLifecycleState({');
    expect(extensionSource).toContain('repository,');
    expect(extensionSource).toContain('sqliteClient: requireClient(),');
    expect(extensionSource).toContain('retentionReport,');
    expect(extensionSource).toContain('workspaceId,');
    expect(extensionSource).toContain('registerCommand(UAT_COMMANDS.runRetentionPass');
    expect(extensionSource).toContain('runRetentionPass(() => applyRetentionToRepository(repository))');
    expect(packageJson.contributes.commands).not.toContainEqual(
      expect.objectContaining({ command: 'muster.uat.storageLifecycleState' }),
    );
  });
});
