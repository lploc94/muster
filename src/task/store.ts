import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { deriveViewStatus } from './derived-status';
import type { MusterTask, TaskLifecycleState, TaskMessage, TaskStoreFile, TaskTurn, TaskViewStatus } from './types';

export const CURRENT_SCHEMA_VERSION = 2;

export interface StoreOptions {
  filePath: string;
  schemaVersion?: number;
  lockMaxWaitMs?: number;
  lockRetryMs?: number;
  onCommit?: (file: TaskStoreFile, affectedTaskIds: string[]) => void;
}

export type ApplyResult = { ok: true } | { ok: false; reason: string };

export type CommitResult =
  | { ok: true; revision: number; file: Readonly<TaskStoreFile> }
  | { ok: false; reason: 'rejected' | 'io_error'; detail?: string };

interface LockRecord {
  pid: number;
  token: string;
}

function emptyEnvelope(schemaVersion: number): TaskStoreFile {
  const base: TaskStoreFile = {
    schemaVersion,
    revision: 0,
    tasks: {},
    turns: {},
    messages: {},
  };
  if (schemaVersion >= 2) {
    base.operations = {};
    base.cancelRequests = {};
  }
  return base;
}

function cloneFile(file: TaskStoreFile): TaskStoreFile {
  return JSON.parse(JSON.stringify(file)) as TaskStoreFile;
}

function isProcessDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'ESRCH';
  }
}

function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as LockRecord;
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sleep(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // busy-wait for short test-friendly sleeps without timers
  }
}

export function migrate(file: TaskStoreFile, targetVersion: number): TaskStoreFile {
  if (file.schemaVersion > targetVersion) {
    throw new Error(
      `Store schema ${file.schemaVersion} is newer than supported ${targetVersion}`,
    );
  }
  let current = cloneFile(file);
  while (current.schemaVersion < targetVersion) {
    if (current.schemaVersion === 0) {
      current.schemaVersion = 1;
      continue;
    }
    if (current.schemaVersion === 1) {
      current.schemaVersion = 2;
      current.operations = current.operations ?? {};
      current.cancelRequests = current.cancelRequests ?? {};
      continue;
    }
    throw new Error(`No migration path from schema ${current.schemaVersion}`);
  }
  return current;
}

function parseStoreFile(raw: string, targetVersion: number): TaskStoreFile {
  const parsed = JSON.parse(raw) as TaskStoreFile;
  if (
    typeof parsed.schemaVersion !== 'number' ||
    typeof parsed.revision !== 'number' ||
    !parsed.tasks ||
    !parsed.turns ||
    !parsed.messages
  ) {
    throw new Error('Invalid TaskStoreFile shape');
  }
  return migrate(parsed, targetVersion);
}

function readFreshFile(filePath: string, schemaVersion: number): TaskStoreFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseStoreFile(raw, schemaVersion);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return emptyEnvelope(schemaVersion);
    }
    throw error;
  }
}

function preserveCorruptFile(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const corruptPath = `${filePath}.corrupt-${stamp}`;
  fs.copyFileSync(filePath, corruptPath);
  return corruptPath;
}

function findRootId(file: TaskStoreFile, taskId: string): string | undefined {
  const task = file.tasks[taskId];
  if (!task) {
    return undefined;
  }
  let current: MusterTask | undefined = task;
  while (current.parentId) {
    current = file.tasks[current.parentId];
    if (!current) {
      return taskId;
    }
  }
  return current.id;
}

function childIdsOf(file: TaskStoreFile, taskId: string): string[] {
  return Object.values(file.tasks)
    .filter((task) => task.parentId === taskId)
    .map((task) => task.id)
    .sort();
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

function depLifecyclesForTask(file: TaskStoreFile, task: MusterTask): Map<string, TaskLifecycleState> {
  const map = new Map<string, TaskLifecycleState>();
  for (const dep of task.dependencies) {
    const depTask = file.tasks[dep.taskId];
    if (depTask) {
      map.set(dep.taskId, depTask.lifecycle);
    }
  }
  return map;
}

function rebuildIndexes(file: TaskStoreFile): {
  rootOf: Map<string, string>;
  childIdsOf: Map<string, string[]>;
  viewStatusOf: Map<string, TaskViewStatus>;
} {
  const rootOf = new Map<string, string>();
  const childIds = new Map<string, string[]>();
  const viewStatusOf = new Map<string, TaskViewStatus>();

  for (const taskId of Object.keys(file.tasks)) {
    const root = findRootId(file, taskId);
    if (root) {
      rootOf.set(taskId, root);
    }
    childIds.set(taskId, childIdsOf(file, taskId));
    const task = file.tasks[taskId];
    viewStatusOf.set(
      taskId,
      deriveViewStatus(task, turnsForTask(file, taskId), depLifecyclesForTask(file, task)),
    );
  }

  return { rootOf, childIdsOf: childIds, viewStatusOf };
}

export function computeAffectedTaskIds(before: TaskStoreFile, after: TaskStoreFile): string[] {
  const affected = new Set<string>();

  const allTaskIds = new Set([...Object.keys(before.tasks), ...Object.keys(after.tasks)]);
  for (const id of allTaskIds) {
    const prev = before.tasks[id];
    const next = after.tasks[id];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      if (next) {
        affected.add(id);
      } else if (prev) {
        affected.add(prev.id);
      }
    }
  }

  const allTurnIds = new Set([...Object.keys(before.turns), ...Object.keys(after.turns)]);
  for (const id of allTurnIds) {
    const prev = before.turns[id];
    const next = after.turns[id];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      if (next) {
        affected.add(next.taskId);
      } else if (prev) {
        affected.add(prev.taskId);
      }
    }
  }

  const allMessageIds = new Set([...Object.keys(before.messages), ...Object.keys(after.messages)]);
  for (const id of allMessageIds) {
    const prev = before.messages[id];
    const next = after.messages[id];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      if (next) {
        affected.add(next.taskId);
      } else if (prev) {
        affected.add(prev.taskId);
      }
    }
  }

  return [...affected];
}

export class TaskStore {
  private readonly filePath: string;
  private readonly schemaVersion: number;
  private readonly lockPath: string;
  private readonly lockMaxWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly onCommit?: (file: TaskStoreFile, affectedTaskIds: string[]) => void;
  private file: TaskStoreFile;
  private rootOfIndex = new Map<string, string>();
  private childIdsIndex = new Map<string, string[]>();
  private viewStatusIndex = new Map<string, TaskViewStatus>();
  private ownedLock: LockRecord | undefined;

  private constructor(filePath: string, schemaVersion: number, file: TaskStoreFile, opts: StoreOptions) {
    this.filePath = filePath;
    this.schemaVersion = schemaVersion;
    this.lockPath = `${filePath}.lock`;
    this.lockMaxWaitMs = opts.lockMaxWaitMs ?? 5_000;
    this.lockRetryMs = opts.lockRetryMs ?? 25;
    this.onCommit = opts.onCommit;
    this.file = file;
    this.refreshIndexes();
  }

  static load(opts: StoreOptions): TaskStore {
    const schemaVersion = opts.schemaVersion ?? CURRENT_SCHEMA_VERSION;
    try {
      const file = readFreshFile(opts.filePath, schemaVersion);
      return new TaskStore(opts.filePath, schemaVersion, file, opts);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return new TaskStore(opts.filePath, schemaVersion, emptyEnvelope(schemaVersion), opts);
      }
      preserveCorruptFile(opts.filePath);
      throw new Error(`Corrupt task store preserved; failed to parse ${opts.filePath}: ${err.message}`);
    }
  }

  private refreshIndexes(): void {
    const indexes = rebuildIndexes(this.file);
    this.rootOfIndex = indexes.rootOf;
    this.childIdsIndex = indexes.childIdsOf;
    this.viewStatusIndex = indexes.viewStatusOf;
  }

  getStorePath(): string {
    return this.filePath;
  }

  getFile(): Readonly<TaskStoreFile> {
    return this.file;
  }

  reload(): void {
    this.file = readFreshFile(this.filePath, this.schemaVersion);
    this.refreshIndexes();
  }

  getTask(id: string): MusterTask | undefined {
    return this.file.tasks[id];
  }

  getTurnsForTask(taskId: string): TaskTurn[] {
    return turnsForTask(this.file, taskId);
  }

  getMessagesForTask(taskId: string): TaskMessage[] {
    return Object.values(this.file.messages)
      .filter((message) => message.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  rootOf(taskId: string): string | undefined {
    return this.rootOfIndex.get(taskId);
  }

  childIds(taskId: string): string[] {
    return this.childIdsIndex.get(taskId) ?? [];
  }

  viewStatusOf(taskId: string): TaskViewStatus | undefined {
    return this.viewStatusIndex.get(taskId);
  }

  private tryAcquireLock(): LockRecord | undefined {
    const token = randomBytes(16).toString('hex');
    const record: LockRecord = { pid: process.pid, token };
    const tmpPath = `${this.lockPath}.${process.pid}.${token}.tmp`;

    // Write the full record to a private temp file first, then publish it with an
    // atomic, exclusive link. This guarantees the lock path is either absent or a
    // fully-written record — never an empty/partial file, even if this process is
    // killed mid-acquire. (The old openSync('wx')+writeFileSync could leave an empty
    // lock on a crash, which then deadlocked every future acquire.)
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
    } catch {
      return undefined;
    }

    try {
      fs.linkSync(tmpPath, this.lockPath);
      return record;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        // A lock is present. Reclaim it if the owner is dead or the file is
        // corrupt/empty, then let acquireLock() retry on the next tick.
        this.reclaimStaleLock();
      }
      return undefined;
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort: an orphaned temp is harmless and uniquely named
      }
    }
  }

  /**
   * Reclaim a lock only when it is safe. Never disturbs a well-formed lock owned by
   * a live process. Otherwise it claims the suspicious lock atomically via rename —
   * only one contender can win that rename, and each operates on the exact file
   * instance it removed — which closes the read-then-unlink TOCTOU where a stale
   * read could otherwise delete a freshly acquired live lock.
   */
  private reclaimStaleLock(): boolean {
    const observed = readLockRecord(this.lockPath);
    if (observed && !isProcessDead(observed.pid)) {
      return false;
    }
    // Looks stale (dead owner) or corrupt/empty. Claim it atomically by renaming it
    // aside instead of unlinking the path in place.
    const quarantine = `${this.lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
    try {
      fs.renameSync(this.lockPath, quarantine);
    } catch (error) {
      // ENOENT: another contender already reclaimed it — the path is free now, so a
      // retry can acquire. Any other error: leave the lock untouched.
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    // We now exclusively hold whatever WAS at lockPath. Re-inspect that instance.
    const claimed = readLockRecord(quarantine);
    if (claimed && !isProcessDead(claimed.pid)) {
      // Rare race: a fresh, live lock was published between the observation and the
      // rename. Best-effort restore so its owner is not silently displaced.
      try {
        fs.linkSync(quarantine, this.lockPath);
      } catch {
        // lockPath already re-taken by another acquirer; nothing safe to do.
      }
      try {
        fs.unlinkSync(quarantine);
      } catch {
        // best-effort
      }
      return false;
    }
    // Confirmed stale/corrupt — discard it. lockPath is now free for a retry.
    try {
      fs.unlinkSync(quarantine);
    } catch {
      // best-effort
    }
    return true;
  }

  private acquireLock(): LockRecord | undefined {
    // Defense in depth: ensure the lock's directory exists before acquiring. The
    // store path may be a not-yet-created globalStorage directory; a missing parent
    // otherwise surfaces as ENOENT and, historically, a misleading lock error.
    try {
      fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    } catch {
      // ignore — a subsequent IO failure will surface the real error
    }
    const deadline = Date.now() + this.lockMaxWaitMs;
    while (Date.now() < deadline) {
      const lock = this.tryAcquireLock();
      if (lock) {
        return lock;
      }
      sleep(this.lockRetryMs);
    }
    return undefined;
  }

  private releaseLock(lock: LockRecord): void {
    const existing = readLockRecord(this.lockPath);
    if (existing?.pid === lock.pid && existing.token === lock.token) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // best-effort
      }
    }
  }

  commit(apply: (draft: TaskStoreFile) => ApplyResult): CommitResult {
    const lock = this.acquireLock();
    if (!lock) {
      return { ok: false, reason: 'io_error', detail: 'could not acquire store lock' };
    }
    this.ownedLock = lock;
    let result: CommitResult = { ok: false, reason: 'io_error', detail: 'commit did not complete' };
    let onCommitPayload: { file: TaskStoreFile; affectedTaskIds: string[] } | undefined;
    try {
      let draft: TaskStoreFile;
      let loadFailed = false;
      try {
        draft = readFreshFile(this.filePath, this.schemaVersion);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          draft = emptyEnvelope(this.schemaVersion);
        } else {
          preserveCorruptFile(this.filePath);
          result = {
            ok: false,
            reason: 'io_error',
            detail: `corrupt store preserved: ${err.message}`,
          };
          loadFailed = true;
          draft = emptyEnvelope(this.schemaVersion);
        }
      }

      if (!loadFailed) {
        const before = cloneFile(draft);
        const applyResult = apply(draft);
        if (!applyResult.ok) {
          result = { ok: false, reason: 'rejected', detail: applyResult.reason };
        } else {
          draft.revision += 1;
          draft.schemaVersion = this.schemaVersion;

          const tempPath = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
          let writeFailed = false;
          try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(tempPath, JSON.stringify(draft, null, 2), 'utf8');
            fs.renameSync(tempPath, this.filePath);
          } catch (error) {
            try {
              fs.unlinkSync(tempPath);
            } catch {
              // ignore
            }
            const err = error as NodeJS.ErrnoException;
            result = { ok: false, reason: 'io_error', detail: err.message };
            writeFailed = true;
          }

          if (!writeFailed) {
            this.file = draft;
            this.refreshIndexes();
            if (this.onCommit) {
              onCommitPayload = { file: draft, affectedTaskIds: computeAffectedTaskIds(before, draft) };
            }
            result = { ok: true, revision: draft.revision, file: this.file };
          }
        }
      }
    } finally {
      this.releaseLock(lock);
      this.ownedLock = undefined;
    }
    // onCommit runs after the store lock is released so nested commits (e.g. retention) can acquire it.
    if (onCommitPayload && this.onCommit) {
      try {
        this.onCommit(onCommitPayload.file, onCommitPayload.affectedTaskIds);
      } catch {
        // onCommit is best-effort and must not affect persisted state
      }
    }
    return result;
  }
}