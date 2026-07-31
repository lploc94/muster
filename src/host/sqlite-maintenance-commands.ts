/**
 * Pure dependency-injected SQLite maintenance command handlers (P5-W5).
 *
 * Backup database + developer reset global database. No VS Code imports —
 * production wires showSaveDialog / messages / reload; tests inject fakes.
 */
import type { BackupResultMeta, ReclaimResultMeta } from '../task/sqlite/rpc';
import type { ReclaimMode } from '../task/sqlite/reclaim';
import { safeMessageForCode, isSqliteErrorCode, type SqliteErrorCode } from '../task/sqlite/errors';
import type {
  StorageDirectoryEntry,
  StorageOrphanRemoval,
  StorageOrphanReport,
} from './storage-orphans';

export const MUSTER_BACKUP_DATABASE_COMMAND = 'muster.backupDatabase';
export const MUSTER_DEVELOPER_RESET_COMMAND = 'muster.developerResetGlobalDatabase';
export const MUSTER_COMPACT_STORAGE_COMMAND = 'muster.compactStorage';
export const MUSTER_RECLAIM_ORPHANED_FILES_COMMAND = 'muster.reclaimOrphanedFiles';

export const MUSTER_BACKUP_COMMAND_TITLE = 'Muster: Back Up Global Database';
export const MUSTER_RESET_COMMAND_TITLE = 'Muster: Developer Reset Global Database';
export const MUSTER_COMPACT_STORAGE_COMMAND_TITLE = 'Muster: Compact Storage';
export const MUSTER_RECLAIM_ORPHANED_FILES_COMMAND_TITLE = 'Muster: Reclaim Orphaned Files';

export const RECLAIM_ORPHANED_FILES_MODAL_MESSAGE =
  'This permanently removes stale lease files and legacy history that may not have been migrated from Muster storage. This cannot be undone.';
export const RECLAIM_ORPHANED_FILES_CHOICE = 'Reclaim Orphaned Files';

function formatReclaimOrphanedFilesModalMessage(report: StorageOrphanReport): string {
  const removable = [...report.deadLegacyStores, ...report.staleLeases];
  const bytes = removable.reduce((total, file) => total + file.bytes, 0);
  return `${RECLAIM_ORPHANED_FILES_MODAL_MESSAGE}\n\n${removable.length} files (${bytes} bytes) will be permanently removed. Live SQLite data and active leases are not selected.`;
}

/** Exact modal body for global-scope reset (profile + authority). */
export const RESET_MODAL_MESSAGE =
  'This permanently deletes every Muster conversation, task, and durable datum for every workspace in the current VS Code profile and extension-host authority. Settings and secrets are not deleted. This cannot be undone.';

export const RESET_CHOICE_BACKUP = 'Back Up and Reset';
export const RESET_CHOICE_WITHOUT_BACKUP = 'Delete All Muster Data';

export type MaintenanceUri = { fsPath: string; scheme?: string };

export type BackupCommandResult =
  | { kind: 'cancel' }
  | { kind: 'success'; fileName: string; meta: BackupResultMeta }
  | { kind: 'error'; code: string; message: string };

export type ResetCommandResult =
  | { kind: 'cancel' }
  | { kind: 'success' }
  | { kind: 'error'; code: string; message: string; recoveryAction?: string };

export type CompactStorageCommandResult =
  | { kind: 'success'; mode: 'incremental' | 'full' }
  | { kind: 'noop'; mode: 'noop' }
  | { kind: 'refused'; mode: 'refused'; requiredBytes: number; availableBytes: number }
  | { kind: 'error'; code: string; message: string };

/** Per-pass, path-free retention evidence shown by Muster Storage Report. */
export type RetentionPassReport = {
  ordinal: number;
  tasksVisited: number;
  entriesStripped: number;
  toolCallsBytesBefore: number;
  toolCallsBytesAfter: number;
  reclaimMode: ReclaimMode;
  fileBytesBefore: number;
  fileBytesAfter: number;
};

export type RetentionReportSnapshot = {
  completedPasses: number;
  failedPasses: number;
  completedPassDetails: readonly RetentionPassReport[];
};

/** In-memory pass history intentionally resets when the extension host reloads. */
export class RetentionReport {
  private readonly completedPassDetails: RetentionPassReport[] = [];
  private failedPasses = 0;

  recordCompleted(pass: Omit<RetentionPassReport, 'ordinal'> | RetentionPassReport): void {
    this.completedPassDetails.push({ ...pass, ordinal: this.completedPassDetails.length + 1 });
  }

  recordFailure(): void {
    this.failedPasses += 1;
  }

  snapshot(): RetentionReportSnapshot {
    return {
      completedPasses: this.completedPassDetails.length,
      failedPasses: this.failedPasses,
      completedPassDetails: [...this.completedPassDetails],
    };
  }
}

/** Stable, path-free report formatter for the user-invoked Storage Report channel. */
export function formatRetentionReportLines(snapshot: RetentionReportSnapshot): string[] {
  const lines = [
    'Muster retention report',
    `completed_passes: ${snapshot.completedPasses}`,
    `failed_passes: ${snapshot.failedPasses}`,
  ];
  for (const pass of snapshot.completedPassDetails) {
    lines.push(
      `retention_pass: ${pass.ordinal}`,
      `tasks_visited: ${pass.tasksVisited}`,
      `entries_stripped: ${pass.entriesStripped}`,
      `tool_calls_bytes_before: ${pass.toolCallsBytesBefore}`,
      `tool_calls_bytes_after: ${pass.toolCallsBytesAfter}`,
      `reclaim_mode: ${pass.reclaimMode}`,
      `file_bytes_before: ${pass.fileBytesBefore}`,
      `file_bytes_after: ${pass.fileBytesAfter}`,
    );
  }
  return lines;
}

export type DeveloperResetCommandOptions = {
  withoutBackupOnly?: boolean;
};

export type BackupCommandDeps = {
  showSaveDialog: (opts: {
    defaultFileName: string;
  }) => Promise<MaintenanceUri | undefined | null>;
  /** True when the Save dialog selected an existing path (explicit overwrite). */
  destinationExists: (uri: MaintenanceUri) => boolean | Promise<boolean>;
  backup: (
    destinationPath: string,
    options: { overwrite: boolean },
  ) => Promise<BackupResultMeta>;
  showInformationMessage: (message: string) => void | Promise<void>;
  showErrorMessage: (message: string) => void | Promise<void>;
  basename?: (uri: MaintenanceUri) => string;
  /**
   * Single-flight. When `skipMaintenanceGuard` is true (internal backup-before-
   * reset already owns the flag), the guard is not claimed again.
   */
  isMaintenanceActive?: () => boolean;
  setMaintenanceActive?: (active: boolean) => void;
  skipMaintenanceGuard?: boolean;
};

export type CompactStorageCommandDeps = {
  /** Measured mode is the routing authority; never infer it from store age. */
  storageReport: () => Promise<Pick<{ autoVacuum: number }, 'autoVacuum'>>;
  reclaimStorage: () => Promise<ReclaimResultMeta>;
  /** Muster Storage Report channel; handler emits enum/numeric fields only. */
  appendLine: (line: string) => void;
  showErrorMessage: (message: string) => void | PromiseLike<unknown>;
  isMaintenanceActive: () => boolean;
  setMaintenanceActive: (active: boolean) => void;
};

export type ReclaimOrphanedFilesCommandResult =
  | { kind: 'cancel' }
  | { kind: 'success'; removedFiles: number; bytesReclaimed: number; failedRemovals: number }
  | { kind: 'error'; code: string; message: string };

export type ReclaimOrphanedFilesCommandDeps = {
  showWarningMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
  /** The production adapter reads its global storage directory but exposes no path. */
  readStorageDirectoryEntries: () => Promise<readonly StorageDirectoryEntry[]>;
  classifyStorageOrphans: (entries: readonly StorageDirectoryEntry[]) => StorageOrphanReport;
  removeStorageOrphans: (report: StorageOrphanReport) => Promise<StorageOrphanRemoval>;
  /** Muster Storage Report channel; path-free enum, numeric, and basename values only. */
  appendLine: (line: string) => void;
  showErrorMessage: (message: string) => void | PromiseLike<unknown>;
  isMaintenanceActive: () => boolean;
  setMaintenanceActive: (active: boolean) => void;
};

export type ResetCommandDeps = {
  showWarningMessage: (
    message: string,
    ...items: string[]
  ) => Promise<string | undefined>;
  /** Internal backup flow; must not re-claim maintenance flag. */
  runBackupFlow: () => Promise<BackupCommandResult>;
  quiesceForMaintenance: () => Promise<void>;
  resetDatabase: () => Promise<{ schemaVersion: number }>;
  reloadWindow: () => Promise<void> | void;
  showErrorMessage: (message: string) => void | Promise<void>;
  showInformationMessage: (message: string) => void | Promise<void>;
  isMaintenanceActive: () => boolean;
  setMaintenanceActive: (active: boolean) => void;
};

function basenameFromUri(uri: MaintenanceUri): string {
  const p = uri.fsPath.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function errorCodeFromUnknown(error: unknown): SqliteErrorCode {
  const code = (error as { code?: unknown })?.code;
  if (isSqliteErrorCode(code)) return code;
  return 'unknown';
}

/**
 * Muster: Back Up Global Database.
 * Cancel (dialog dismiss) is a strict no-op. Success only after verified publish.
 */
export async function handleBackupDatabaseCommand(
  deps: BackupCommandDeps,
): Promise<BackupCommandResult> {
  const claimGuard = deps.skipMaintenanceGuard !== true;
  if (claimGuard) {
    if (deps.isMaintenanceActive?.()) {
      const message = safeMessageForCode('busy');
      await deps.showErrorMessage(message);
      return { kind: 'error', code: 'busy', message };
    }
    deps.setMaintenanceActive?.(true);
  }

  try {
    let destination: MaintenanceUri | undefined | null;
    try {
      destination = await deps.showSaveDialog({
        defaultFileName: 'muster-backup.sqlite3',
      });
    } catch {
      const message = safeMessageForCode('unknown');
      await deps.showErrorMessage(message);
      return { kind: 'error', code: 'unknown', message };
    }

    if (destination === undefined || destination === null) {
      return { kind: 'cancel' };
    }

    let overwrite = false;
    try {
      overwrite = Boolean(await deps.destinationExists(destination));
    } catch {
      overwrite = false;
    }

    try {
      const meta = await deps.backup(destination.fsPath, { overwrite });
      const fileName = (deps.basename ?? basenameFromUri)(destination);
      await deps.showInformationMessage(
        `Muster database backup saved as ${fileName}.`,
      );
      return { kind: 'success', fileName, meta };
    } catch (error) {
      const code = errorCodeFromUnknown(error);
      const message = safeMessageForCode(code);
      await deps.showErrorMessage(message);
      return { kind: 'error', code, message };
    }
  } finally {
    if (claimGuard) {
      deps.setMaintenanceActive?.(false);
    }
  }
}

/**
 * Muster: Compact Storage. The pre-measured auto_vacuum mode decides whether
 * the worker may use bounded incremental reclaim (2) or legacy preflight-gated
 * full compaction (0). FULL mode (1) is intentionally a no-op.
 */
export async function handleCompactStorageCommand(
  deps: CompactStorageCommandDeps,
): Promise<CompactStorageCommandResult> {
  if (deps.isMaintenanceActive()) {
    const message = safeMessageForCode('busy');
    await deps.showErrorMessage(message);
    return { kind: 'error', code: 'busy', message };
  }
  deps.setMaintenanceActive(true);

  try {
    const report = await deps.storageReport();
    if (report.autoVacuum !== 0 && report.autoVacuum !== 2) {
      deps.appendLine('Muster storage reclamation');
      deps.appendLine('mode: noop');
      deps.appendLine(`auto_vacuum: ${report.autoVacuum}`);
      return { kind: 'noop', mode: 'noop' };
    }

    const result = await deps.reclaimStorage();
    deps.appendLine('Muster storage reclamation');
    deps.appendLine(`mode: ${result.mode}`);
    deps.appendLine(`file_bytes_before: ${result.fileBytesBefore}`);
    deps.appendLine(`file_bytes_after: ${result.fileBytesAfter}`);
    deps.appendLine(`freelist_before: ${result.freelistCountBefore}`);
    deps.appendLine(`freelist_after: ${result.freelistCountAfter}`);
    deps.appendLine(`batches_run: ${result.batchesRun}`);
    deps.appendLine(`wal_checkpoints: ${result.walCheckpoints}`);
    deps.appendLine(`residual_wal_bytes: ${result.residualWalBytes}`);

    if (result.mode === 'refused') {
      // The wire contract makes both values mandatory for refused results.
      const requiredBytes = result.requiredBytes ?? 0;
      const availableBytes = result.availableBytes ?? 0;
      deps.appendLine(`required_bytes: ${requiredBytes}`);
      deps.appendLine(`available_bytes: ${availableBytes}`);
      return { kind: 'refused', mode: 'refused', requiredBytes, availableBytes };
    }
    if (result.mode === 'noop') return { kind: 'noop', mode: 'noop' };
    return { kind: 'success', mode: result.mode };
  } catch (error) {
    const code = errorCodeFromUnknown(error);
    const message = safeMessageForCode(code);
    await deps.showErrorMessage(message);
    return { kind: 'error', code, message };
  } finally {
    deps.setMaintenanceActive(false);
  }
}

/**
 * Muster: Reclaim Orphaned Files. The injected classifier is the sole authority
 * for candidates; this handler never receives or emits a filesystem path.
 */
export async function handleReclaimOrphanedFilesCommand(
  deps: ReclaimOrphanedFilesCommandDeps,
): Promise<ReclaimOrphanedFilesCommandResult> {
  if (deps.isMaintenanceActive()) {
    const message = safeMessageForCode('busy');
    await deps.showErrorMessage(message);
    return { kind: 'error', code: 'busy', message };
  }
  deps.setMaintenanceActive(true);

  try {
    const report = deps.classifyStorageOrphans(await deps.readStorageDirectoryEntries());
    const removableFiles = report.deadLegacyStores.length + report.staleLeases.length;
    if (removableFiles === 0) {
      deps.appendLine('Muster orphan reclamation');
      deps.appendLine('removed_files: 0');
      deps.appendLine('bytes_reclaimed: 0');
      deps.appendLine('failed_removals: 0');
      return { kind: 'success', removedFiles: 0, bytesReclaimed: 0, failedRemovals: 0 };
    }

    let choice: string | undefined;
    try {
      choice = await deps.showWarningMessage(
        formatReclaimOrphanedFilesModalMessage(report),
        RECLAIM_ORPHANED_FILES_CHOICE,
      );
    } catch {
      return { kind: 'cancel' };
    }
    if (choice !== RECLAIM_ORPHANED_FILES_CHOICE) return { kind: 'cancel' };

    const result = await deps.removeStorageOrphans(report);
    deps.appendLine('Muster orphan reclamation');
    deps.appendLine(`removed_files: ${result.removed.length}`);
    deps.appendLine(`bytes_reclaimed: ${result.bytesReclaimed}`);
    deps.appendLine(`failed_removals: ${result.failedRemovals}`);
    for (const file of result.removed) {
      deps.appendLine(`removed: ${file.name} (${file.bytes} bytes)`);
    }
    return {
      kind: 'success',
      removedFiles: result.removed.length,
      bytesReclaimed: result.bytesReclaimed,
      failedRemovals: result.failedRemovals,
    };
  } catch (error) {
    const code = errorCodeFromUnknown(error);
    const message = safeMessageForCode(code);
    await deps.showErrorMessage(message);
    return { kind: 'error', code, message };
  } finally {
    deps.setMaintenanceActive(false);
  }
}

/**
 * Muster: Developer Reset Global Database.
 * Claims single-flight immediately. Cancel and failed/cancelled backup-before-
 * reset release the flag with no quiesce/reset.
 */
export async function handleDeveloperResetCommand(
  deps: ResetCommandDeps,
  options: DeveloperResetCommandOptions = {},
): Promise<ResetCommandResult> {
  if (deps.isMaintenanceActive()) {
    const message = safeMessageForCode('busy');
    await deps.showErrorMessage(message);
    return { kind: 'error', code: 'busy', message, recoveryAction: 'close_other_windows' };
  }
  // Claim before first await so concurrent commands fail closed.
  deps.setMaintenanceActive(true);

  try {
    let choice: string | undefined;
    try {
      choice = await deps.showWarningMessage(
        RESET_MODAL_MESSAGE,
        ...(options.withoutBackupOnly ? [] : [RESET_CHOICE_BACKUP]),
        RESET_CHOICE_WITHOUT_BACKUP,
      );
    } catch {
      return { kind: 'cancel' };
    }

    if (
      choice !== RESET_CHOICE_WITHOUT_BACKUP
      && (!options.withoutBackupOnly && choice !== RESET_CHOICE_BACKUP)
    ) {
      return { kind: 'cancel' };
    }

    if (choice === RESET_CHOICE_BACKUP) {
      const backupResult = await deps.runBackupFlow();
      if (backupResult.kind !== 'success') {
        return backupResult.kind === 'cancel'
          ? { kind: 'cancel' }
          : {
              kind: 'error',
              code: backupResult.code,
              message: backupResult.message,
            };
      }
    }

    try {
      await deps.quiesceForMaintenance();
    } catch {
      const message = safeMessageForCode('unknown');
      await deps.showErrorMessage(message);
      return { kind: 'error', code: 'unknown', message };
    }

    try {
      await deps.resetDatabase();
      await deps.showInformationMessage(
        'Muster global database was reset. Reloading the window.',
      );
      await deps.reloadWindow();
      return { kind: 'success' };
    } catch (error) {
      const code = errorCodeFromUnknown(error);
      const message = safeMessageForCode(code);
      const recoveryAction = code === 'busy' ? 'close_other_windows' : undefined;
      await deps.showErrorMessage(
        recoveryAction === 'close_other_windows'
          ? `${message} Close other Muster windows and try again.`
          : message,
      );
      return {
        kind: 'error',
        code,
        message,
        ...(recoveryAction ? { recoveryAction } : {}),
      };
    }
  } finally {
    deps.setMaintenanceActive(false);
  }
}
