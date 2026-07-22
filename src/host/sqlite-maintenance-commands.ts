/**
 * Pure dependency-injected SQLite maintenance command handlers (P5-W5).
 *
 * Backup database + developer reset global database. No VS Code imports —
 * production wires showSaveDialog / messages / reload; tests inject fakes.
 */
import type { BackupResultMeta } from '../task/sqlite/rpc';
import { safeMessageForCode, isSqliteErrorCode, type SqliteErrorCode } from '../task/sqlite/errors';

export const MUSTER_BACKUP_DATABASE_COMMAND = 'muster.backupDatabase';
export const MUSTER_DEVELOPER_RESET_COMMAND = 'muster.developerResetGlobalDatabase';

export const MUSTER_BACKUP_COMMAND_TITLE = 'Muster: Back Up Global Database';
export const MUSTER_RESET_COMMAND_TITLE = 'Muster: Developer Reset Global Database';

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
