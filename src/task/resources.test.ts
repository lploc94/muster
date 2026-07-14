import { describe, expect, it } from 'vitest';
import {
  hasResourceConflict,
  normalizeWorkspacePath,
  pathsOverlap,
} from './resources';
import type { MusterTask, TaskStoreFile } from './types';

function task(partial: Partial<MusterTask> & { id: string }): MusterTask {
  return {
    role: 'worker',
    lifecycle: 'open',
    goal: 'g',
    parentId: null,
    dependencies: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: {
      maxTurns: 10,
      maxAutomaticRetries: 0,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 120_000,
    },
    revision: 0,
    createdAt: 't0',
    updatedAt: 't0',
    releaseState: 'released',
    ...partial,
  };
}

describe('pathsOverlap', () => {
  it('detects equal and ancestor paths', () => {
    expect(pathsOverlap('src', 'src')).toBe(true);
    expect(pathsOverlap('src', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/a.ts', 'src')).toBe(true);
    expect(pathsOverlap('a', 'b')).toBe(false);
  });
});

describe('normalizeWorkspacePath', () => {
  it('rejects escape and absolute', () => {
    expect(normalizeWorkspacePath('../x').ok).toBe(false);
    expect(normalizeWorkspacePath('/abs').ok).toBe(false);
    expect(normalizeWorkspacePath('src/a.ts')).toEqual({ ok: true, path: 'src/a.ts' });
  });
});

describe('hasResourceConflict', () => {
  it('blocks overlapping writePaths concurrent running', () => {
    const file: TaskStoreFile = {
      schemaVersion: 5,
      revision: 1,
      tasks: {
        a: task({
          id: 'a',
          brief: {
            version: 1,
            kind: 'implement',
            title: 'a',
            objective: 'a',
            acceptanceCriteria: [],
            writePaths: ['src'],
          },
        }),
        b: task({
          id: 'b',
          brief: {
            version: 1,
            kind: 'implement',
            title: 'b',
            objective: 'b',
            acceptanceCriteria: [],
            writePaths: ['src/a.ts'],
          },
        }),
      },
      turns: {
        t1: {
          id: 't1',
          taskId: 'a',
          sequence: 1,
          trigger: 'engine',
          status: 'running',
          inputs: [],
          createdAt: 't0',
          startedAt: 't0',
        },
      },
      messages: {},
    };
    expect(hasResourceConflict(file, 'b').conflict).toBe(true);
  });

  it('allows disjoint writePaths', () => {
    const file: TaskStoreFile = {
      schemaVersion: 5,
      revision: 1,
      tasks: {
        a: task({
          id: 'a',
          brief: {
            version: 1,
            kind: 'generic',
            title: 'a',
            objective: 'a',
            acceptanceCriteria: [],
            writePaths: ['pkg-a'],
          },
        }),
        b: task({
          id: 'b',
          brief: {
            version: 1,
            kind: 'generic',
            title: 'b',
            objective: 'b',
            acceptanceCriteria: [],
            writePaths: ['pkg-b'],
          },
        }),
      },
      turns: {
        t1: {
          id: 't1',
          taskId: 'a',
          sequence: 1,
          trigger: 'engine',
          status: 'running',
          inputs: [],
          createdAt: 't0',
          startedAt: 't0',
        },
      },
      messages: {},
    };
    expect(hasResourceConflict(file, 'b').conflict).toBe(false);
  });
});
