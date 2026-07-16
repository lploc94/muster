import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from './store';
import type { MusterTask, TaskStoreFile } from './types';

function task(): MusterTask {
  return {
    id: 'task-1', role: 'worker', lifecycle: 'open', goal: 'continue work', parentId: null,
    dependencies: [], backend: 'codex', model: 'gpt-5', runtimeEpoch: 2, capabilities: [],
    executionPolicy: { turnTimeoutMs: 0, maxRetries: 0 }, revision: 1,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
  };
}

function loadFile(file: TaskStoreFile): TaskStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-handoff-v2-'));
  const filePath = path.join(dir, 'tasks.json');
  fs.writeFileSync(filePath, JSON.stringify(file));
  return TaskStore.load({ filePath });
}

describe('runtime handoff persistence migration', () => {
  it('strips obsolete v1 workflow state without changing the committed binding', () => {
    const legacy = task();
    legacy.handoff = {
      version: 1, operationId: 'old', phase: 'preparing_receiver',
      source: { backend: 'claude' }, target: { backend: 'codex' },
      conversationContext: { status: 'ready', messageCount: 1, contentDigest: 'abc', exportedAt: 'now' },
      createdAt: 'now', updatedAt: 'now',
    };
    const store = loadFile({ schemaVersion: 5, revision: 1, tasks: { 'task-1': legacy }, turns: {}, messages: {} });
    expect(store.getTask('task-1')).toMatchObject({ backend: 'codex', model: 'gpt-5', runtimeEpoch: 2 });
    expect(store.getTask('task-1')?.handoff).toBeUndefined();
  });

  it('reloads a valid v2 continuation and backfills runtime epochs', () => {
    const current = task();
    delete current.runtimeEpoch;
    current.handoff = {
      version: 2, operationId: 'hop-2',
      source: { backend: 'claude', runtimeEpoch: 1 },
      target: { backend: 'codex', model: 'gpt-5', runtimeEpoch: 2 },
      contextCutoff: {
        throughTurnSequence: 1, sourceStoreRevision: 3, messageCount: 2, toolCallCount: 1,
        contextDigest: 'abc123', capturedAt: 'now',
      },
      continuation: { status: 'pending' }, switchedAt: 'now',
    };
    const store = loadFile({ schemaVersion: 5, revision: 1, tasks: { 'task-1': current }, turns: {}, messages: {} });
    expect(store.getTask('task-1')?.handoff?.operationId).toBe('hop-2');
    expect(store.getTask('task-1')?.runtimeEpoch).toBe(2);
  });
});
