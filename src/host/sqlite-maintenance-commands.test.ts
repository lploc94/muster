import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  handleBackupDatabaseCommand,
  handleDeveloperResetCommand,
  handleCompactStorageCommand,
  handleReclaimOrphanedFilesCommand,
  MUSTER_COMPACT_STORAGE_COMMAND,
  MUSTER_BACKUP_DATABASE_COMMAND,
  MUSTER_DEVELOPER_RESET_COMMAND,
  MUSTER_BACKUP_COMMAND_TITLE,
  MUSTER_RESET_COMMAND_TITLE,
  RESET_CHOICE_BACKUP,
  RESET_CHOICE_WITHOUT_BACKUP,
  RESET_MODAL_MESSAGE,
  RECLAIM_ORPHANED_FILES_CHOICE,
  RECLAIM_ORPHANED_FILES_MODAL_MESSAGE,
} from './sqlite-maintenance-commands';
import { SQLITE_SCHEMA_VERSION } from '../task/sqlite/schema';

function readPackageCommands(): Array<{ command: string; title: string }> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
  ) as { contributes: { commands: Array<{ command: string; title: string }> } };
  return pkg.contributes.commands;
}

describe('sqlite maintenance commands (P5-W5)', () => {
  it('contributes exact backup and developer reset command IDs/titles', () => {
    const commands = readPackageCommands();
    expect(commands).toEqual(
      expect.arrayContaining([
        {
          command: MUSTER_BACKUP_DATABASE_COMMAND,
          title: MUSTER_BACKUP_COMMAND_TITLE,
        },
        {
          command: MUSTER_DEVELOPER_RESET_COMMAND,
          title: MUSTER_RESET_COMMAND_TITLE,
        },
      ]),
    );
  });

  it('contributes the exact user-invocable storage compaction command', () => {
    expect(readPackageCommands()).toContainEqual({
      command: MUSTER_COMPACT_STORAGE_COMMAND,
      title: 'Muster: Compact Storage',
    });
  });

  it('reports bounded incremental reclaim measurements after measuring auto_vacuum', async () => {
    const appendLine = vi.fn();
    const reclaimStorage = vi.fn(async () => ({
      mode: 'incremental' as const,
      fileBytesBefore: 8192,
      fileBytesAfter: 4096,
      freelistCountBefore: 4,
      freelistCountAfter: 0,
      batchesRun: 1,
      walCheckpoints: 3,
      residualWalBytes: 0,
    }));

    const result = await handleCompactStorageCommand({
      storageReport: async () => ({ autoVacuum: 2 }),
      reclaimStorage,
      appendLine,
      showErrorMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });

    expect(reclaimStorage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: 'success', mode: 'incremental' });
    expect(appendLine.mock.calls.flat().join('\n')).toContain('file_bytes_before: 8192');
    expect(appendLine.mock.calls.flat().join('\n')).toContain('residual_wal_bytes: 0');
  });

  it('surfaces legacy low-space refusal diagnostics without throwing', async () => {
    const appendLine = vi.fn();
    const result = await handleCompactStorageCommand({
      storageReport: async () => ({ autoVacuum: 0 }),
      reclaimStorage: async () => ({
        mode: 'refused',
        fileBytesBefore: 8192,
        fileBytesAfter: 8192,
        freelistCountBefore: 4,
        freelistCountAfter: 4,
        batchesRun: 0,
        walCheckpoints: 1,
        residualWalBytes: 0,
        requiredBytes: 16384,
        availableBytes: 4096,
      }),
      appendLine,
      showErrorMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });

    expect(result).toMatchObject({ kind: 'refused', requiredBytes: 16384, availableBytes: 4096 });
    expect(appendLine.mock.calls.flat().join('\n')).toContain('required_bytes: 16384');
    expect(appendLine.mock.calls.flat().join('\n')).toContain('available_bytes: 4096');
  });

  it('does not compact an unsupported observed auto_vacuum mode', async () => {
    const reclaimStorage = vi.fn();
    const appendLine = vi.fn();
    const result = await handleCompactStorageCommand({
      storageReport: async () => ({ autoVacuum: 1 }),
      reclaimStorage,
      appendLine,
      showErrorMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });

    expect(result).toEqual({ kind: 'noop', mode: 'noop' });
    expect(reclaimStorage).not.toHaveBeenCalled();
    expect(appendLine.mock.calls.flat().join('\n')).toContain('mode: noop');
  });

  it('rejects compaction while another maintenance operation owns the guard', async () => {
    const storageReport = vi.fn();
    const reclaimStorage = vi.fn();
    const showErrorMessage = vi.fn();

    const result = await handleCompactStorageCommand({
      storageReport,
      reclaimStorage,
      appendLine: vi.fn(),
      showErrorMessage,
      isMaintenanceActive: () => true,
      setMaintenanceActive: vi.fn(),
    });

    expect(result).toMatchObject({ kind: 'error', code: 'busy' });
    expect(storageReport).not.toHaveBeenCalled();
    expect(reclaimStorage).not.toHaveBeenCalled();
    expect(JSON.stringify(showErrorMessage.mock.calls)).not.toMatch(/secret|path/i);
  });

  it('surfaces reclaim failures with the fixed safe error rather than raw SQLite text', async () => {
    const showErrorMessage = vi.fn();
    const result = await handleCompactStorageCommand({
      storageReport: async () => ({ autoVacuum: 2 }),
      reclaimStorage: async () => {
        throw Object.assign(new Error('SQLITE_FULL: /secret/muster.sqlite3'), { code: 'full' });
      },
      appendLine: vi.fn(),
      showErrorMessage,
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });

    expect(result).toMatchObject({ kind: 'error', code: 'full' });
    expect(JSON.stringify(showErrorMessage.mock.calls)).not.toMatch(/secret|SQLITE_FULL|muster\.sqlite3/i);
  });

  it('reclaims classifier-selected files only after confirming legacy-history risk and emits path-free facts', async () => {
    const appendLine = vi.fn();
    const removeStorageOrphans = vi.fn(async () => ({
      removed: [
        { name: '.muster-tasks.json', bytes: 120 },
        { name: '.lease.turn%3Astale', bytes: 30 },
      ],
      bytesReclaimed: 150,
      failedRemovals: 1,
    }));
    let active = false;

    const result = await handleReclaimOrphanedFilesCommand({
      showWarningMessage: async (message, ...items) => {
        expect(message).toBe(RECLAIM_ORPHANED_FILES_MODAL_MESSAGE);
        expect(message).toMatch(/unmigrated legacy history/i);
        expect(items).toEqual([RECLAIM_ORPHANED_FILES_CHOICE]);
        return RECLAIM_ORPHANED_FILES_CHOICE;
      },
      readStorageDirectoryEntries: async () => [],
      classifyStorageOrphans: () => ({
        live: [],
        deadLegacyStores: [{ name: '.muster-tasks.json', bytes: 120 }],
        activeLeases: [],
        staleLeases: [{ name: '.lease.turn%3Astale', bytes: 30 }],
      }),
      removeStorageOrphans,
      appendLine,
      showErrorMessage: vi.fn(),
      isMaintenanceActive: () => active,
      setMaintenanceActive: (value) => { active = value; },
    });

    expect(result).toEqual({ kind: 'success', removedFiles: 2, bytesReclaimed: 150, failedRemovals: 1 });
    expect(removeStorageOrphans).toHaveBeenCalledOnce();
    const report = appendLine.mock.calls.flat().join('\n');
    expect(report).toContain('removed_files: 2');
    expect(report).toContain('bytes_reclaimed: 150');
    expect(report).toContain('failed_removals: 1');
    expect(report).toContain('removed: .muster-tasks.json (120 bytes)');
    expect(report).not.toMatch(/[A-Z]:\\|\//);
    expect(active).toBe(false);
  });

  it('reclaim decline is a strict no-op and releases the guard', async () => {
    const readStorageDirectoryEntries = vi.fn();
    const removeStorageOrphans = vi.fn();
    let active = false;

    const result = await handleReclaimOrphanedFilesCommand({
      showWarningMessage: async () => undefined,
      readStorageDirectoryEntries,
      classifyStorageOrphans: vi.fn(),
      removeStorageOrphans,
      appendLine: vi.fn(),
      showErrorMessage: vi.fn(),
      isMaintenanceActive: () => active,
      setMaintenanceActive: (value) => { active = value; },
    });

    expect(result).toEqual({ kind: 'cancel' });
    expect(readStorageDirectoryEntries).not.toHaveBeenCalled();
    expect(removeStorageOrphans).not.toHaveBeenCalled();
    expect(active).toBe(false);
  });

  it('reclaim rejects while maintenance is active without touching the filesystem', async () => {
    const readStorageDirectoryEntries = vi.fn();
    const showErrorMessage = vi.fn();
    const result = await handleReclaimOrphanedFilesCommand({
      showWarningMessage: vi.fn(),
      readStorageDirectoryEntries,
      classifyStorageOrphans: vi.fn(),
      removeStorageOrphans: vi.fn(),
      appendLine: vi.fn(),
      showErrorMessage,
      isMaintenanceActive: () => true,
      setMaintenanceActive: vi.fn(),
    });

    expect(result).toMatchObject({ kind: 'error', code: 'busy' });
    expect(readStorageDirectoryEntries).not.toHaveBeenCalled();
    expect(JSON.stringify(showErrorMessage.mock.calls)).not.toMatch(/path|secret/i);
  });

  it('reclaim maps classifier failures to a safe error and releases the guard', async () => {
    let active = false;
    const showErrorMessage = vi.fn();
    const result = await handleReclaimOrphanedFilesCommand({
      showWarningMessage: async () => RECLAIM_ORPHANED_FILES_CHOICE,
      readStorageDirectoryEntries: async () => { throw new Error('EACCES: /secret/storage'); },
      classifyStorageOrphans: vi.fn(),
      removeStorageOrphans: vi.fn(),
      appendLine: vi.fn(),
      showErrorMessage,
      isMaintenanceActive: () => active,
      setMaintenanceActive: (value) => { active = value; },
    });

    expect(result).toMatchObject({ kind: 'error', code: 'unknown' });
    expect(JSON.stringify(showErrorMessage.mock.calls)).not.toMatch(/secret|EACCES/i);
    expect(active).toBe(false);
  });

  it('backup cancel is a strict no-op', async () => {
    const backup = vi.fn();
    const showError = vi.fn();
    const setActive = vi.fn();
    const result = await handleBackupDatabaseCommand({
      showSaveDialog: async () => undefined,
      destinationExists: () => false,
      backup,
      showInformationMessage: vi.fn(),
      showErrorMessage: showError,
      isMaintenanceActive: () => false,
      setMaintenanceActive: setActive,
    });
    expect(result).toEqual({ kind: 'cancel' });
    expect(backup).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(setActive).toHaveBeenCalledWith(true);
    expect(setActive).toHaveBeenLastCalledWith(false);
  });

  it('standalone backup claims single-flight and rejects when active', async () => {
    const result = await handleBackupDatabaseCommand({
      showSaveDialog: vi.fn(),
      destinationExists: () => false,
      backup: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      isMaintenanceActive: () => true,
      setMaintenanceActive: vi.fn(),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.code).toBe('busy');
  });

  it('backup success only after verified publish metadata', async () => {
    const meta = {
      mechanism: 'vacuum' as const,
      schemaVersion: SQLITE_SCHEMA_VERSION,
      workspaceRevision: 3,
      byteSize: 4096,
    };
    const backup = vi.fn(async () => meta);
    const info = vi.fn();
    const result = await handleBackupDatabaseCommand({
      showSaveDialog: async () => ({ fsPath: '/tmp/out/muster-backup.sqlite3' }),
      destinationExists: () => false,
      backup,
      showInformationMessage: info,
      showErrorMessage: vi.fn(),
    });
    expect(result).toEqual({
      kind: 'success',
      fileName: 'muster-backup.sqlite3',
      meta,
    });
    expect(backup).toHaveBeenCalledWith('/tmp/out/muster-backup.sqlite3', {
      overwrite: false,
    });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('muster-backup.sqlite3'),
    );
  });

  it('backup failure shows fixed code message without raw error', async () => {
    const showError = vi.fn();
    const result = await handleBackupDatabaseCommand({
      showSaveDialog: async () => ({ fsPath: '/tmp/x.sqlite3' }),
      destinationExists: () => false,
      backup: async () => {
        throw Object.assign(new Error('SQLITE_FULL: /secret/path'), { code: 'full' });
      },
      showInformationMessage: vi.fn(),
      showErrorMessage: showError,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe('full');
      expect(result.message).not.toMatch(/secret|SQLITE_FULL|\/tmp/i);
    }
    expect(JSON.stringify(showError.mock.calls)).not.toMatch(/secret|\/tmp/i);
  });

  it('reset modal states global scope and cancel is no-op', async () => {
    const quiesce = vi.fn();
    const reset = vi.fn();
    const reload = vi.fn();
    const result = await handleDeveloperResetCommand({
      showWarningMessage: async (message, ...items) => {
        expect(message).toBe(RESET_MODAL_MESSAGE);
        expect(items).toEqual([RESET_CHOICE_BACKUP, RESET_CHOICE_WITHOUT_BACKUP]);
        return undefined;
      },
      runBackupFlow: vi.fn(),
      quiesceForMaintenance: quiesce,
      resetDatabase: reset,
      reloadWindow: reload,
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });
    expect(result).toEqual({ kind: 'cancel' });
    expect(quiesce).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('backup-before-reset aborts when backup cancels (no quiesce)', async () => {
    const order: string[] = [];
    let active = false;
    const result = await handleDeveloperResetCommand({
      showWarningMessage: async () => {
        expect(active).toBe(true); // claimed before modal
        return RESET_CHOICE_BACKUP;
      },
      runBackupFlow: async () => {
        order.push('backup');
        return { kind: 'cancel' };
      },
      quiesceForMaintenance: async () => {
        order.push('quiesce');
      },
      resetDatabase: async () => {
        order.push('reset');
        return { schemaVersion: SQLITE_SCHEMA_VERSION };
      },
      reloadWindow: async () => {
        order.push('reload');
      },
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => active,
      setMaintenanceActive: (v) => {
        active = v;
      },
    });
    expect(result).toEqual({ kind: 'cancel' });
    expect(order).toEqual(['backup']);
    expect(active).toBe(false);
  });

  it('backup-before-reset aborts when backup fails (no quiesce)', async () => {
    const order: string[] = [];
    const result = await handleDeveloperResetCommand({
      showWarningMessage: async () => RESET_CHOICE_BACKUP,
      runBackupFlow: async () => {
        order.push('backup');
        return { kind: 'error', code: 'full', message: 'disk full' };
      },
      quiesceForMaintenance: async () => {
        order.push('quiesce');
      },
      resetDatabase: async () => {
        order.push('reset');
        return { schemaVersion: SQLITE_SCHEMA_VERSION };
      },
      reloadWindow: async () => {
        order.push('reload');
      },
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });
    expect(result.kind).toBe('error');
    expect(order).toEqual(['backup']);
  });

  it('successful reset order is backup? → quiesce → reset → reload', async () => {
    const order: string[] = [];
    const setActive = vi.fn();
    const result = await handleDeveloperResetCommand({
      showWarningMessage: async () => RESET_CHOICE_BACKUP,
      runBackupFlow: async () => {
        order.push('backup');
        return {
          kind: 'success',
          fileName: 'b.sqlite3',
          meta: {
            mechanism: 'api',
            schemaVersion: SQLITE_SCHEMA_VERSION,
            workspaceRevision: 1,
            byteSize: 100,
          },
        };
      },
      quiesceForMaintenance: async () => {
        order.push('quiesce');
      },
      resetDatabase: async () => {
        order.push('reset');
        return { schemaVersion: SQLITE_SCHEMA_VERSION };
      },
      reloadWindow: async () => {
        order.push('reload');
      },
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: setActive,
    });
    expect(result).toEqual({ kind: 'success' });
    expect(order).toEqual(['backup', 'quiesce', 'reset', 'reload']);
    expect(setActive).toHaveBeenCalledWith(true);
    expect(setActive).toHaveBeenLastCalledWith(false);
  });

  it('reset without backup skips backup then quiesce/reset/reload', async () => {
    const order: string[] = [];
    const backup = vi.fn();
    await handleDeveloperResetCommand({
      showWarningMessage: async (message, ...items) => {
        expect(message).toBe(RESET_MODAL_MESSAGE);
        expect(items).toEqual([RESET_CHOICE_WITHOUT_BACKUP]);
        return RESET_CHOICE_WITHOUT_BACKUP;
      },
      runBackupFlow: backup,
      quiesceForMaintenance: async () => {
        order.push('quiesce');
      },
      resetDatabase: async () => {
        order.push('reset');
        return { schemaVersion: SQLITE_SCHEMA_VERSION };
      },
      reloadWindow: async () => {
        order.push('reload');
      },
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    }, { withoutBackupOnly: true });
    expect(backup).not.toHaveBeenCalled();
    expect(order).toEqual(['quiesce', 'reset', 'reload']);
  });

  it('single-flight rejects concurrent maintenance', async () => {
    const result = await handleDeveloperResetCommand({
      showWarningMessage: vi.fn(),
      runBackupFlow: vi.fn(),
      quiesceForMaintenance: vi.fn(),
      resetDatabase: vi.fn(),
      reloadWindow: vi.fn(),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => true,
      setMaintenanceActive: vi.fn(),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.code).toBe('busy');
    }
  });

  it('reset failure after quiesce does not reload', async () => {
    const order: string[] = [];
    const result = await handleDeveloperResetCommand({
      showWarningMessage: async () => RESET_CHOICE_WITHOUT_BACKUP,
      runBackupFlow: vi.fn(),
      quiesceForMaintenance: async () => {
        order.push('quiesce');
      },
      resetDatabase: async () => {
        order.push('reset');
        throw Object.assign(new Error('busy'), { code: 'busy' });
      },
      reloadWindow: async () => {
        order.push('reload');
      },
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.recoveryAction).toBe('close_other_windows');
    }
    expect(order).toEqual(['quiesce', 'reset']);
  });

  it('quiesce failure aborts before reset/reload', async () => {
    const order: string[] = [];
    const result = await handleDeveloperResetCommand({
      showWarningMessage: async () => RESET_CHOICE_WITHOUT_BACKUP,
      runBackupFlow: vi.fn(),
      quiesceForMaintenance: async () => {
        order.push('quiesce');
        throw new Error('engine shutdown failed');
      },
      resetDatabase: async () => {
        order.push('reset');
        return { schemaVersion: SQLITE_SCHEMA_VERSION };
      },
      reloadWindow: async () => {
        order.push('reload');
      },
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      isMaintenanceActive: () => false,
      setMaintenanceActive: vi.fn(),
    });
    expect(result.kind).toBe('error');
    expect(order).toEqual(['quiesce']);
  });
});
