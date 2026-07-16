import type { TaskStore } from './store';
import type {
  MusterTask,
  PersistedReasoning,
  PersistedToolCall,
  TaskMessage,
  TaskStoreFile,
  TaskTurn,
  TurnStatus,
} from './types';
import type { DbClient } from './sqlite/client';

/** Small page contract shared by the transitional adapters. Cursor encoding is
 * intentionally deferred to Phase 4, where transcript sort keys are finalized. */
export interface RepositoryPageRequest {
  limit?: number;
}

/** Cursor page returned by repository consumers. */
export interface RepositoryPage<T> {
  items: readonly T[];
  nextCursor?: string;
}

export type RepositoryTranscriptItem =
  | { id: string; kind: 'user' | 'assistant'; content: string; turnId?: string; order?: number; state?: TaskMessage['state']; createdAt?: string }
  | { id: string; kind: 'tool'; turnId: string; order: number; content: Record<string, unknown>; createdAt?: string }
  | { id: string; kind: 'reasoning'; turnId: string; content: string; createdAt?: string };

export interface TranscriptPage {
  items: readonly RepositoryTranscriptItem[];
  beforeCursor?: string;
  hasMoreBefore: boolean;
  workspaceRevision: number;
}

export type RepositoryCommand =
  | { kind: 'createTask'; workspaceId: string; task: MusterTask }
  | { kind: 'createTurn'; workspaceId: string; turn: TaskTurn }
  | { kind: 'appendMessage'; workspaceId: string; message: TaskMessage }
  | { kind: 'promoteTurn'; workspaceId: string; turnId: string; startedAt: string }
  | {
      kind: 'settleTurn'; workspaceId: string; turnId: string;
      status: Extract<TurnStatus, 'succeeded' | 'failed' | 'interrupted' | 'cancelled'>;
      finishedAt: string; error?: string;
    };

export interface RepositoryCommandResult {
  ok: true;
  changed?: boolean;
}

/**
 * Read-side boundary for task data.
 *
 * Phase 2 deliberately starts with queries only. Mutation commands are added as
 * named transactional operations once the JSON and SQLite implementations share
 * the same contract; callers must not receive a mutable store envelope.
 */
export interface TaskRepository {
  getTask(taskId: string): Promise<MusterTask | undefined>;
  listTasks(workspaceId: string): Promise<readonly MusterTask[]>;
  listRootTasks(workspaceId: string, page?: RepositoryPageRequest): Promise<RepositoryPage<MusterTask>>;
  listSubtree(rootTaskId: string): Promise<readonly MusterTask[]>;
  listTurns(taskId: string): Promise<readonly TaskTurn[]>;
  listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]>;
  listMessages(taskId: string): Promise<readonly TaskMessage[]>;
  getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage>;
  execute(command: RepositoryCommand): Promise<RepositoryCommandResult>;
  /** Compatibility-only export/migration view; never expose this to mutation code. */
  readEnvelopeForMigration(): Promise<Readonly<TaskStoreFile>>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Compatibility adapter over the current JSON TaskStore.
 *
 * Returning cloned values makes accidental mutation fail closed: changing a DTO
 * returned by a repository query cannot silently mutate TaskStore's in-memory file.
 */
export class JsonTaskRepository implements TaskRepository {
  /** JSON stores are currently one-workspace-per-file; SQLite adds explicit workspace IDs. */
  constructor(private readonly store: TaskStore, private readonly workspaceId?: string) {}

  async getTask(taskId: string): Promise<MusterTask | undefined> {
    const task = this.store.getFile().tasks[taskId];
    return task ? clone(task) : undefined;
  }

  async listTasks(workspaceId: string): Promise<readonly MusterTask[]> {
    if (this.workspaceId !== undefined && this.workspaceId !== workspaceId) return [];
    return Object.values(this.store.getFile().tasks)
      .map((task) => clone(task));
  }

  async listRootTasks(workspaceId: string, page: RepositoryPageRequest = {}): Promise<RepositoryPage<MusterTask>> {
    const tasks = (await this.listTasks(workspaceId)).filter((task) => task.parentId === null);
    return { items: tasks.slice(0, normalizeLimit(page.limit)) };
  }

  async listSubtree(rootTaskId: string): Promise<readonly MusterTask[]> {
    const all = Object.values(this.store.getFile().tasks);
    const result: MusterTask[] = [];
    const pending = [rootTaskId];
    while (pending.length > 0) {
      const id = pending.shift()!;
      const task = all.find((candidate) => candidate.id === id);
      if (!task || result.some((candidate) => candidate.id === task.id)) continue;
      result.push(clone(task));
      for (const child of all) {
        if (child.parentId === id) pending.push(child.id);
      }
    }
    return result;
  }

  async listTurns(taskId: string): Promise<readonly TaskTurn[]> {
    return Object.values(this.store.getFile().turns)
      .filter((turn) => turn.taskId === taskId)
      .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt))
      .map((turn) => clone(turn));
  }

  async listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]> {
    return (await this.listTurns(taskId)).filter((turn) => turn.status === 'queued');
  }

  async listMessages(taskId: string): Promise<readonly TaskMessage[]> {
    return Object.values(this.store.getFile().messages)
      .filter((message) => message.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((message) => clone(message));
  }

  async getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage> {
    const file = this.store.getFile();
    const items = composeTranscript(
      Object.values(file.turns).filter((turn) => turn.taskId === taskId),
      Object.values(file.messages).filter((message) => message.taskId === taskId),
      Object.values(file.toolCalls ?? {}).filter((tool) => tool.taskId === taskId),
      Object.values(file.reasoning ?? {}).filter((reasoning) => reasoning.taskId === taskId),
    );
    return pageTranscript(items, Object.values(file.turns).filter((turn) => turn.taskId === taskId), cursor, limit, file.revision);
  }

  async readEnvelopeForMigration(): Promise<Readonly<TaskStoreFile>> {
    return clone(this.store.getFile());
  }

  async execute(command: RepositoryCommand): Promise<RepositoryCommandResult> {
    if (this.workspaceId !== undefined && this.workspaceId !== command.workspaceId) {
      throw new Error('repository workspace mismatch');
    }
    let changed = false;
    const result = this.store.commit((draft) => {
      switch (command.kind) {
        case 'createTask':
          if (draft.tasks[command.task.id]) return { ok: false, reason: 'task already exists' };
          draft.tasks[command.task.id] = clone(command.task);
          changed = true;
          return { ok: true };
        case 'createTurn':
          if (draft.turns[command.turn.id]) return { ok: false, reason: 'turn already exists' };
          if (!draft.tasks[command.turn.taskId]) return { ok: false, reason: 'task not found' };
          draft.turns[command.turn.id] = clone(command.turn);
          changed = true;
          return { ok: true };
        case 'appendMessage':
          if (draft.messages[command.message.id]) return { ok: false, reason: 'message already exists' };
          if (!draft.tasks[command.message.taskId]) return { ok: false, reason: 'task not found' };
          draft.messages[command.message.id] = clone(command.message);
          changed = true;
          return { ok: true };
        case 'promoteTurn': {
          const turn = draft.turns[command.turnId];
          if (!turn || turn.status !== 'queued') return { ok: true };
          turn.status = 'running';
          turn.startedAt = command.startedAt;
          changed = true;
          return { ok: true };
        }
        case 'settleTurn': {
          const turn = draft.turns[command.turnId];
          if (!turn || (turn.status !== 'running' && turn.status !== 'waiting_user')) return { ok: true };
          turn.status = command.status;
          turn.finishedAt = command.finishedAt;
          turn.error = command.error;
          changed = true;
          return { ok: true };
        }
        default: {
          const _exhaustive: never = command;
          return _exhaustive;
        }
      }
    });
    if (!result.ok) {
      throw new Error(result.detail ?? 'repository command rejected');
    }
    return { ok: true, changed };
  }
}

/** SQLite read adapter. Writes remain intentionally unavailable until named commands land. */
export class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async getTask(taskId: string): Promise<MusterTask | undefined> {
    const row = await this.db.get<TaskRow>(
      `SELECT id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend,
              model, revision, created_at, updated_at, payload_json
         FROM tasks WHERE workspace_id = ? AND id = ?`,
      [this.workspaceId, taskId],
    );
    return row ? decodeTask(row) : undefined;
  }

  async listTasks(workspaceId: string): Promise<readonly MusterTask[]> {
    if (workspaceId !== this.workspaceId) return [];
    const rows = await this.db.all<TaskRow>(
      `SELECT id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend,
              model, revision, created_at, updated_at, payload_json
         FROM tasks WHERE workspace_id = ? ORDER BY created_at, id`,
      [workspaceId],
    );
    return rows.map(decodeTask);
  }

  async listRootTasks(workspaceId: string, page: RepositoryPageRequest = {}): Promise<RepositoryPage<MusterTask>> {
    if (workspaceId !== this.workspaceId) return { items: [] };
    const rows = await this.db.all<TaskRow>(
      `SELECT id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend,
              model, revision, created_at, updated_at, payload_json
         FROM tasks
        WHERE workspace_id = ? AND parent_id IS NULL
        ORDER BY created_at, id LIMIT ?`,
      [workspaceId, normalizeLimit(page.limit)],
    );
    return { items: rows.map(decodeTask) };
  }

  async listSubtree(rootTaskId: string): Promise<readonly MusterTask[]> {
    const rows = await this.db.all<TaskRow>(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE workspace_id = ? AND id = ?
         UNION
         SELECT child.id FROM tasks child
         JOIN subtree parent ON child.parent_id = parent.id
         WHERE child.workspace_id = ?
       )
       SELECT t.id, t.workspace_id, t.parent_id, t.role, t.lifecycle, t.release_state,
              t.goal, t.backend, t.model, t.revision, t.created_at, t.updated_at, t.payload_json
         FROM tasks t JOIN subtree s ON s.id = t.id
        WHERE t.workspace_id = ?
        ORDER BY t.created_at, t.id`,
      [this.workspaceId, rootTaskId, this.workspaceId, this.workspaceId],
    );
    return rows.map(decodeTask);
  }

  async listTurns(taskId: string): Promise<readonly TaskTurn[]> {
    const rows = await this.db.all<TurnRow>(
      `SELECT id, workspace_id, task_id, sequence, status, trigger, created_at,
              started_at, settled_at, payload_json
         FROM turns WHERE workspace_id = ? AND task_id = ? ORDER BY sequence, created_at, id`,
      [this.workspaceId, taskId],
    );
    return rows.map(decodeTurn);
  }

  async listQueuedTurns(taskId: string): Promise<readonly TaskTurn[]> {
    const rows = await this.db.all<TurnRow>(
      `SELECT id, workspace_id, task_id, sequence, status, trigger, created_at,
              started_at, settled_at, payload_json
         FROM turns
        WHERE workspace_id = ? AND task_id = ? AND status = 'queued'
        ORDER BY sequence, created_at, id`,
      [this.workspaceId, taskId],
    );
    return rows.map(decodeTurn);
  }

  async listMessages(taskId: string): Promise<readonly TaskMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT id, workspace_id, task_id, turn_id, role, state, ordering, content,
              created_at, updated_at, payload_json
         FROM messages WHERE workspace_id = ? AND task_id = ? ORDER BY created_at, id`,
      [this.workspaceId, taskId],
    );
    return rows.map(decodeMessage);
  }

  async getTranscriptPage(taskId: string, cursor?: string, limit?: number): Promise<TranscriptPage> {
    const [turns, messages, tools, reasoning, revisionRow] = await Promise.all([
      this.listTurns(taskId),
      this.listMessages(taskId),
      this.db.all<PayloadRow>(
        'SELECT payload_json FROM tool_calls WHERE workspace_id = ? AND task_id = ?',
        [this.workspaceId, taskId],
      ),
      this.db.all<ReasoningRow>(
        'SELECT id, task_id, turn_id, content, created_at, updated_at FROM reasoning_segments WHERE workspace_id = ? AND task_id = ?',
        [this.workspaceId, taskId],
      ),
      this.db.get<{ revision: number }>(
        'SELECT revision FROM workspace_revisions WHERE workspace_id = ?',
        [this.workspaceId],
      ),
    ]);
    const parsedTools = tools.map((row) => parsePayload(row.payload_json, 'tool call') as unknown as PersistedToolCall);
    const parsedReasoning = reasoning.map((row) => ({
      id: row.id, taskId: row.task_id, turnId: row.turn_id, content: row.content,
      createdAt: row.created_at, updatedAt: row.updated_at,
    } satisfies PersistedReasoning));
    return pageTranscript(composeTranscript(turns, messages, parsedTools, parsedReasoning), turns, cursor, limit, revisionRow?.revision ?? 0);
  }

  async readEnvelopeForMigration(): Promise<Readonly<TaskStoreFile>> {
    throw new Error('SQLite repository cannot export a JSON envelope before the export codec is implemented');
  }

  async execute(command: RepositoryCommand): Promise<RepositoryCommandResult> {
    if (command.workspaceId !== this.workspaceId) {
      throw new Error('repository workspace mismatch');
    }
    switch (command.kind) {
      case 'createTask': {
        const task = command.task;
        await this.db.run(
          `INSERT INTO tasks
            (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
             revision, created_at, updated_at, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [task.id, this.workspaceId, task.parentId, task.role, task.lifecycle, task.releaseState ?? null,
            task.goal, task.backend, task.model ?? null, task.revision, task.createdAt, task.updatedAt,
            JSON.stringify(task)],
        );
        return { ok: true };
      }
      case 'createTurn': {
        const turn = command.turn;
        await this.db.run(
          `INSERT INTO turns
            (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [turn.id, this.workspaceId, turn.taskId, turn.sequence, turn.status, turn.trigger, turn.createdAt,
            turn.startedAt ?? null, turn.finishedAt ?? null, JSON.stringify(turn)],
        );
        return { ok: true };
      }
      case 'appendMessage': {
        const message = command.message;
        await this.db.run(
          `INSERT INTO messages
            (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [message.id, this.workspaceId, message.taskId, message.turnId ?? null, message.role, message.state,
            message.order ?? null, message.content, message.createdAt, null, JSON.stringify(message)],
        );
        return { ok: true };
      }
      case 'promoteTurn': {
        const result = await this.db.run(
          `UPDATE turns
              SET status = 'running', started_at = ?,
                  payload_json = json_set(payload_json, '$.status', 'running', '$.startedAt', ?)
            WHERE workspace_id = ? AND id = ? AND status = 'queued'`,
          [command.startedAt, command.startedAt, this.workspaceId, command.turnId],
        );
        return { ok: true, changed: result.changes > 0 };
      }
      case 'settleTurn': {
        const payloadExpression = command.error === undefined
          ? `json_remove(json_set(payload_json, '$.status', ?, '$.finishedAt', ?), '$.error')`
          : `json_set(payload_json, '$.status', ?, '$.finishedAt', ?, '$.error', ?)`;
        const params = command.error === undefined
          ? [command.status, command.finishedAt, command.status, command.finishedAt, this.workspaceId, command.turnId]
          : [command.status, command.finishedAt, command.status, command.finishedAt, command.error, this.workspaceId, command.turnId];
        const result = await this.db.run(
          `UPDATE turns SET status = ?, settled_at = ?, payload_json = ${payloadExpression}
            WHERE workspace_id = ? AND id = ? AND status IN ('running', 'waiting_user')`,
          params,
        );
        return { ok: true, changed: result.changes > 0 };
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }
}

interface TaskRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  role: string;
  lifecycle: string;
  release_state: string | null;
  goal: string;
  backend: string;
  model: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  payload_json: string;
}

interface TurnRow {
  id: string;
  workspace_id: string;
  task_id: string;
  sequence: number;
  status: string;
  trigger: string;
  created_at: string;
  started_at: string | null;
  settled_at: string | null;
  payload_json: string;
}

interface MessageRow {
  id: string;
  workspace_id: string;
  task_id: string;
  turn_id: string | null;
  role: string;
  state: string;
  ordering: number | null;
  content: string;
  created_at: string;
  updated_at: string | null;
  payload_json: string;
}

interface PayloadRow {
  payload_json: string;
}

interface ReasoningRow {
  id: string;
  task_id: string;
  turn_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface TranscriptEntry {
  item: RepositoryTranscriptItem;
  seq: number;
  order: number;
  createdAt: string;
  id: string;
}

function composeTranscript(
  turns: readonly TaskTurn[],
  messages: readonly TaskMessage[],
  toolCalls: readonly PersistedToolCall[],
  reasoning: readonly PersistedReasoning[],
): RepositoryTranscriptItem[] {
  const orderedTurns = [...turns].sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const seqOf = new Map(orderedTurns.map((turn) => [turn.id, turn.sequence]));
  const msgTurn = new Map<string, string>();
  for (const turn of orderedTurns) {
    for (const input of turn.inputs) {
      if (input.kind === 'message') msgTurn.set(input.messageId, turn.id);
    }
  }
  const entries: TranscriptEntry[] = [];
  const openingQueued = orderedTurns.length === 1 && orderedTurns[0]?.status === 'queued' && orderedTurns[0].trigger === 'user';
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const turnId = message.role === 'assistant' ? message.turnId : (message.turnId ?? msgTurn.get(message.id));
    const boundTurn = turnId ? orderedTurns.find((turn) => turn.id === turnId) : undefined;
    if (message.role === 'user' && boundTurn?.status === 'queued' && !openingQueued) continue;
    entries.push({
      item: { id: message.id, kind: message.role, content: message.content, turnId, order: message.order, state: message.state, createdAt: message.createdAt },
      seq: turnId && seqOf.has(turnId) ? seqOf.get(turnId)! : -1,
      order: message.role === 'assistant' ? (message.order ?? 0) : (message.order ?? -2),
      createdAt: message.createdAt,
      id: message.id,
    });
  }
  for (const tool of toolCalls) {
    if (!seqOf.has(tool.turnId)) continue;
    entries.push({
      item: {
        id: tool.id, kind: 'tool', turnId: tool.turnId, order: tool.order,
        content: { toolCallId: tool.toolCallId, name: tool.name, toolKind: tool.kind, status: tool.status,
          input: tool.input, output: tool.output, error: tool.error }, createdAt: tool.createdAt,
      },
      seq: seqOf.get(tool.turnId)!, order: tool.order, createdAt: tool.createdAt, id: tool.id,
    });
  }
  for (const item of reasoning) {
    if (!seqOf.has(item.turnId)) continue;
    entries.push({ item: { id: item.id, kind: 'reasoning', turnId: item.turnId, content: item.content, createdAt: item.createdAt },
      seq: seqOf.get(item.turnId)!, order: -1, createdAt: item.createdAt, id: item.id });
  }
  entries.sort((a, b) => a.seq - b.seq || a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return entries.map((entry) => entry.item);
}

function transcriptKey(item: RepositoryTranscriptItem, turns: readonly TaskTurn[]): string {
  const turnId = 'turnId' in item ? item.turnId : undefined;
  const seq = turnId ? turns.find((turn) => turn.id === turnId)?.sequence ?? -1 : -1;
  const order = 'order' in item ? item.order : -1;
  return `${seq}\u0000${order}\u0000${item.createdAt ?? ''}\u0000${item.id}`;
}

function encodeTranscriptCursor(item: RepositoryTranscriptItem, turns: readonly TaskTurn[]): string {
  return `v1.${Buffer.from(transcriptKey(item, turns), 'utf8').toString('base64url')}`;
}

function decodeTranscriptCursor(cursor: string): string {
  try {
    if (!cursor.startsWith('v1.')) throw new Error('invalid version');
    const decoded = Buffer.from(cursor.slice(3), 'base64url').toString('utf8');
    if (!decoded.includes('\u0000')) throw new Error('invalid');
    return decoded;
  } catch {
    throw new Error('invalid transcript cursor');
  }
}

function pageTranscript(items: readonly RepositoryTranscriptItem[], turns: readonly TaskTurn[], cursor: string | undefined, limit: number | undefined, revision: number): TranscriptPage {
  const bounded = normalizeLimit(limit);
  // Items are already in canonical order. Cursor points at the newest item on
  // the previous page; older pages therefore select strictly smaller keys.
  const cursorKey = cursor ? decodeTranscriptCursor(cursor) : undefined;
  const cursorId = cursorKey?.split('\u0000').pop();
  const start = cursorId
    ? items.findIndex((item) => item.id === cursorId)
    : items.length;
  if (cursorId && start < 0) {
    throw new Error('transcript cursor is no longer valid');
  }
  const end = cursorKey ? start : items.length;
  const from = Math.max(0, end - bounded);
  const page = items.slice(from, end);
  const hasMoreBefore = from > 0;
  return {
    items: page,
    ...(hasMoreBefore && page[0] ? { beforeCursor: encodeTranscriptCursor(page[0], turns) } : {}),
    hasMoreBefore,
    workspaceRevision: revision,
  };
}

function parsePayload(raw: string, kind: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${kind} payload in SQLite store`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid ${kind} payload in SQLite store: expected object`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(500, Math.floor(limit)));
}

function requiredString(value: unknown, field: string, kind: string): string {
  if (typeof value !== 'string') {
    throw new Error(`invalid ${kind} row in SQLite store: ${field} must be a string`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string, kind: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid ${kind} row in SQLite store: ${field} must be a number`);
  }
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string, kind: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${kind} row in SQLite store: ${field} has unsupported value`);
  }
  return value as T;
}

/**
 * Hydrate promoted columns over the compatibility payload. This is intentional:
 * query/state columns are the SQLite source of truth, while payload_json carries
 * the low-query fields. It also lets Phase 2 read rows produced by the legacy
 * JSON importer before the Phase 3 payload codec removes duplicated fields.
 */
function decodeTask(row: TaskRow): MusterTask {
  const payload = parsePayload(row.payload_json, 'task');
  const task: Record<string, unknown> = {
    ...payload,
    id: requiredString(row.id, 'id', 'task'),
    parentId: row.parent_id,
    role: oneOf(row.role, ['coordinator', 'worker'] as const, 'role', 'task'),
    lifecycle: oneOf(row.lifecycle, ['open', 'succeeded', 'failed', 'cancelled', 'skipped'] as const, 'lifecycle', 'task'),
    goal: requiredString(row.goal, 'goal', 'task'),
    backend: requiredString(row.backend, 'backend', 'task'),
    revision: requiredNumber(row.revision, 'revision', 'task'),
    createdAt: requiredString(row.created_at, 'created_at', 'task'),
    updatedAt: requiredString(row.updated_at, 'updated_at', 'task'),
    ...(row.model === null ? { model: undefined } : { model: row.model }),
    ...(row.release_state === null ? { releaseState: undefined } : { releaseState: row.release_state }),
  };
  if (!Array.isArray(task.dependencies) || !Array.isArray(task.capabilities) || !task.executionPolicy) {
    throw new Error('invalid task row in SQLite store: missing domain payload fields');
  }
  return task as unknown as MusterTask;
}

function decodeTurn(row: TurnRow): TaskTurn {
  const payload = parsePayload(row.payload_json, 'turn');
  const turn: Record<string, unknown> = {
    ...payload,
    id: requiredString(row.id, 'id', 'turn'),
    taskId: requiredString(row.task_id, 'task_id', 'turn'),
    sequence: requiredNumber(row.sequence, 'sequence', 'turn'),
    status: oneOf(row.status, ['queued', 'running', 'waiting_user', 'succeeded', 'failed', 'interrupted', 'cancelled'] as const, 'status', 'turn'),
    trigger: oneOf(row.trigger, ['user', 'engine', 'retry'] as const, 'trigger', 'turn'),
    createdAt: requiredString(row.created_at, 'created_at', 'turn'),
    ...(row.started_at === null ? { startedAt: undefined } : { startedAt: row.started_at }),
    ...(row.settled_at === null ? { finishedAt: undefined } : { finishedAt: row.settled_at }),
  };
  if (!Array.isArray(turn.inputs)) {
    throw new Error('invalid turn row in SQLite store: inputs must be an array');
  }
  return turn as unknown as TaskTurn;
}

function decodeMessage(row: MessageRow): TaskMessage {
  const payload = parsePayload(row.payload_json, 'message');
  const message: Record<string, unknown> = {
    ...payload,
    id: requiredString(row.id, 'id', 'message'),
    taskId: requiredString(row.task_id, 'task_id', 'message'),
    role: oneOf(row.role, ['user', 'assistant', 'system'] as const, 'role', 'message'),
    state: oneOf(row.state, ['pending', 'assigned', 'complete', 'partial'] as const, 'state', 'message'),
    content: requiredString(row.content, 'content', 'message'),
    createdAt: requiredString(row.created_at, 'created_at', 'message'),
    ...(row.turn_id === null ? { turnId: undefined } : { turnId: row.turn_id }),
    ...(row.ordering === null ? { order: undefined } : { order: row.ordering }),
    ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
  };
  return message as unknown as TaskMessage;
}
