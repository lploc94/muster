import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TranscriptStreamBatcher,
  TRANSCRIPT_STREAM_BATCH_WINDOW_MS,
  type StreamBatchPayload,
} from './transcript-stream-batcher';

describe('TranscriptStreamBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeBatcher(
    persist = vi.fn(async () => ({ changed: true })),
    onTimerFlushError?: (turnId: string, message: string) => void | Promise<void>,
  ) {
    vi.useFakeTimers();
    const scheduled: Array<{ fn: () => void; ms: number; id: number }> = [];
    let nextId = 1;
    const batcher = new TranscriptStreamBatcher({
      windowMs: TRANSCRIPT_STREAM_BATCH_WINDOW_MS,
      schedule: (fn, ms) => {
        const id = nextId++;
        scheduled.push({ fn, ms, id });
        return id;
      },
      clearSchedule: (handle) => {
        const idx = scheduled.findIndex((entry) => entry.id === handle);
        if (idx >= 0) scheduled.splice(idx, 1);
      },
      persist,
      onTimerFlushError,
    });
    return { batcher, persist, scheduled, fireTimers: async () => {
      const due = scheduled.splice(0, scheduled.length);
      for (const entry of due) entry.fn();
      await Promise.resolve();
      await Promise.resolve();
    } };
  }

  it('coalesces many assistant deltas in one window into one persist', async () => {
    const { batcher, persist, fireTimers } = makeBatcher();
    for (let i = 0; i < 200; i++) {
      batcher.noteAssistant({
        storeId: 'turn-1:0',
        sourceMessageId: 'src',
        content: 'x'.repeat(i + 1),
        createdAt: '2026-07-06T00:00:00.000Z',
        order: 0,
        taskId: 'task-1',
        turnId: 'turn-1',
      });
    }
    expect(persist).not.toHaveBeenCalled();
    await fireTimers();
    expect(persist).toHaveBeenCalledTimes(1);
    const payload = persist.mock.calls[0]?.[0] as unknown as StreamBatchPayload;
    expect(payload.messages?.[0]?.content.length).toBe(200);
    expect(payload.messages?.[0]?.id).toBe('turn-1:0');
  });

  it('interleaves reasoning + assistant into one transaction', async () => {
    const { batcher, persist, fireTimers } = makeBatcher();
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'hello',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    batcher.noteReasoning({
      id: 'turn-1:1',
      taskId: 'task-1',
      turnId: 'turn-1',
      order: 1,
      content: 'think',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T00:00:00.000Z',
    });
    await fireTimers();
    expect(persist).toHaveBeenCalledTimes(1);
    const payload = persist.mock.calls[0]?.[0] as unknown as StreamBatchPayload;
    expect(payload.messages).toHaveLength(1);
    expect(payload.reasoning).toHaveLength(1);
    expect(payload.reasoning?.[0]?.id).toBe('turn-1:1');
  });

  it('delta after window starts a second batch', async () => {
    const { batcher, persist, fireTimers } = makeBatcher();
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'a',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    await fireTimers();
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'ab',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    await fireTimers();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('keeps deltas that arrive during in-flight flush for the next batch', async () => {
    let releaseGate!: () => void;
    let call = 0;
    const scheduled: Array<{ fn: () => void; ms: number; id: number }> = [];
    let nextId = 1;
    const persist = vi.fn(async (_payload: StreamBatchPayload) => {
      call += 1;
      if (call === 1) {
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
      }
      return { changed: true };
    });
    const batcher = new TranscriptStreamBatcher({
      windowMs: TRANSCRIPT_STREAM_BATCH_WINDOW_MS,
      schedule: (fn, ms) => {
        const id = nextId++;
        scheduled.push({ fn, ms, id });
        return id;
      },
      clearSchedule: (handle) => {
        const idx = scheduled.findIndex((entry) => entry.id === handle);
        if (idx >= 0) scheduled.splice(idx, 1);
      },
      persist,
    });
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'a',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    const firstPromise = batcher.flushTurn('turn-1');
    // Wait until first persist is blocked on the gate.
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'ab',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    releaseGate();
    await firstPromise;
    // After in-flight completes, dirty delta must auto-arm the next window.
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]?.ms).toBe(TRANSCRIPT_STREAM_BATCH_WINDOW_MS);
    const due = scheduled.splice(0, scheduled.length);
    for (const entry of due) entry.fn();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    const payload = persist.mock.calls[1]?.[0] as unknown as StreamBatchPayload;
    expect(payload.messages?.[0]?.content).toBe('ab');
  });

  it('reports a timer persist failure once and waits for an explicit retry', async () => {
    let attempts = 0;
    const persist = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return { changed: false, reason: 'disk full' };
      return { changed: true };
    });
    const onTimerFlushError = vi.fn(async () => undefined);
    const { batcher, fireTimers, scheduled } = makeBatcher(persist, onTimerFlushError);
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'x',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    await fireTimers();
    await vi.waitFor(() => expect(onTimerFlushError).toHaveBeenCalledOnce());
    expect(persist).toHaveBeenCalledTimes(1);
    expect(onTimerFlushError).toHaveBeenCalledWith('turn-1', 'disk full');
    // Failure remains retryable, but no timer retry storm is allowed.
    expect(batcher.hasPending('turn-1')).toBe(true);
    expect(scheduled.length).toBe(0);
    await fireTimers();
    expect(persist).toHaveBeenCalledTimes(1);

    const recovered = await batcher.flushTurn('turn-1');
    expect(recovered.ok).toBe(true);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(onTimerFlushError).toHaveBeenCalledOnce();
  });

  it('uses the fixed 75ms coalescing window', async () => {
    const { batcher, scheduled } = makeBatcher();
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'x',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    expect(TRANSCRIPT_STREAM_BATCH_WINDOW_MS).toBe(75);
    expect(scheduled[0]?.ms).toBe(75);
  });

  it('independent turns do not mix content', async () => {
    const { batcher, persist, fireTimers } = makeBatcher();
    batcher.noteAssistant({
      storeId: 't1:0',
      sourceMessageId: 's1',
      content: 'one',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 't1',
    });
    batcher.noteAssistant({
      storeId: 't2:0',
      sourceMessageId: 's2',
      content: 'two',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-2',
      turnId: 't2',
    });
    await fireTimers();
    expect(persist).toHaveBeenCalledTimes(2);
    const payloads = persist.mock.calls.map((call) => call[0] as unknown as StreamBatchPayload);
    expect(payloads.map((p) => p.turnId).sort()).toEqual(['t1', 't2']);
    expect(payloads.find((p) => p.turnId === 't1')?.messages?.[0]?.content).toBe('one');
    expect(payloads.find((p) => p.turnId === 't2')?.messages?.[0]?.content).toBe('two');
  });

  it('explicit flush before tool boundary does not wait for timer', async () => {
    const { batcher, persist } = makeBatcher();
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'hello',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    const result = await batcher.flushTurn('turn-1');
    expect(result.ok).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('persist failure returns ok:false and does not drop buffer ownership', async () => {
    const persist = vi.fn(async () => ({ changed: false, reason: 'disk full' }));
    const { batcher, fireTimers } = makeBatcher(persist);
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'x',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    await fireTimers();
    const result = await batcher.flushTurn('turn-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('disk full');
  });

  it('dispose clears timers', async () => {
    const { batcher, persist, scheduled } = makeBatcher();
    batcher.noteAssistant({
      storeId: 'turn-1:0',
      sourceMessageId: 'src',
      content: 'x',
      createdAt: '2026-07-06T00:00:00.000Z',
      order: 0,
      taskId: 'task-1',
      turnId: 'turn-1',
    });
    expect(scheduled.length).toBe(1);
    batcher.disposeTurn('turn-1');
    expect(scheduled.length).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });
});
