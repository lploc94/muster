import { describe, expect, it, vi } from 'vitest';
import {
  createWebviewRenderProbeCoordinator,
  type RenderProbeObservation,
} from './webview-render-probe';

const observation: RenderProbeObservation = {
  fileChangeGroups: [{ fileRowCount: 1 }],
  files: [{
    retentionTruncated: true,
    pathText: 'src/retained-0.ts',
    countsLabel: '0 additions, 0 deletions',
    hasStaticSummary: true,
    hasDiffBody: false,
  }],
};

describe('webview render probe coordinator', () => {
  it('posts a uniquely correlated request and resolves only its matching observation', async () => {
    const postMessage = vi.fn().mockResolvedValue(true);
    const coordinator = createWebviewRenderProbeCoordinator({
      postMessage,
      createRequestId: () => 'probe-1',
    });

    const pending = coordinator.request();
    await expect(Promise.resolve()).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledWith({ type: 'renderProbeRequest', requestId: 'probe-1' });
    expect(coordinator.accept({ type: 'renderProbeResponse', requestId: 'another-probe', observation })).toBe(false);
    expect(coordinator.accept({ type: 'renderProbeResponse', requestId: 'probe-1', observation })).toBe(true);
    await expect(pending).resolves.toEqual(observation);
  });

  it('rejects overlapping requests, failed delivery, malformed replies, timeouts, and disposal without leaking a pending request', async () => {
    const postMessage = vi.fn().mockResolvedValue(true);
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const coordinator = createWebviewRenderProbeCoordinator({
      postMessage,
      createRequestId: () => 'probe-1',
      timeoutMs: 1,
      setTimeout: (callback) => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    });

    const pending = coordinator.request();
    await expect(coordinator.request()).rejects.toThrow('already pending');
    expect(coordinator.accept({ type: 'renderProbeResponse', requestId: 'probe-1', observation: {} })).toBe(false);
    timers.get(1)!();
    await expect(pending).rejects.toThrow('timed out');

    postMessage.mockResolvedValueOnce(false);
    await expect(coordinator.request()).rejects.toThrow('could not be delivered');

    postMessage.mockRejectedValueOnce(new Error('webview closed'));
    await expect(coordinator.request()).rejects.toThrow('could not be delivered');

    const disposable = coordinator.request();
    coordinator.dispose();
    await expect(disposable).rejects.toThrow('disposed');
  });
});
