import { describe, expect, it } from 'vitest';
import type { Backend } from '../types';
import { BACKEND_IDS, makeBackend } from './index';
import { ACP_EXECUTOR_IDS, ExecutorRegistry, executorKindOf } from './executor-registry';

const stubBackend: Backend = {
  name: 'script-stub',
  run: async function* () {
    yield { type: 'turnCompleted' };
  },
};

describe('executor registry', () => {
  it('resolves a registered non-ACP family without adding it to ACP backend ids', () => {
    const registry = new ExecutorRegistry();
    registry.register({
      id: 'script-test',
      kind: 'script',
      executorIds: ['script-stub'],
      factory: () => stubBackend,
    });

    expect(registry.resolve('script-stub')).toBe(stubBackend);
    expect(registry.kindOf('script-stub')).toBe('script');
    expect(BACKEND_IDS).toEqual(ACP_EXECUTOR_IDS);
  });

  it('keeps all five ACP adapters on the production resolution seam', () => {
    expect(BACKEND_IDS).toEqual(['claude', 'grok', 'kiro', 'codex', 'opencode']);
    for (const id of BACKEND_IDS) {
      expect(makeBackend(id).name).toBe(id);
      expect(executorKindOf(id)).toBe('acp');
    }
  });

  it('rejects duplicate families, duplicate ids, and unknown executors', () => {
    const registry = new ExecutorRegistry();
    registry.register({ id: 'one', kind: 'script', executorIds: ['script-one'], factory: () => stubBackend });
    expect(() => registry.register({
      id: 'one', kind: 'script', executorIds: ['script-two'], factory: () => stubBackend,
    })).toThrow(/already registered/);
    expect(() => registry.register({
      id: 'two', kind: 'script', executorIds: ['script-one'], factory: () => stubBackend,
    })).toThrow(/already registered/);
    expect(() => registry.resolve('missing')).toThrow(/unsupported backend: missing/);
  });
});
