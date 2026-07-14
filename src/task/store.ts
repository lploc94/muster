import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { deriveViewStatus } from './derived-status';
import type {
  MusterTask,
  TaskHandoffCompletion,
  TaskHandoffConversationContext,
  TaskHandoffFailure,
  TaskHandoffPhase,
  TaskHandoffRuntimeBinding,
  TaskHandoffSourceSummary,
  TaskHandoffState,
  TaskLifecycleState,
  TaskMessage,
  TaskStoreFile,
  TaskTurn,
  TaskViewStatus,
} from './types';

export const CURRENT_SCHEMA_VERSION = 4;

export interface StoreOptions {
  filePath: string;
  schemaVersion?: number;
  lockMaxWaitMs?: number;
  lockRetryMs?: number;
  onCommit?: (file: TaskStoreFile, affectedTaskIds: string[]) => void;
}

export type ApplyResult = { ok: true } | { ok: false; reason: string };

/**
 * Recoverable-corruption signal. When the on-disk store cannot be parsed, the
 * store quarantines a copy (see {@link TaskStore.getRecoveryInfo}) and exposes
 * this instead of silently resetting the user's data. The extension host can use
 * it to enter a read-only recovery mode and let the user choose to start fresh.
 */
export interface StoreCorruptInfo {
  /** Path to the content-addressed `.corrupt-<hash>` quarantine copy. */
  backupPath: string;
  /** Parse-error detail. */
  detail: string;
  /** ISO timestamp the corruption was first observed. */
  observedAt: string;
}

export type CommitResult =
  | { ok: true; revision: number; file: Readonly<TaskStoreFile> }
  | { ok: false; reason: 'rejected' | 'io_error'; detail?: string }
  | { ok: false; reason: 'store_corrupt'; detail?: string; backupPath: string };

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
  if (schemaVersion >= 3) {
    base.toolCalls = {};
    base.reasoning = {};
  }
  if (schemaVersion >= 4) {
    base.sendReceipts = {};
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

/**
 * Synchronous, NON-SPINNING sleep. Parks the thread for `ms` without burning CPU by
 * blocking on `Atomics.wait` against a throwaway zero-initialised SharedArrayBuffer that
 * nothing ever notifies — so the wait always runs to its `ms` timeout. This is permitted
 * on Node's main (extension-host) thread. It replaces the old `while (Date.now() < deadline)`
 * busy-wait, which pinned a whole CPU core whenever multiple VS Code windows contended for
 * the shared globalStorage store lock.
 *
 * NOTE: the store API (and `commit()`) stays fully SYNCHRONOUS on purpose — a sync→async
 * lock refactor ripples across the entire engine and is out of scope here. A truly
 * non-blocking async lock is a deliberate future follow-up; this change only removes the
 * CPU burn, not the synchronous blocking.
 */
export function sleep(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const HANDOFF_PHASES: ReadonlySet<string> = new Set([
  'requested',
  'exporting_context',
  'summarizing_source',
  'preparing_receiver',
  'transferring',
  'completed',
  'failed',
  'cancelled',
]);

const HANDOFF_FAILURE_MESSAGE_MAX = 240;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * Bound and scrub handoff failure text so diagnostics never retain absolute paths,
 * credential-like tokens, or long conversation/CLI bodies.
 */
export function sanitizeHandoffFailureMessage(message: string): string {
  let text = message
    // Windows absolute paths (C:\...)
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[path]')
    // POSIX absolute paths
    .replace(/(?:^|[\s"'`(=])(\/(?:[^\s"'`)]+\/)+[^\s"'`)]+)/g, (match, pathPart: string) =>
      match.replace(pathPart, '[path]'),
    )
    // Common secret / token shapes (sk-…, api_key-…, etc.)
    .replace(
      /\b(?:sk|pk|api[_-]?key|token|secret|key)[-_][A-Za-z0-9][-_A-Za-z0-9]{4,}\b/gi,
      '[redacted]',
    )
    // Collapse long runs (conversation dumps / raw CLI)
    .replace(/([A-Za-z0-9])\1{20,}/g, '$1$1$1…');

  if (text.length > HANDOFF_FAILURE_MESSAGE_MAX) {
    text = `${text.slice(0, HANDOFF_FAILURE_MESSAGE_MAX - 1)}…`;
  }
  return text;
}

function sanitizeRuntimeBinding(raw: unknown): TaskHandoffRuntimeBinding | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.backend)) {
    return undefined;
  }
  if (!isOptionalString(obj.model) || !isOptionalString(obj.sessionId)) {
    return undefined;
  }
  const binding: TaskHandoffRuntimeBinding = { backend: obj.backend };
  if (typeof obj.model === 'string' && obj.model.length > 0) {
    binding.model = obj.model;
  }
  if (typeof obj.sessionId === 'string' && obj.sessionId.length > 0) {
    binding.sessionId = obj.sessionId;
  }
  return binding;
}

function sanitizeConversationContext(raw: unknown): TaskHandoffConversationContext | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.status === 'pending') {
    return { status: 'pending' };
  }
  if (obj.status === 'unavailable') {
    if (!isNonEmptyString(obj.reason)) {
      return undefined;
    }
    return { status: 'unavailable', reason: obj.reason.slice(0, 120) };
  }
  if (obj.status === 'ready') {
    if (
      typeof obj.messageCount !== 'number' ||
      !Number.isFinite(obj.messageCount) ||
      obj.messageCount < 0 ||
      !isNonEmptyString(obj.contentDigest) ||
      !isNonEmptyString(obj.exportedAt)
    ) {
      return undefined;
    }
    return {
      status: 'ready',
      messageCount: Math.floor(obj.messageCount),
      contentDigest: obj.contentDigest.slice(0, 128),
      exportedAt: obj.exportedAt,
    };
  }
  return undefined;
}

function sanitizeSourceSummary(raw: unknown): TaskHandoffSourceSummary | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.status === 'pending') {
    return { status: 'pending' };
  }
  if (obj.status === 'unavailable' || obj.status === 'skipped') {
    if (!isNonEmptyString(obj.reason)) {
      return undefined;
    }
    return { status: obj.status, reason: obj.reason.slice(0, 120) };
  }
  if (obj.status === 'ready') {
    if (!isNonEmptyString(obj.contentDigest) || !isNonEmptyString(obj.summarizedAt)) {
      return undefined;
    }
    return {
      status: 'ready',
      contentDigest: obj.contentDigest.slice(0, 128),
      summarizedAt: obj.summarizedAt,
    };
  }
  return undefined;
}

function sanitizeCompletion(raw: unknown): TaskHandoffCompletion | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.completedAt) || !isNonEmptyString(obj.boundBackend)) {
    return undefined;
  }
  if (!isOptionalString(obj.boundSessionId)) {
    return undefined;
  }
  const completion: TaskHandoffCompletion = {
    completedAt: obj.completedAt,
    boundBackend: obj.boundBackend,
  };
  if (typeof obj.boundSessionId === 'string' && obj.boundSessionId.length > 0) {
    completion.boundSessionId = obj.boundSessionId;
  }
  return completion;
}

function sanitizeFailure(raw: unknown): TaskHandoffFailure | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.code) || !isNonEmptyString(obj.message) || !isNonEmptyString(obj.at)) {
    return undefined;
  }
  return {
    code: obj.code.slice(0, 64),
    message: sanitizeHandoffFailureMessage(obj.message),
    at: obj.at,
  };
}

/**
 * Validate and normalize a persisted handoff record.
 * Returns undefined when the record is absent or malformed (fail closed — strip field,
 * keep the task). Never quarantines the whole store for a bad handoff field.
 */
export function sanitizeTaskHandoffState(raw: unknown): TaskHandoffState | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    return undefined;
  }
  if (!isNonEmptyString(obj.operationId)) {
    return undefined;
  }
  if (typeof obj.phase !== 'string' || !HANDOFF_PHASES.has(obj.phase)) {
    return undefined;
  }
  const source = sanitizeRuntimeBinding(obj.source);
  const target = sanitizeRuntimeBinding(obj.target);
  const conversationContext = sanitizeConversationContext(obj.conversationContext);
  if (!source || !target || !conversationContext) {
    return undefined;
  }
  if (!isNonEmptyString(obj.createdAt) || !isNonEmptyString(obj.updatedAt)) {
    return undefined;
  }
  if (!isOptionalString(obj.startedAt) || !isOptionalString(obj.finishedAt)) {
    return undefined;
  }

  const sourceSummary =
    obj.sourceSummary === undefined ? undefined : sanitizeSourceSummary(obj.sourceSummary);
  // Present-but-malformed optional sourceSummary fails the whole handoff closed.
  if (obj.sourceSummary !== undefined && sourceSummary === undefined) {
    return undefined;
  }

  const completion = obj.completion === undefined ? undefined : sanitizeCompletion(obj.completion);
  if (obj.completion !== undefined && completion === undefined) {
    return undefined;
  }

  const failure = obj.failure === undefined ? undefined : sanitizeFailure(obj.failure);
  if (obj.failure !== undefined && failure === undefined) {
    return undefined;
  }

  const state: TaskHandoffState = {
    version: 1,
    operationId: obj.operationId.slice(0, 128),
    phase: obj.phase as TaskHandoffPhase,
    source,
    target,
    conversationContext,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
  if (typeof obj.startedAt === 'string' && obj.startedAt.length > 0) {
    state.startedAt = obj.startedAt;
  }
  if (typeof obj.finishedAt === 'string' && obj.finishedAt.length > 0) {
    state.finishedAt = obj.finishedAt;
  }
  if (sourceSummary) {
    state.sourceSummary = sourceSummary;
  }
  if (completion) {
    state.completion = completion;
  }
  if (failure) {
    state.failure = failure;
  }
  return state;
}

/**
 * Normalize optional handoff fields on every task after parse/migration.
 * Legacy tasks without `handoff` are unchanged. Malformed handoff is stripped.
 */
export function sanitizeTaskHandoffs(file: TaskStoreFile): TaskStoreFile {
  for (const task of Object.values(file.tasks)) {
    if (!Object.prototype.hasOwnProperty.call(task, 'handoff')) {
      continue;
    }
    const sanitized = sanitizeTaskHandoffState((task as MusterTask & { handoff?: unknown }).handoff);
    if (sanitized) {
      task.handoff = sanitized;
    } else {
      delete task.handoff;
    }
  }
  return file;
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
    if (current.schemaVersion === 2) {
      current.schemaVersion = 3;
      current.toolCalls = current.toolCalls ?? {};
      current.reasoning = current.reasoning ?? {};
      continue;
    }
    if (current.schemaVersion === 3) {
      current.schemaVersion = 4;
      current.sendReceipts = current.sendReceipts ?? {};
      continue;
    }
    throw new Error(`No migration path from schema ${current.schemaVersion}`);
  }
  // Schema-compatible optional field: sanitize handoff without a schema bump.
  return sanitizeTaskHandoffs(current);
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

/**
 * Quarantine a corrupt store, keyed by a content hash rather than a timestamp.
 * Identical corrupt bytes therefore map to the same `.corrupt-<hash>` backup, so
 * repeated commits against the same corruption never accumulate an unbounded set
 * of backup files. A genuinely different corruption hashes differently and gets
 * its own distinct backup. Best-effort: quarantine must never mask the underlying
 * corruption signal, so any IO failure here is swallowed.
 */
function preserveCorruptFile(filePath: string): string {
  let corruptPath = `${filePath}.corrupt`;
  try {
    const raw = fs.readFileSync(filePath);
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    corruptPath = `${filePath}.corrupt-${hash}`;
    if (!fs.existsSync(corruptPath)) {
      fs.writeFileSync(corruptPath, raw);
    }
  } catch {
    // best-effort — return the intended path even if the copy could not be made
  }
  return corruptPath;
}

/**
 * Read the store, recovering from an unparseable file instead of throwing. On a
 * non-ENOENT parse/read failure the corrupt bytes are quarantined once
 * (content-addressed) and a {@link StoreCorruptInfo} is returned alongside an
 * empty in-memory envelope, so callers surface a recoverable state rather than
 * bricking at startup or on external writes. The on-disk file is never modified
 * here, so a subsequent commit still refuses to overwrite the user's data.
 */
function readFreshFileRecoverable(
  filePath: string,
  schemaVersion: number,
): { file: TaskStoreFile; corruptInfo?: StoreCorruptInfo } {
  try {
    return { file: readFreshFile(filePath, schemaVersion) };
  } catch (error) {
    // readFreshFile only rethrows non-ENOENT (parse/read/migration) failures.
    const err = error as NodeJS.ErrnoException;
    const backupPath = preserveCorruptFile(filePath);
    return {
      file: emptyEnvelope(schemaVersion),
      corruptInfo: {
        backupPath,
        detail: err.message ?? String(error),
        observedAt: new Date().toISOString(),
      },
    };
  }
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

  const allToolCallIds = new Set([
    ...Object.keys(before.toolCalls ?? {}),
    ...Object.keys(after.toolCalls ?? {}),
  ]);
  for (const id of allToolCallIds) {
    const prev = before.toolCalls?.[id];
    const next = after.toolCalls?.[id];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      if (next) {
        affected.add(next.taskId);
      } else if (prev) {
        affected.add(prev.taskId);
      }
    }
  }

  const allReasoningIds = new Set([
    ...Object.keys(before.reasoning ?? {}),
    ...Object.keys(after.reasoning ?? {}),
  ]);
  for (const id of allReasoningIds) {
    const prev = before.reasoning?.[id];
    const next = after.reasoning?.[id];
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
  private corruptInfo: StoreCorruptInfo | undefined;

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
    // A pre-existing corrupt store must not brick activation: recover into an empty
    // in-memory envelope with the corruption signal set instead of throwing. The
    // on-disk file is quarantined once and left untouched (commits refuse to write
    // until it is readable), so the host can surface read-only recovery.
    const { file, corruptInfo } = readFreshFileRecoverable(opts.filePath, schemaVersion);
    const store = new TaskStore(opts.filePath, schemaVersion, file, opts);
    store.corruptInfo = corruptInfo;
    return store;
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

  /**
   * True when the most recent read observed an unparseable store. The on-disk
   * data is preserved (never auto-reset); commits are refused with a
   * `store_corrupt` result until the underlying file becomes readable again.
   */
  isCorrupt(): boolean {
    return this.corruptInfo !== undefined;
  }

  /** Recovery details for a corrupt store, or undefined when healthy. */
  getRecoveryInfo(): StoreCorruptInfo | undefined {
    return this.corruptInfo;
  }

  getFile(): Readonly<TaskStoreFile> {
    return this.file;
  }

  reload(): void {
    const { file, corruptInfo } = readFreshFileRecoverable(this.filePath, this.schemaVersion);
    if (corruptInfo) {
      // An external write left the file unparseable: keep the last-known-good
      // in-memory state, surface the recoverable signal, and let commits refuse
      // writes until the file is readable again. Never throw (would crash the
      // file-watcher callback) and never overwrite the user's data.
      this.corruptInfo = corruptInfo;
      return;
    }
    this.file = file;
    this.corruptInfo = undefined;
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

  /**
   * Run `fn` while holding the exclusive cross-process store lock, then release it.
   * Returns `fn()`'s result, or `undefined` if the lock could not be acquired within the
   * wait budget. Use this to SERIALIZE cross-process operations that touch sibling files
   * (e.g. per-turn lease acquisition) so they cannot interleave across VS Code windows —
   * closing read-then-mutate TOCTOU races that plain fs primitives cannot.
   *
   * `fn` MUST be short and MUST NOT call `commit()` or `runExclusive()` again: the lock is
   * NOT re-entrant and doing so would deadlock.
   */
  runExclusive<T>(fn: () => T): T | undefined {
    const lock = this.acquireLock();
    if (!lock) {
      return undefined;
    }
    try {
      return fn();
    } finally {
      this.releaseLock(lock);
    }
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
          const backupPath = preserveCorruptFile(this.filePath);
          this.corruptInfo = {
            backupPath,
            detail: err.message,
            observedAt: new Date().toISOString(),
          };
          result = {
            ok: false,
            reason: 'store_corrupt',
            detail: `corrupt store preserved: ${err.message}`,
            backupPath,
          };
          loadFailed = true;
          draft = emptyEnvelope(this.schemaVersion);
        }
      }

      if (!loadFailed) {
        // A successful read means the store is readable again — clear any prior
        // corruption signal so isCorrupt()/getRecoveryInfo() reflect the recovery.
        this.corruptInfo = undefined;
        const before = cloneFile(draft);
        const applyResult = apply(draft);
        if (!applyResult.ok) {
          result = { ok: false, reason: 'rejected', detail: applyResult.reason };
        } else {
          // Fail-closed handoff normalization before durable write (same rules as load).
          sanitizeTaskHandoffs(draft);
          draft.revision += 1;
          draft.schemaVersion = this.schemaVersion;

          const tempPath = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
          let writeFailed = false;
          try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            // Write the temp file through an fd and fsync it before the rename so the bytes
            // are on stable storage first. rename() gives readers atomic visibility but NOT
            // crash/power-loss durability; the fsync closes that gap.
            const fd = fs.openSync(tempPath, 'w');
            try {
              // writeFileSync(fd, ...) writes the ENTIRE buffer (looping internally) or
              // throws — unlike writeSync(fd, string), whose short-write return value we
              // would otherwise have to check. A partial write here (e.g. disk full) must
              // never be fsync'd + renamed as a "successful" commit: that would replace the
              // store with truncated JSON. writeFileSync closes that gap.
              fs.writeFileSync(fd, JSON.stringify(draft, null, 2), 'utf8');
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            fs.renameSync(tempPath, this.filePath);
            // Best-effort: fsync the parent directory so the rename entry itself survives
            // power loss on POSIX. Windows and some filesystems don't support directory
            // fsync, so any failure here is swallowed and must not fail the commit.
            try {
              const dirFd = fs.openSync(path.dirname(this.filePath), 'r');
              try {
                fs.fsyncSync(dirFd);
              } finally {
                fs.closeSync(dirFd);
              }
            } catch {
              // directory fsync unsupported on this platform/FS — ignore
            }
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