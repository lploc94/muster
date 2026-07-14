/**
 * TaskHandoff aggregate — owns legal phase transitions for cross-runtime handoff.
 *
 * Pure domain object: no engine, backend, or webview dependencies.
 * Persisted shape is {@link TaskHandoffState}; serialization never includes chat
 * messages, prompts, raw CLI output, or credentials.
 */

import { sanitizeHandoffFailureMessage, sanitizeTaskHandoffState } from './store';
import type {
  TaskHandoffCompletion,
  TaskHandoffConversationContext,
  TaskHandoffFailure,
  TaskHandoffPhase,
  TaskHandoffRuntimeBinding,
  TaskHandoffSourceSummary,
  TaskHandoffState,
} from './types';

export type TaskHandoffResult =
  | { ok: true; next: TaskHandoff }
  | { ok: false; reason: string };

export interface CreateTaskHandoffInput {
  operationId: string;
  source: TaskHandoffRuntimeBinding;
  target: TaskHandoffRuntimeBinding;
  now: string;
}

export interface OperationScopedOptions {
  now: string;
  /** When present and mismatched, the transition is rejected as stale. */
  operationId?: string;
}

export interface MarkConversationReadyInput extends OperationScopedOptions {
  messageCount: number;
  contentDigest: string;
  exportedAt: string;
}

export interface SkipSummaryInput extends OperationScopedOptions {
  reason: string;
}

export interface MarkSummaryUnavailableInput extends OperationScopedOptions {
  reason: string;
}

export interface MarkSummaryReadyInput extends OperationScopedOptions {
  contentDigest: string;
  summarizedAt: string;
}

export interface CompleteHandoffInput extends OperationScopedOptions {
  boundBackend: string;
  boundSessionId?: string;
}

export interface FailHandoffInput extends OperationScopedOptions {
  code: string;
  message: string;
}

/** Sanitized diagnostics — never includes conversation bodies, digests, or session ids. */
export interface TaskHandoffDiagnostics {
  operationId: string;
  phase: TaskHandoffPhase;
  sourceBackend: string;
  targetBackend: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  conversationStatus: TaskHandoffConversationContext['status'];
  sourceSummaryStatus?: TaskHandoffSourceSummary['status'];
  hasCompletion: boolean;
  hasFailure: boolean;
}

const TERMINAL_PHASES: ReadonlySet<TaskHandoffPhase> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function cloneState(state: TaskHandoffState): TaskHandoffState {
  return JSON.parse(JSON.stringify(state)) as TaskHandoffState;
}

function completionEqual(
  a: TaskHandoffCompletion | undefined,
  b: TaskHandoffCompletion,
): boolean {
  if (!a) {
    return false;
  }
  return (
    a.boundBackend === b.boundBackend &&
    (a.boundSessionId ?? undefined) === (b.boundSessionId ?? undefined)
  );
}

function failureEqual(a: TaskHandoffFailure | undefined, b: TaskHandoffFailure): boolean {
  if (!a) {
    return false;
  }
  return a.code === b.code && a.message === b.message;
}

/**
 * Immutable aggregate for a single handoff operation.
 * Callers persist via {@link TaskHandoff.toState} on the owning MusterTask.
 */
export class TaskHandoff {
  private constructor(private readonly state: TaskHandoffState) {}

  static create(input: CreateTaskHandoffInput): TaskHandoff {
    const state: TaskHandoffState = {
      version: 1,
      operationId: input.operationId,
      phase: 'requested',
      source: { ...input.source },
      target: { ...input.target },
      conversationContext: { status: 'pending' },
      createdAt: input.now,
      updatedAt: input.now,
    };
    return new TaskHandoff(state);
  }

  /**
   * Reconstruct from a persisted (or raw) snapshot. Malformed input fails closed.
   */
  static restore(raw: unknown): TaskHandoffResult {
    const sanitized = sanitizeTaskHandoffState(raw);
    if (!sanitized) {
      return { ok: false, reason: 'invalid or malformed handoff state' };
    }
    return { ok: true, next: new TaskHandoff(sanitized) };
  }

  get phase(): TaskHandoffPhase {
    return this.state.phase;
  }

  get operationId(): string {
    return this.state.operationId;
  }

  get isTerminal(): boolean {
    return TERMINAL_PHASES.has(this.state.phase);
  }

  /** Deep clone of the durable state contract. */
  toState(): TaskHandoffState {
    return cloneState(this.state);
  }

  /**
   * Bounded internal diagnostics. Never includes conversation content, digests,
   * credentials, absolute paths, or session identifiers.
   */
  toDiagnostics(): TaskHandoffDiagnostics {
    const diag: TaskHandoffDiagnostics = {
      operationId: this.state.operationId,
      phase: this.state.phase,
      sourceBackend: this.state.source.backend,
      targetBackend: this.state.target.backend,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      conversationStatus: this.state.conversationContext.status,
      hasCompletion: this.state.completion !== undefined,
      hasFailure: this.state.failure !== undefined,
    };
    if (this.state.startedAt) {
      diag.startedAt = this.state.startedAt;
    }
    if (this.state.finishedAt) {
      diag.finishedAt = this.state.finishedAt;
    }
    if (this.state.sourceSummary) {
      diag.sourceSummaryStatus = this.state.sourceSummary.status;
    }
    return diag;
  }

  startExport(options: OperationScopedOptions): TaskHandoffResult {
    const gate = this.gateActive(options);
    if (gate) {
      return gate;
    }
    if (this.state.phase !== 'requested') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    return this.okWith({
      phase: 'exporting_context',
      startedAt: this.state.startedAt ?? options.now,
      updatedAt: options.now,
    });
  }

  markConversationReady(input: MarkConversationReadyInput): TaskHandoffResult {
    const gate = this.gateActive(input);
    if (gate) {
      return gate;
    }
    if (this.state.phase !== 'exporting_context') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    if (this.state.conversationContext.status === 'ready') {
      // Idempotent when metadata matches.
      const current = this.state.conversationContext;
      if (
        current.messageCount === input.messageCount &&
        current.contentDigest === input.contentDigest &&
        current.exportedAt === input.exportedAt
      ) {
        return { ok: true, next: this };
      }
      return { ok: false, reason: 'conversation context already ready with different metadata' };
    }
    return this.okWith({
      conversationContext: {
        status: 'ready',
        messageCount: input.messageCount,
        contentDigest: input.contentDigest,
        exportedAt: input.exportedAt,
      },
      updatedAt: input.now,
    });
  }

  markConversationUnavailable(
    input: OperationScopedOptions & { reason: string },
  ): TaskHandoffResult {
    const gate = this.gateActive(input);
    if (gate) {
      return gate;
    }
    if (this.state.phase !== 'exporting_context') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    return this.okWith({
      conversationContext: {
        status: 'unavailable',
        reason: input.reason.slice(0, 120),
      },
      updatedAt: input.now,
    });
  }

  beginSummarizing(options: OperationScopedOptions): TaskHandoffResult {
    const gate = this.gateActive(options);
    if (gate) {
      return gate;
    }
    if (this.state.phase !== 'exporting_context') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    if (this.state.conversationContext.status !== 'ready') {
      return { ok: false, reason: 'conversation context not ready' };
    }
    return this.okWith({
      phase: 'summarizing_source',
      sourceSummary: { status: 'pending' },
      updatedAt: options.now,
    });
  }

  skipSummary(input: SkipSummaryInput): TaskHandoffResult {
    const gate = this.gateActive(input);
    if (gate) {
      return gate;
    }
    // Allowed after context export while still in exporting_context (skip path),
    // or while summarizing if the caller chooses to abandon summarization.
    if (
      this.state.phase !== 'exporting_context' &&
      this.state.phase !== 'summarizing_source'
    ) {
      return { ok: false, reason: 'illegal phase transition' };
    }
    if (this.state.conversationContext.status !== 'ready') {
      return { ok: false, reason: 'conversation context not ready' };
    }
    return this.okWith({
      sourceSummary: { status: 'skipped', reason: input.reason.slice(0, 120) },
      updatedAt: input.now,
    });
  }

  markSummaryReady(input: MarkSummaryReadyInput): TaskHandoffResult {
    const gate = this.gateActive(input);
    if (gate) {
      return gate;
    }
    if (this.state.phase !== 'summarizing_source') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    if (this.state.sourceSummary?.status !== 'pending') {
      return { ok: false, reason: 'source summary is not pending' };
    }
    return this.okWith({
      sourceSummary: {
        status: 'ready',
        contentDigest: input.contentDigest,
        summarizedAt: input.summarizedAt,
      },
      updatedAt: input.now,
    });
  }

  markSummaryUnavailable(input: MarkSummaryUnavailableInput): TaskHandoffResult {
    const gate = this.gateActive(input);
    if (gate) {
      return gate;
    }
    if (this.state.phase !== 'summarizing_source') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    return this.okWith({
      sourceSummary: {
        status: 'unavailable',
        reason: input.reason.slice(0, 120),
      },
      updatedAt: input.now,
    });
  }

  beginPreparingReceiver(options: OperationScopedOptions): TaskHandoffResult {
    const gate = this.gateActive(options);
    if (gate) {
      return gate;
    }
    if (
      this.state.phase !== 'exporting_context' &&
      this.state.phase !== 'summarizing_source'
    ) {
      return { ok: false, reason: 'illegal phase transition' };
    }
    if (this.state.conversationContext.status !== 'ready') {
      return { ok: false, reason: 'conversation context not ready' };
    }
    if (this.state.sourceSummary?.status === 'pending') {
      return { ok: false, reason: 'source summary still pending' };
    }
    // Summary may be absent (treated as none requested until skip/ready/unavailable),
    // but beginPreparingReceiver after skip sets skipped; after unavailable sets unavailable.
    // If still undefined while in exporting_context, require an explicit skip or summary resolution.
    if (this.state.phase === 'exporting_context' && this.state.sourceSummary === undefined) {
      return { ok: false, reason: 'source summary unresolved' };
    }
    return this.okWith({
      phase: 'preparing_receiver',
      updatedAt: options.now,
    });
  }

  beginTransfer(options: OperationScopedOptions): TaskHandoffResult {
    const gate = this.gateActive(options);
    if (gate) {
      return gate;
    }
    if (this.state.phase !== 'preparing_receiver') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    return this.okWith({
      phase: 'transferring',
      updatedAt: options.now,
    });
  }

  complete(input: CompleteHandoffInput): TaskHandoffResult {
    const stale = this.checkOperationId(input.operationId);
    if (stale) {
      return stale;
    }

    const completion: TaskHandoffCompletion = {
      completedAt: this.state.completion?.completedAt ?? input.now,
      boundBackend: input.boundBackend,
    };
    if (input.boundSessionId) {
      completion.boundSessionId = input.boundSessionId;
    }

    if (this.state.phase === 'completed') {
      if (completionEqual(this.state.completion, completion)) {
        return { ok: true, next: this };
      }
      return { ok: false, reason: 'terminal completion conflict' };
    }

    if (TERMINAL_PHASES.has(this.state.phase)) {
      return { ok: false, reason: 'handoff is terminal' };
    }

    if (this.state.phase !== 'transferring') {
      return { ok: false, reason: 'illegal phase transition' };
    }
    if (this.state.conversationContext.status !== 'ready') {
      return { ok: false, reason: 'conversation context not ready' };
    }

    return this.okWith({
      phase: 'completed',
      completion: {
        completedAt: input.now,
        boundBackend: input.boundBackend,
        ...(input.boundSessionId ? { boundSessionId: input.boundSessionId } : {}),
      },
      finishedAt: input.now,
      updatedAt: input.now,
    });
  }

  fail(input: FailHandoffInput): TaskHandoffResult {
    const stale = this.checkOperationId(input.operationId);
    if (stale) {
      return stale;
    }

    const failure: TaskHandoffFailure = {
      code: input.code.slice(0, 64),
      message: sanitizeHandoffFailureMessage(input.message),
      at: this.state.failure?.at ?? input.now,
    };

    if (this.state.phase === 'failed') {
      // Compare against sanitized message (as stored).
      if (failureEqual(this.state.failure, failure)) {
        return { ok: true, next: this };
      }
      return { ok: false, reason: 'terminal failure conflict' };
    }

    if (TERMINAL_PHASES.has(this.state.phase)) {
      return { ok: false, reason: 'handoff is terminal' };
    }

    return this.okWith({
      phase: 'failed',
      failure: {
        code: failure.code,
        message: failure.message,
        at: input.now,
      },
      finishedAt: input.now,
      updatedAt: input.now,
    });
  }

  cancel(input: FailHandoffInput): TaskHandoffResult {
    const stale = this.checkOperationId(input.operationId);
    if (stale) {
      return stale;
    }

    const failure: TaskHandoffFailure = {
      code: input.code.slice(0, 64),
      message: sanitizeHandoffFailureMessage(input.message),
      at: this.state.failure?.at ?? input.now,
    };

    if (this.state.phase === 'cancelled') {
      if (failureEqual(this.state.failure, failure)) {
        return { ok: true, next: this };
      }
      return { ok: false, reason: 'terminal cancel conflict' };
    }

    if (TERMINAL_PHASES.has(this.state.phase)) {
      return { ok: false, reason: 'handoff is terminal' };
    }

    return this.okWith({
      phase: 'cancelled',
      failure: {
        code: failure.code,
        message: failure.message,
        at: input.now,
      },
      finishedAt: input.now,
      updatedAt: input.now,
    });
  }

  private gateActive(options: OperationScopedOptions): TaskHandoffResult | undefined {
    const stale = this.checkOperationId(options.operationId);
    if (stale) {
      return stale;
    }
    if (TERMINAL_PHASES.has(this.state.phase)) {
      return { ok: false, reason: 'handoff is terminal' };
    }
    return undefined;
  }

  private checkOperationId(operationId: string | undefined): TaskHandoffResult | undefined {
    if (operationId !== undefined && operationId !== this.state.operationId) {
      return { ok: false, reason: 'stale operation' };
    }
    return undefined;
  }

  private okWith(patch: Partial<TaskHandoffState>): TaskHandoffResult {
    const next: TaskHandoffState = {
      ...cloneState(this.state),
      ...patch,
    };
    return { ok: true, next: new TaskHandoff(next) };
  }
}
