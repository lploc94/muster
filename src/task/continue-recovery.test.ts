import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Backend, BackendCapabilities, NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from './engine';
import { TaskStore } from './store';

const tempDirs: string[] = [];

function makeTempStore(): { filePath: string; store: TaskStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-continue-recovery-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, '.muster-tasks.json');
  return { filePath, store: TaskStore.load({ filePath }) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
  supportsLiveInput: false
};

describe('continueTaskWithMessage', () => {
  it('atomically persists user message and queues continuation on needs_recovery task', async () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['task-1'] = {
        id: 'task-1',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'recover me',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 20,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      draft.turns['turn-1'] = {
        id: 'turn-1',
        taskId: 'task-1',
        sequence: 1,
        trigger: 'user',
        status: 'failed',
        inputs: [],
        error: 'boom',
        createdAt: '2026-07-06T00:00:00.000Z',
        finishedAt: '2026-07-06T00:00:01.000Z',
      };
      return { ok: true };
    });

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: Backend = {
      name: 'fake',
      capabilities: MCP_CAPS,
      async *run(_options: RunOptions) {
        yield { type: 'sessionStarted', sessionId: 'sess-1' } satisfies NormalizedEvent;
        await gate;
        yield { type: 'turnCompleted' } satisfies NormalizedEvent;
      },
    };

    const engine = TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => backend,
      clock: () => '2026-07-06T00:00:02.000Z',
    });

    expect(engine.viewStatus('task-1')).toBe('needs_recovery');
    const result = engine.continueTaskWithMessage('task-1', 'Please continue with the fix');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    const file = TaskStore.load({ filePath }).getFile();
    const message = file.messages[result.value.messageId];
    const turn = file.turns[result.value.turnId];
    expect(message).toMatchObject({
      role: 'user',
      content: 'Please continue with the fix',
      taskId: 'task-1',
    });
    expect(turn).toMatchObject({
      taskId: 'task-1',
      inputs: [{ kind: 'message', messageId: result.value.messageId }],
    });
    expect(['queued', 'running']).toContain(turn.status);

    release?.();
    await engine.whenIdle();
    expect(TaskStore.load({ filePath }).getFile().turns[result.value.turnId].status).toBe('succeeded');
  });

  it('does not leave a pending user message when continuation cannot be queued', () => {
    const { filePath } = makeTempStore();
    const store = TaskStore.load({ filePath });
    store.commit((draft) => {
      draft.tasks['task-1'] = {
        id: 'task-1',
        role: 'coordinator',
        lifecycle: 'open',
        goal: 'recover me',
        parentId: null,
        dependencies: [],
        backend: 'fake',
        capabilities: [],
        executionPolicy: {
          maxTurns: 1,
          maxAutomaticRetries: 0,
          turnTimeoutMs: 1_000,
          taskTimeoutMs: 5_000,
        },
        revision: 0,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      };
      draft.turns['turn-1'] = {
        id: 'turn-1',
        taskId: 'task-1',
        sequence: 1,
        trigger: 'user',
        status: 'failed',
        inputs: [],
        error: 'boom',
        createdAt: '2026-07-06T00:00:00.000Z',
        finishedAt: '2026-07-06T00:00:01.000Z',
      };
      return { ok: true };
    });

    const engine = TaskEngine.load({
      store: TaskStore.load({ filePath }),
      makeBackend: () => ({ name: 'fake', capabilities: MCP_CAPS, async *run() {} }),
      clock: () => '2026-07-06T00:00:02.000Z',
    });

    const beforeMessages = Object.keys(TaskStore.load({ filePath }).getFile().messages).length;
    const result = engine.continueTaskWithMessage('task-1', 'Try again');
    expect(result.ok).toBe(false);
    const afterFile = TaskStore.load({ filePath }).getFile();
    expect(Object.keys(afterFile.messages)).toHaveLength(beforeMessages);
    expect(Object.values(afterFile.messages).some((m) => m.state === 'pending')).toBe(false);
  });
});