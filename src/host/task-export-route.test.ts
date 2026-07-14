import { describe, expect, it, vi } from 'vitest';
import type { MusterTask, TaskMessage, TaskStoreFile, TaskTurn } from '../task/types';
import {
  DEFAULT_TASK_MARKDOWN_EXPORT_MAX_CHARS,
  TASK_MARKDOWN_EXPORT_FORMAT,
  renderTaskMarkdownExport,
} from './task-markdown-export';
import {
  MAX_TASK_EXPORT_ERROR_CHARS,
  TASK_EXPORT_ERROR_MESSAGES,
  exportFileNameBasename,
  parseExportTaskMessage,
  routeExportTask,
  sanitizeTaskExportErrorText,
  type TaskExportHostMessage,
  type TaskExportRouteDeps,
  type TaskExportUri,
} from './task-export-route';

const POLICY = {
  maxTurns: 10,
  maxAutomaticRetries: 1,
  turnTimeoutMs: 60_000,
  taskTimeoutMs: 300_000,
};

const EXPORTED_AT = '2026-07-14T12:00:00.000Z';

function task(id: string, overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    goal: `Goal for ${id}`,
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: POLICY,
    revision: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function turn(
  overrides: Partial<TaskTurn> & Pick<TaskTurn, 'id' | 'taskId' | 'status' | 'sequence'>,
): TaskTurn {
  return {
    trigger: 'user',
    inputs: [],
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function message(
  overrides: Partial<TaskMessage> & Pick<TaskMessage, 'id' | 'taskId' | 'role' | 'content'>,
): TaskMessage {
  return {
    state: 'complete',
    createdAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function baseFile(overrides: Partial<TaskStoreFile> = {}): TaskStoreFile {
  return {
    schemaVersion: 3,
    revision: 11,
    tasks: {
      'task-a': task('task-a', {
        goal: 'Ship readable export',
        lifecycle: 'succeeded',
        backend: 'claude',
        model: 'sonnet',
        finishedAt: '2026-07-06T01:00:00.000Z',
      }),
    },
    turns: {
      t1: turn({
        id: 't1',
        taskId: 'task-a',
        status: 'succeeded',
        sequence: 1,
        inputs: [{ kind: 'message', messageId: 'u1' }],
        finishedAt: '2026-07-06T00:10:00.000Z',
      }),
    },
    messages: {
      u1: message({
        id: 'u1',
        taskId: 'task-a',
        role: 'user',
        content: 'Please summarize the plan.',
        createdAt: '2026-07-06T00:09:00.000Z',
        turnId: 't1',
      }),
      a1: message({
        id: 'a1',
        taskId: 'task-a',
        role: 'assistant',
        content: 'Here is the plan overview.',
        createdAt: '2026-07-06T00:09:30.000Z',
        turnId: 't1',
        order: 0,
      }),
    },
    operations: {},
    cancelRequests: {},
    ...overrides,
  };
}

function makeDeps(
  file: TaskStoreFile,
  overrides: Partial<TaskExportRouteDeps> = {},
): {
  deps: TaskExportRouteDeps;
  showSaveDialog: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  written: { uri: TaskExportUri; content: Uint8Array }[];
} {
  const written: { uri: TaskExportUri; content: Uint8Array }[] = [];
  const showSaveDialog = vi.fn(
    async (_options: { defaultFileName: string }): Promise<TaskExportUri | undefined> => ({
      fsPath: 'C:\\Users\\secret\\exports\\ship-readable-export.md',
      path: '/Users/secret/exports/ship-readable-export.md',
    }),
  );
  const writeFile = vi.fn(async (uri: TaskExportUri, content: Uint8Array) => {
    written.push({ uri, content });
  });
  return {
    written,
    showSaveDialog,
    writeFile,
    deps: {
      getStoreFile: () => file,
      showSaveDialog,
      writeFile,
      exportedAt: EXPORTED_AT,
      ...overrides,
    },
  };
}

function collectMessages(outcome: Awaited<ReturnType<typeof routeExportTask>>): TaskExportHostMessage[] {
  if (outcome.kind === 'messages') return outcome.messages;
  return [];
}

describe('parseExportTaskMessage', () => {
  it('accepts a valid exportTask payload and trims taskId', () => {
    expect(parseExportTaskMessage({ type: 'exportTask', taskId: '  task-a  ' })).toEqual({
      ok: true,
      taskId: 'task-a',
    });
  });

  it.each([
    [null, 'object payload'],
    [undefined, 'object payload'],
    ['exportTask', 'object payload'],
    [{ type: 'send', taskId: 't' }, 'type mismatch'],
    [{ type: 'exportTask' }, 'requires taskId'],
    [{ type: 'exportTask', taskId: '   ' }, 'requires taskId'],
    [{ type: 'exportTask', taskId: 12 }, 'requires taskId'],
  ])('rejects malformed export payload %#', (input, fragment) => {
    const result = parseExportTaskMessage(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_request');
      expect(result.message).toContain(fragment);
    }
  });

  it('rejects oversized and null-byte task ids', () => {
    const longId = 'a'.repeat(257);
    const longResult = parseExportTaskMessage({ type: 'exportTask', taskId: longId });
    expect(longResult.ok).toBe(false);
    if (!longResult.ok) {
      expect(longResult.code).toBe('invalid_request');
      expect(longResult.taskId?.length).toBeLessThanOrEqual(256);
    }

    const nullResult = parseExportTaskMessage({ type: 'exportTask', taskId: 'bad\0id' });
    expect(nullResult.ok).toBe(false);
    if (!nullResult.ok) {
      expect(nullResult.code).toBe('invalid_request');
    }
  });
});

describe('exportFileNameBasename', () => {
  it('returns only the basename for windows and posix paths', () => {
    expect(exportFileNameBasename('C:\\Users\\secret\\exports\\ship-readable-export.md')).toBe(
      'ship-readable-export.md',
    );
    expect(exportFileNameBasename('/Users/secret/exports/ship-readable-export.md')).toBe(
      'ship-readable-export.md',
    );
    expect(exportFileNameBasename('ship-readable-export.md')).toBe('ship-readable-export.md');
  });

  it('never returns path separators in the basename', () => {
    const name = exportFileNameBasename('D:/abs/secret/path/notes.md');
    expect(name).toBe('notes.md');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('secret');
  });
});

describe('sanitizeTaskExportErrorText', () => {
  it('strips control characters, stack frames, and bounds length', () => {
    const raw =
      'Unable to write\n    at writeFile (C:\\Users\\secret\\app\\extension.ts:10:5)\n    at routeExportTask';
    const sanitized = sanitizeTaskExportErrorText(raw);
    expect(sanitized).not.toContain('\n');
    expect(sanitized).not.toContain('at writeFile');
    expect(sanitized).not.toContain('C:\\Users\\secret');
    expect(sanitized.length).toBeLessThanOrEqual(MAX_TASK_EXPORT_ERROR_CHARS);
  });
});

describe('routeExportTask', () => {
  it('renders, opens Save As with suggested name, writes UTF-8, and returns exportResult basename only', async () => {
    const file = baseFile();
    const before = JSON.stringify(file);
    const { deps, showSaveDialog, writeFile, written } = makeDeps(file);

    const outcome = await routeExportTask({ type: 'exportTask', taskId: 'task-a' }, deps);
    const messages = collectMessages(outcome);

    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(showSaveDialog).toHaveBeenCalledWith({
      defaultFileName: 'ship-readable-export.md',
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);

    const utf8 = new TextDecoder('utf-8').decode(written[0]!.content);
    expect(utf8.startsWith(`<!-- ${TASK_MARKDOWN_EXPORT_FORMAT} -->`)).toBe(true);
    expect(utf8).toContain('Please summarize the plan.');
    expect(utf8).toContain('Here is the plan overview.');

    // Direct projector parity for the same inputs.
    const projected = renderTaskMarkdownExport(file, 'task-a', { exportedAt: EXPORTED_AT });
    expect(projected.ok).toBe(true);
    if (projected.ok) {
      expect(utf8).toBe(projected.markdown);
    }

    expect(messages).toEqual([
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'ship-readable-export.md',
        sourceRevision: 11,
        exportedAt: EXPORTED_AT,
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain('C:\\Users\\secret');
    expect(JSON.stringify(messages)).not.toContain('/Users/secret');
    expect(JSON.stringify(file)).toBe(before);
  });

  it('stays silent on cancel with no exportResult and no commandError', async () => {
    const file = baseFile();
    const before = JSON.stringify(file);
    const cancelDialog = vi.fn(async () => undefined);
    const { deps, writeFile } = makeDeps(file, {
      showSaveDialog: cancelDialog,
    });

    const outcome = await routeExportTask({ type: 'exportTask', taskId: 'task-a' }, deps);
    expect(outcome).toEqual({ kind: 'cancel' });
    expect(cancelDialog).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
    expect(JSON.stringify(file)).toBe(before);
  });

  it('fails closed on invalid request without opening Save As', async () => {
    const file = baseFile();
    const before = JSON.stringify(file);
    const { deps, showSaveDialog, writeFile } = makeDeps(file);

    const outcome = await routeExportTask({ type: 'exportTask', taskId: '' }, deps);
    const messages = collectMessages(outcome);

    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(messages).toEqual([
      {
        type: 'commandError',
        message: TASK_EXPORT_ERROR_MESSAGES.invalid_request,
      },
    ]);
    expect(JSON.stringify(file)).toBe(before);
  });

  it('fails closed on missing task without opening Save As', async () => {
    const file = baseFile();
    const before = JSON.stringify(file);
    const { deps, showSaveDialog, writeFile } = makeDeps(file);

    const outcome = await routeExportTask({ type: 'exportTask', taskId: 'missing-task' }, deps);
    const messages = collectMessages(outcome);

    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(messages).toEqual([
      {
        type: 'commandError',
        taskId: 'missing-task',
        message: TASK_EXPORT_ERROR_MESSAGES.task_not_found,
      },
    ]);
    expect(JSON.stringify(file)).toBe(before);
  });

  it('fails closed on render_bound without opening Save As or leaking partial markdown', async () => {
    const file = baseFile({
      messages: {
        u1: message({
          id: 'u1',
          taskId: 'task-a',
          role: 'user',
          content: 'x'.repeat(500),
          turnId: 't1',
        }),
        a1: message({
          id: 'a1',
          taskId: 'task-a',
          role: 'assistant',
          content: 'y'.repeat(500),
          turnId: 't1',
          order: 0,
        }),
      },
    });
    const before = JSON.stringify(file);
    const { deps, showSaveDialog, writeFile } = makeDeps(file, {
      maxChars: 200,
    });

    const outcome = await routeExportTask({ type: 'exportTask', taskId: 'task-a' }, deps);
    const messages = collectMessages(outcome);

    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(messages).toEqual([
      {
        type: 'commandError',
        taskId: 'task-a',
        message: TASK_EXPORT_ERROR_MESSAGES.render_bound,
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain('xxxx');
    expect(JSON.stringify(messages)).not.toContain(TASK_MARKDOWN_EXPORT_FORMAT);
    expect(JSON.stringify(file)).toBe(before);
    expect(DEFAULT_TASK_MARKDOWN_EXPORT_MAX_CHARS).toBeGreaterThan(200);
  });

  it('maps write failures to sanitized task-scoped commandError without absolute paths or stacks', async () => {
    const file = baseFile();
    const before = JSON.stringify(file);
    const failingWrite = vi.fn(async () => {
      throw new Error(
        'EACCES: permission denied, open \'C:\\Users\\secret\\exports\\ship-readable-export.md\'\n    at Object.writeFileSync (node:fs:1:1)',
      );
    });
    const { deps, showSaveDialog } = makeDeps(file, {
      writeFile: failingWrite,
    });

    const outcome = await routeExportTask({ type: 'exportTask', taskId: 'task-a' }, deps);
    const messages = collectMessages(outcome);

    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(failingWrite).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([
      {
        type: 'commandError',
        taskId: 'task-a',
        message: TASK_EXPORT_ERROR_MESSAGES.write_failed,
      },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('C:\\Users\\secret');
    expect(serialized).not.toContain('EACCES');
    expect(serialized).not.toContain('permission denied');
    expect(serialized).not.toContain('writeFileSync');
    expect(serialized).not.toContain('node:fs');
    expect(JSON.stringify(file)).toBe(before);
  });

  it('never mutates the store snapshot on any path', async () => {
    const file = baseFile({
      tasks: {
        'task-a': task('task-a', {
          goal: 'Ship readable export',
          lifecycle: 'succeeded',
          backend: 'claude',
          committedSessionId: 'SESSION_COMMITTED_SECRET',
          cwd: 'C:\\Users\\secret\\workspace',
        }),
        'task-b': task('task-b', {
          goal: 'Other task must never export',
          committedSessionId: 'SESSION_OTHER_TASK',
        }),
      },
    });
    const before = JSON.stringify(file);

    const paths: Array<{ label: string; run: () => Promise<unknown> }> = [
      {
        label: 'success',
        run: () => routeExportTask({ type: 'exportTask', taskId: 'task-a' }, makeDeps(file).deps),
      },
      {
        label: 'cancel',
        run: () =>
          routeExportTask(
            { type: 'exportTask', taskId: 'task-a' },
            makeDeps(file, { showSaveDialog: vi.fn(async () => undefined) }).deps,
          ),
      },
      {
        label: 'missing',
        run: () => routeExportTask({ type: 'exportTask', taskId: 'missing' }, makeDeps(file).deps),
      },
      {
        label: 'invalid',
        run: () => routeExportTask({ type: 'exportTask', taskId: '' }, makeDeps(file).deps),
      },
      {
        label: 'write-fail',
        run: () =>
          routeExportTask(
            { type: 'exportTask', taskId: 'task-a' },
            makeDeps(file, {
              writeFile: vi.fn(async () => {
                throw new Error('disk full at /var/secret/path');
              }),
            }).deps,
          ),
      },
    ];

    for (const pathCase of paths) {
      await pathCase.run();
      expect(JSON.stringify(file), pathCase.label).toBe(before);
    }
  });

  it('does not leak cross-task, session, path, or credential canaries in success or failure messages', async () => {
    const file = baseFile({
      tasks: {
        'task-a': task('task-a', {
          goal: 'Ship readable export',
          lifecycle: 'succeeded',
          backend: 'claude',
          model: 'sonnet',
          committedSessionId: 'SESSION_COMMITTED_SECRET',
          cwd: 'C:\\Users\\secret\\workspace',
        }),
        'task-b': task('task-b', {
          goal: 'Other task must never export',
          committedSessionId: 'SESSION_OTHER_TASK',
          cwd: '/var/secret/other-cwd',
        }),
      },
      messages: {
        u1: message({
          id: 'u1',
          taskId: 'task-a',
          role: 'user',
          content: 'Please summarize the plan.',
          agentContent: 'token sk-live-CREDENTIAL_CANARY at /abs/secret/path',
          turnId: 't1',
        }),
        a1: message({
          id: 'a1',
          taskId: 'task-a',
          role: 'assistant',
          content: 'Here is the plan overview.',
          turnId: 't1',
          order: 0,
        }),
        'u-other': message({
          id: 'u-other',
          taskId: 'task-b',
          role: 'user',
          content: 'CROSS_TASK_USER_CONTENT',
        }),
      },
    });

    const success = await routeExportTask(
      { type: 'exportTask', taskId: 'task-a' },
      makeDeps(file).deps,
    );
    const writeFail = await routeExportTask(
      { type: 'exportTask', taskId: 'task-a' },
      makeDeps(file, {
        writeFile: vi.fn(async () => {
          throw new Error('EACCES C:\\Users\\secret\\exports\\ship-readable-export.md sk-live-LEAK');
        }),
      }).deps,
    );
    const missing = await routeExportTask(
      { type: 'exportTask', taskId: 'task-b-missing' },
      makeDeps(file).deps,
    );

    for (const outcome of [success, writeFail, missing]) {
      const serialized = JSON.stringify(outcome);
      for (const needle of [
        'SESSION_COMMITTED_SECRET',
        'SESSION_OTHER_TASK',
        'CROSS_TASK_USER_CONTENT',
        'sk-live-CREDENTIAL_CANARY',
        'sk-live-LEAK',
        'C:\\Users\\secret',
        '/var/secret/other-cwd',
        '/abs/secret/path',
        'agentContent',
        'EACCES',
      ]) {
        expect(serialized, `must not leak ${needle}`).not.toContain(needle);
      }
    }
  });

  it('uses injected exportedAt for deterministic success metadata', async () => {
    const file = baseFile();
    const stamp = '2026-01-02T03:04:05.000Z';
    const outcome = await routeExportTask(
      { type: 'exportTask', taskId: 'task-a' },
      makeDeps(file, { exportedAt: stamp }).deps,
    );
    const messages = collectMessages(outcome);
    expect(messages).toEqual([
      {
        type: 'exportResult',
        taskId: 'task-a',
        fileName: 'ship-readable-export.md',
        sourceRevision: 11,
        exportedAt: stamp,
      },
    ]);
  });
});
