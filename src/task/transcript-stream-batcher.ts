import type { PersistedReasoning, TaskMessage } from './types';

/** Fixed coalescing window for assistant/reasoning stream flushes (P4-W8). */
export const TRANSCRIPT_STREAM_BATCH_WINDOW_MS = 75;

export type StreamAssistantSegment = {
  storeId: string;
  sourceMessageId: string;
  content: string;
  createdAt: string;
  order: number;
  taskId: string;
  turnId: string;
};

export type StreamBatchPayload = {
  taskId: string;
  turnId: string;
  messages?: TaskMessage[];
  reasoning?: PersistedReasoning[];
};

export type StreamFlushResult =
  | { ok: true; payload: StreamBatchPayload | null }
  | { ok: false; turnId: string; message: string };

export type TranscriptStreamBatcherOptions = {
  windowMs?: number;
  /** Injectable timer for fake-timer tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
  /**
   * Persist one coalesced appendTranscriptBatch. Must resolve after SQLite commit.
   * Return ok:false / throw → no UI publish for that flush.
   */
  persist: (payload: StreamBatchPayload) => Promise<{ changed: boolean; reason?: string }>;
  /**
   * A timer flush has no caller that can observe an error. Report it exactly
   * once so the engine can durably fail the turn instead of retrying forever.
   */
  onTimerFlushError?: (turnId: string, message: string) => void | Promise<void>;
};

type TurnBuffer = {
  taskId: string;
  turnId: string;
  assistant?: StreamAssistantSegment;
  reasoning?: PersistedReasoning;
  dirtyAssistant: boolean;
  dirtyReasoning: boolean;
  timer: unknown | null;
  /** Serialize flushes for this turn. */
  flushChain: Promise<void>;
  /** Deltas arriving during an in-flight flush stay for the next batch. */
  flushInFlight: boolean;
  /** Blocks timer retries after an unobserved persistence failure. */
  timerFailureReported: boolean;
};

/**
 * Per-turn assistant/reasoning coalescer.
 * Multiple deltas within the window collapse into one appendTranscriptBatch.
 * Flush boundaries (tool/terminal/focus/deactivate) call flush() explicitly.
 */
export class TranscriptStreamBatcher {
  private readonly windowMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly clearSchedule: (handle: unknown) => void;
  private readonly persist: TranscriptStreamBatcherOptions['persist'];
  private readonly onTimerFlushError?: TranscriptStreamBatcherOptions['onTimerFlushError'];
  private readonly turns = new Map<string, TurnBuffer>();

  constructor(options: TranscriptStreamBatcherOptions) {
    this.windowMs = options.windowMs ?? TRANSCRIPT_STREAM_BATCH_WINDOW_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearSchedule = options.clearSchedule ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.persist = options.persist;
    this.onTimerFlushError = options.onTimerFlushError;
  }

  noteAssistant(segment: StreamAssistantSegment): void {
    const buf = this.ensure(segment.turnId, segment.taskId);
    buf.assistant = { ...segment };
    buf.dirtyAssistant = true;
    this.armTimer(buf);
  }

  noteReasoning(reasoning: PersistedReasoning): void {
    const buf = this.ensure(reasoning.turnId, reasoning.taskId);
    buf.reasoning = { ...reasoning };
    buf.dirtyReasoning = true;
    this.armTimer(buf);
  }

  /** True when the turn has unflushed assistant/reasoning content. */
  hasPending(turnId: string): boolean {
    const buf = this.turns.get(turnId);
    if (!buf) return false;
    return buf.dirtyAssistant || buf.dirtyReasoning;
  }

  async flushTurn(turnId: string): Promise<StreamFlushResult> {
    const buf = this.turns.get(turnId);
    if (!buf) return { ok: true, payload: null };

    // Chain flushes so concurrent callers never overlap for the same turn.
    const pending = buf.flushChain.then(
      () => this.flushTurnOnce(buf),
      () => this.flushTurnOnce(buf),
    );
    buf.flushChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async flushTask(taskId: string): Promise<StreamFlushResult[]> {
    const results: StreamFlushResult[] = [];
    for (const [turnId, buf] of this.turns) {
      if (buf.taskId === taskId) {
        results.push(await this.flushTurn(turnId));
      }
    }
    return results;
  }

  async flushAll(): Promise<StreamFlushResult[]> {
    const results: StreamFlushResult[] = [];
    for (const turnId of [...this.turns.keys()]) {
      results.push(await this.flushTurn(turnId));
    }
    return results;
  }

  /** Drop timers/buffers for a turn after settlement (pending content must be flushed first). */
  disposeTurn(turnId: string): void {
    const buf = this.turns.get(turnId);
    if (!buf) return;
    if (buf.timer !== null) {
      this.clearSchedule(buf.timer);
      buf.timer = null;
    }
    this.turns.delete(turnId);
  }

  disposeAll(): void {
    for (const turnId of [...this.turns.keys()]) {
      this.disposeTurn(turnId);
    }
  }

  private ensure(turnId: string, taskId: string): TurnBuffer {
    let buf = this.turns.get(turnId);
    if (!buf) {
      buf = {
        taskId,
        turnId,
        dirtyAssistant: false,
        dirtyReasoning: false,
        timer: null,
        flushChain: Promise.resolve(),
        flushInFlight: false,
        timerFailureReported: false,
      };
      this.turns.set(turnId, buf);
    } else {
      buf.taskId = taskId;
    }
    return buf;
  }

  private armTimer(buf: TurnBuffer): void {
    if (buf.timer !== null || buf.flushInFlight || buf.timerFailureReported) return;
    buf.timer = this.schedule(() => {
      buf.timer = null;
      void this.flushFromTimer(buf);
    }, this.windowMs);
  }

  private async flushFromTimer(buf: TurnBuffer): Promise<void> {
    let result: StreamFlushResult;
    try {
      result = await this.flushTurn(buf.turnId);
    } catch (error) {
      result = {
        ok: false,
        turnId: buf.turnId,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.ok || buf.timerFailureReported) return;
    buf.timerFailureReported = true;
    try {
      await this.onTimerFlushError?.(buf.turnId, result.message);
    } catch {
      // The timer callback must never create an unhandled rejection. The
      // buffer remains dirty and explicit lifecycle boundaries may retry it.
    }
  }

  private async flushTurnOnce(buf: TurnBuffer): Promise<StreamFlushResult> {
    if (buf.timer !== null) {
      this.clearSchedule(buf.timer);
      buf.timer = null;
    }
    if (!buf.dirtyAssistant && !buf.dirtyReasoning) {
      return { ok: true, payload: null };
    }

    // Snapshot dirty buffers; new deltas during persist re-dirty the buffer.
    const assistant = buf.dirtyAssistant ? buf.assistant : undefined;
    const reasoning = buf.dirtyReasoning ? buf.reasoning : undefined;
    buf.dirtyAssistant = false;
    buf.dirtyReasoning = false;

    const messages: TaskMessage[] | undefined = assistant
      ? [
          {
            id: assistant.storeId,
            taskId: assistant.taskId,
            role: 'assistant',
            content: assistant.content,
            state: 'partial',
            createdAt: assistant.createdAt,
            turnId: assistant.turnId,
            order: assistant.order,
          },
        ]
      : undefined;
    const reasoningRows = reasoning ? [reasoning] : undefined;
    if ((!messages || messages.length === 0) && (!reasoningRows || reasoningRows.length === 0)) {
      return { ok: true, payload: null };
    }

    const payload: StreamBatchPayload = {
      taskId: buf.taskId,
      turnId: buf.turnId,
      ...(messages ? { messages } : {}),
      ...(reasoningRows ? { reasoning: reasoningRows } : {}),
    };

    buf.flushInFlight = true;
    let persistFailed = false;
    try {
      const result = await this.persist(payload);
      if (!result.changed) {
        persistFailed = true;
        // Restore dirty flags so a later boundary can retry or settle-fail path can observe.
        if (assistant) buf.dirtyAssistant = true;
        if (reasoning) buf.dirtyReasoning = true;
        return {
          ok: false,
          turnId: buf.turnId,
          message: result.reason ?? 'stream batch persistence failed',
        };
      }
      // An explicit boundary may recover a buffer after a timer failure.
      buf.timerFailureReported = false;
      return { ok: true, payload };
    } catch (error) {
      persistFailed = true;
      if (assistant) buf.dirtyAssistant = true;
      if (reasoning) buf.dirtyReasoning = true;
      return {
        ok: false,
        turnId: buf.turnId,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Clear in-flight before re-arm so deltas that arrived during persist get a timer.
      buf.flushInFlight = false;
      if (!persistFailed && (buf.dirtyAssistant || buf.dirtyReasoning)) {
        this.armTimer(buf);
      }
    }
  }
}
