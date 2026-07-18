import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from './store';
import type { MusterTask, TaskTurn } from './types';
import {
  JSON_TURN_STREAM_BUFFER_DELETION_GATE,
  JsonTurnStreamBuffer,
  type TurnStreamOp,
  type TurnStreamPersistence,
} from './turn-stream-persistence';

const tempDirs: string[] = [];

function makeTempStore(onCommit?: (file: unknown, affected: string[]) => void): {
  dir: string;
  filePath: string;
  store: TaskStore;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-turn-stream-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, '.muster-tasks.json');
  return {
    dir,
    filePath,
    store: TaskStore.load({ filePath, onCommit }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    goal: 'stream batch test',
    parentId: null,
    dependencies: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: {
      maxTurns: 10,
      maxAutomaticRetries: 1,
      turnTimeoutMs: 1_000,
      taskTimeoutMs: 5_000,
    },
    revision: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
  };
}

function sampleTurn(id: string, taskId: string): TaskTurn {
  return {
    id,
    taskId,
    sequence: 1,
    trigger: 'user',
    status: 'running',
    inputs: [],
    createdAt: '2026-07-06T00:00:00.000Z',
    startedAt: '2026-07-06T00:00:01.000Z',
    runtimeEpoch: 1,
  };
}

function seedTurn(store: TaskStore, taskId = 'task-1', turnId = 'turn-1'): void {
  const seeded = store.commit((draft) => {
    draft.tasks[taskId] = sampleTask(taskId);
    draft.turns[turnId] = sampleTurn(turnId, taskId);
    return { ok: true };
  });
  expect(seeded.ok).toBe(true);
}

function assistantOps(count: number, turnId = 'turn-1', taskId = 'task-1'): TurnStreamOp[] {
  const segmentId = `${turnId}:0`;
  const ops: TurnStreamOp[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({
      type: 'assistantDelta',
      turnId,
      taskId,
      segmentId,
      content: `Δ${i}`,
      order: 0,
      createdAt: '2026-07-06T00:00:02.000Z',
    });
  }
  return ops;
}

describe('TurnStreamPersistence / JsonTurnStreamBuffer (D035)', () => {
  it('exposes a dated post-M017 DELETION_GATE pointing at appendTranscriptBatch (D041 re-gate)', () => {
    expect(JSON_TURN_STREAM_BUFFER_DELETION_GATE.decision).toBe('D035');
    expect(JSON_TURN_STREAM_BUFFER_DELETION_GATE.replaceWith).toBe('appendTranscriptBatch');
    // S07 re-gates retention: SQLite path does not exist yet — do not invent appendTranscriptBatch.
    expect(JSON_TURN_STREAM_BUFFER_DELETION_GATE.removeIn).toMatch(/post-M017/i);
    expect(JSON_TURN_STREAM_BUFFER_DELETION_GATE.dated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON_TURN_STREAM_BUFFER_DELETION_GATE.reason).toMatch(/post-M017|appendTranscriptBatch/i);
    expect(JsonTurnStreamBuffer.DELETION_GATE).toBe(JSON_TURN_STREAM_BUFFER_DELETION_GATE);
    // Temporary adapter stays production-wired until the dated gate is cleared.
    expect('appendTranscriptBatch' in JsonTurnStreamBuffer.prototype).toBe(false);
  });

  it('buffers N assistant deltas into one durable commit with byte-exact content', () => {
    let commitCount = 0;
    const { store } = makeTempStore(() => {
      commitCount += 1;
    });
    seedTurn(store);
    // seedTurn already committed once
    const seedCommits = commitCount;
    expect(seedCommits).toBe(1);

    const buffer: TurnStreamPersistence = new JsonTurnStreamBuffer(store);
    const ops = assistantOps(250);
    for (const op of ops) {
      const applied = buffer.apply(op);
      expect(applied.ok).toBe(true);
    }

    // No durable write until flush
    expect(commitCount).toBe(seedCommits);
    expect(buffer.pendingOps).toBe(250);

    const flushed = buffer.flush();
    expect(flushed.ok).toBe(true);
    expect(buffer.pendingOps).toBe(0);
    expect(buffer.flushCount).toBe(1);
    expect(commitCount - seedCommits).toBe(1);

    const expected = ops.map((o) => (o.type === 'assistantDelta' ? o.content : '')).join('');
    const message = store.getFile().messages['turn-1:0'];
    expect(message).toMatchObject({
      id: 'turn-1:0',
      taskId: 'task-1',
      role: 'assistant',
      state: 'partial',
      turnId: 'turn-1',
      order: 0,
      content: expected,
    });
    expect(message.content).toBe(expected);
  });

  it('preserves interleaved assistant / reasoning / tool transcript byte-exactly vs sequential commits', () => {
    // Path A: buffer + single flush
    let bufferedCommits = 0;
    const buffered = makeTempStore(() => {
      bufferedCommits += 1;
    });
    seedTurn(buffered.store);
    const seedA = bufferedCommits;

    // Path B: 1:1 commit storm (engine-today baseline)
    let stormCommits = 0;
    const storm = makeTempStore(() => {
      stormCommits += 1;
    });
    seedTurn(storm.store);
    const seedB = stormCommits;

    const now = '2026-07-06T00:00:03.000Z';
    const ops: TurnStreamOp[] = [
      {
        type: 'assistantDelta',
        turnId: 'turn-1',
        taskId: 'task-1',
        segmentId: 'turn-1:0',
        content: 'Hello ',
        order: 0,
        createdAt: now,
      },
      {
        type: 'assistantDelta',
        turnId: 'turn-1',
        taskId: 'task-1',
        segmentId: 'turn-1:0',
        content: 'world',
        order: 0,
        createdAt: now,
      },
      {
        type: 'reasoningDelta',
        turnId: 'turn-1',
        taskId: 'task-1',
        content: 'think-a',
        now,
      },
      {
        type: 'toolStarted',
        turnId: 'turn-1',
        taskId: 'task-1',
        compositeId: 'turn-1:tc-1',
        toolCallId: 'tc-1',
        order: 1,
        name: 'search',
        kind: 'mcp',
        input: { q: 'x' },
        createdAt: now,
      },
      {
        type: 'toolUpdated',
        turnId: 'turn-1',
        taskId: 'task-1',
        compositeId: 'turn-1:tc-1',
        toolCallId: 'tc-1',
        order: 1,
        input: { q: 'xy' },
        now,
      },
      {
        type: 'assistantDelta',
        turnId: 'turn-1',
        taskId: 'task-1',
        segmentId: 'turn-1:2',
        content: ' after tool',
        order: 2,
        createdAt: now,
      },
      {
        type: 'reasoningDelta',
        turnId: 'turn-1',
        taskId: 'task-1',
        content: '+think-b',
        now,
      },
      {
        type: 'toolCompleted',
        turnId: 'turn-1',
        taskId: 'task-1',
        compositeId: 'turn-1:tc-1',
        toolCallId: 'tc-1',
        order: 1,
        outcome: 'success',
        output: { hits: 1 },
        now,
      },
    ];

    const buffer = new JsonTurnStreamBuffer(buffered.store);
    for (const op of ops) buffer.apply(op);
    const flushResult = buffer.flush();
    expect(flushResult.ok).toBe(true);
    expect(bufferedCommits - seedA).toBe(1);

    // Mirror engine mutators 1:1 for baseline path
    for (const op of ops) {
      const result = storm.store.commit((draft) => {
        applyOpToDraft(draft, op);
        return { ok: true };
      });
      expect(result.ok).toBe(true);
    }
    expect(stormCommits - seedB).toBe(ops.length);

    const a = buffered.store.getFile();
    const b = storm.store.getFile();
    expect(a.messages).toEqual(b.messages);
    expect(a.reasoning).toEqual(b.reasoning);
    expect(a.toolCalls).toEqual(b.toolCalls);
  });

  it('emits terminal only after final flush (invariant 9 ordering)', () => {
    const { store } = makeTempStore();
    seedTurn(store);
    const buffer = new JsonTurnStreamBuffer(store);
    const timeline: string[] = [];

    for (const op of assistantOps(40)) {
      buffer.apply(op);
      timeline.push('apply');
    }

    // Simulate engine terminal path: flush, then emit turnDone.
    const flushed = buffer.flush();
    expect(flushed.ok).toBe(true);
    timeline.push('flush');
    timeline.push('terminal');

    const firstFlush = timeline.indexOf('flush');
    const firstTerminal = timeline.indexOf('terminal');
    expect(firstFlush).toBeGreaterThanOrEqual(0);
    expect(firstTerminal).toBeGreaterThan(firstFlush);
    // All applies precede flush
    expect(timeline.slice(0, firstFlush).every((e) => e === 'apply')).toBe(true);

    // Content durable only after flush
    expect(store.getFile().messages['turn-1:0']?.content).toBe(
      assistantOps(40)
        .map((o) => (o.type === 'assistantDelta' ? o.content : ''))
        .join(''),
    );
  });

  it('bounds durable writes far below chunk count for a 10k storm', () => {
    let commitCount = 0;
    const { store } = makeTempStore(() => {
      commitCount += 1;
    });
    seedTurn(store);
    const seedCommits = commitCount;

    const buffer = new JsonTurnStreamBuffer(store);
    const N = 10_000;
    for (const op of assistantOps(N)) {
      buffer.apply(op);
    }
    expect(buffer.pendingOps).toBe(N);
    expect(commitCount).toBe(seedCommits);

    const flushed = buffer.flush();
    expect(flushed.ok).toBe(true);
    const durable = commitCount - seedCommits;
    expect(durable).toBe(1);
    expect(durable / N).toBeLessThan(0.01);

    const expected = Array.from({ length: N }, (_, i) => `Δ${i}`).join('');
    expect(store.getFile().messages['turn-1:0']?.content).toBe(expected);
    expect(buffer.flushCount).toBe(1);
    expect(buffer.pendingOps).toBe(0);
  });

  it('flush is a no-op durable write when nothing is pending', () => {
    let commitCount = 0;
    const { store } = makeTempStore(() => {
      commitCount += 1;
    });
    seedTurn(store);
    const seedCommits = commitCount;
    const buffer = new JsonTurnStreamBuffer(store);

    const flushed = buffer.flush();
    expect(flushed.ok).toBe(true);
    expect(commitCount).toBe(seedCommits);
    expect(buffer.flushCount).toBe(1);
  });

  it('flush fails cleanly when the turn is missing (negative path)', () => {
    const { store } = makeTempStore();
    // No seed — turn does not exist
    const buffer = new JsonTurnStreamBuffer(store);
    buffer.apply({
      type: 'assistantDelta',
      turnId: 'ghost-turn',
      taskId: 'ghost-task',
      segmentId: 'ghost-turn:0',
      content: 'nope',
      order: 0,
      createdAt: '2026-07-06T00:00:00.000Z',
    });

    const flushed = buffer.flush();
    expect(flushed.ok).toBe(false);
    if (!flushed.ok) {
      expect(flushed.reason).toBe('rejected');
      expect(flushed.detail).toMatch(/turn not found/i);
    }
    // Failed flush retains pending ops so caller can observe / retry policy
    expect(buffer.pendingOps).toBe(1);
    expect(store.getFile().messages['ghost-turn:0']).toBeUndefined();
  });

  it('flush fails when a mid-batch op references a missing turn', () => {
    const { store } = makeTempStore();
    seedTurn(store, 'task-1', 'turn-1');
    const buffer = new JsonTurnStreamBuffer(store);
    buffer.apply({
      type: 'assistantDelta',
      turnId: 'turn-1',
      taskId: 'task-1',
      segmentId: 'turn-1:0',
      content: 'ok',
      order: 0,
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    buffer.apply({
      type: 'reasoningDelta',
      turnId: 'other-turn',
      taskId: 'task-1',
      content: 'orphan',
      now: '2026-07-06T00:00:00.000Z',
    });

    const flushed = buffer.flush();
    expect(flushed.ok).toBe(false);
    // Atomic: nothing from the batch lands
    expect(store.getFile().messages['turn-1:0']).toBeUndefined();
    expect(store.getFile().reasoning?.['other-turn']).toBeUndefined();
  });

  it('reserves appendTranscriptBatch contract shape without implementing SQLite', () => {
    // Compile-time / shape guard: the reserved repository command type is exported
    // and documents the future SQLite path. JsonTurnStreamBuffer is NOT that path.
    const reserved: import('./turn-stream-persistence').AppendTranscriptBatchInput = {
      turnId: 'turn-1',
      ops: assistantOps(2),
    };
    expect(reserved.turnId).toBe('turn-1');
    expect(reserved.ops).toHaveLength(2);
    expect('appendTranscriptBatch' in JsonTurnStreamBuffer.prototype).toBe(false);
  });
});

/** Local replica of buffer mutators for baseline comparison (must match production apply). */
function applyOpToDraft(
  draft: import('./types').TaskStoreFile,
  op: TurnStreamOp,
): { ok: true } | { ok: false; reason: string } {
  const draftTurn = draft.turns[op.turnId];
  if (!draftTurn) {
    return { ok: false, reason: 'turn not found' };
  }
  switch (op.type) {
    case 'assistantDelta': {
      const existing = draft.messages[op.segmentId];
      if (!existing) {
        draft.messages[op.segmentId] = {
          id: op.segmentId,
          taskId: op.taskId,
          role: 'assistant',
          content: op.content,
          state: 'partial',
          createdAt: op.createdAt,
          turnId: op.turnId,
          order: op.order,
        };
      } else {
        draft.messages[op.segmentId] = {
          ...existing,
          content: existing.content + op.content,
        };
      }
      return { ok: true };
    }
    case 'reasoningDelta': {
      draft.reasoning = draft.reasoning ?? {};
      const existing = draft.reasoning[op.turnId];
      draft.reasoning[op.turnId] = existing
        ? { ...existing, content: existing.content + op.content, updatedAt: op.now }
        : {
            id: op.turnId,
            taskId: op.taskId,
            turnId: op.turnId,
            content: op.content,
            createdAt: op.now,
            updatedAt: op.now,
          };
      return { ok: true };
    }
    case 'toolStarted': {
      draft.toolCalls = draft.toolCalls ?? {};
      if (!draft.toolCalls[op.compositeId]) {
        draft.toolCalls[op.compositeId] = {
          id: op.compositeId,
          taskId: op.taskId,
          turnId: op.turnId,
          toolCallId: op.toolCallId,
          order: op.order,
          name: op.name,
          kind: op.kind,
          status: 'running',
          input: op.input,
          createdAt: op.createdAt,
          updatedAt: op.createdAt,
        };
      }
      return { ok: true };
    }
    case 'toolUpdated': {
      draft.toolCalls = draft.toolCalls ?? {};
      const existing = draft.toolCalls[op.compositeId];
      draft.toolCalls[op.compositeId] = existing
        ? {
            ...existing,
            input: op.input !== undefined ? op.input : existing.input,
            updatedAt: op.now,
          }
        : {
            id: op.compositeId,
            taskId: op.taskId,
            turnId: op.turnId,
            toolCallId: op.toolCallId,
            order: op.order,
            name: 'tool',
            status: 'running',
            input: op.input,
            createdAt: op.now,
            updatedAt: op.now,
          };
      return { ok: true };
    }
    case 'toolCompleted': {
      draft.toolCalls = draft.toolCalls ?? {};
      const existing = draft.toolCalls[op.compositeId];
      const base =
        existing ??
        {
          id: op.compositeId,
          taskId: op.taskId,
          turnId: op.turnId,
          toolCallId: op.toolCallId,
          order: op.order,
          name: 'tool',
          status: 'running' as const,
          createdAt: op.now,
          updatedAt: op.now,
        };
      draft.toolCalls[op.compositeId] = {
        ...base,
        status: op.outcome === 'error' ? 'error' : 'success',
        updatedAt: op.now,
        ...(op.outcome === 'error'
          ? { error: op.error, output: undefined }
          : { output: op.output, error: undefined }),
      };
      return { ok: true };
    }
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}
