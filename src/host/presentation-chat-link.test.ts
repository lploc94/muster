import { describe, expect, it, vi } from 'vitest';
import { createPresentationChatLink } from './presentation-chat-link';
import type { MusterTask } from '../task/types';

function task(overrides: Partial<MusterTask> = {}): MusterTask {
  return {
    id: 'root', role: 'coordinator', lifecycle: 'open', goal: 'g', parentId: null,
    dependencies: [], backend: 'claude', capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0, turnTimeoutMs: 1, taskTimeoutMs: 1 },
    revision: 1, createdAt: 'now', updatedAt: 'now', ...overrides,
  };
}

it('reveals the singleton chat and hydrates the persisted coordinator without mutating the store', async () => {
  const file = { tasks: { root: task() }, turns: {}, messages: {}, revision: 7 };
  const before = JSON.stringify(file);
  const executeCommand = vi.fn().mockResolvedValue(undefined);
  const focusTask = vi.fn();
  const reveal = createPresentationChatLink({ getFile: () => file }, { executeCommand }, { focusTask });

  await expect(reveal('root')).resolves.toEqual({ ok: true, code: 'revealed' });
  expect(executeCommand).toHaveBeenCalledWith('muster.openChat');
  expect(focusTask).toHaveBeenCalledWith('root');
  expect(JSON.stringify(file)).toBe(before);
});

describe('presentation chat link rejection', () => {
  it.each([
    ['missing', {}, 'not-found'],
    ['worker', { worker: task({ id: 'worker', role: 'worker', parentId: 'root' }) }, 'not-owner'],
    ['nested coordinator', { nested: task({ id: 'nested', parentId: 'root' }) }, 'not-owner'],
  ])('rejects %s without revealing or changing prior focus', async (_name, tasks, code) => {
    const executeCommand = vi.fn();
    const focusTask = vi.fn();
    const reveal = createPresentationChatLink({ getFile: () => ({ tasks, turns: {}, messages: {}, revision: 1 }) }, { executeCommand }, { focusTask });
    await expect(reveal(Object.keys(tasks)[0] ?? 'missing')).resolves.toEqual({ ok: false, code });
    expect(executeCommand).not.toHaveBeenCalled();
    expect(focusTask).not.toHaveBeenCalled();
  });

  it('preserves focus and returns host-failure when the view cannot be revealed', async () => {
    const focusTask = vi.fn();
    const reveal = createPresentationChatLink(
      { getFile: () => ({ tasks: { root: task() }, turns: {}, messages: {}, revision: 1 }) },
      { executeCommand: vi.fn().mockRejectedValue(new Error('private')) },
      { focusTask },
    );
    await expect(reveal('root')).resolves.toEqual({ ok: false, code: 'host-failure' });
    expect(focusTask).not.toHaveBeenCalled();
  });
});
