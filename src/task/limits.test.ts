import { describe, expect, it } from 'vitest';
import {
  bridgeTokenTtlMs,
  canCreateTurn,
  clampExecutionPolicy,
  DEFAULT_EXECUTION_POLICY_BOUNDS,
  DEFAULT_RESOURCE_LIMITS,
  MAX_BRIDGE_TOKEN_TTL_MS,
  type ExecutionPolicyBounds,
} from './limits';
import type { TaskExecutionPolicy, TaskStoreFile } from './types';

const BASE: TaskExecutionPolicy = {
  maxTurns: 50,
  maxAutomaticRetries: 2,
  turnTimeoutMs: 300_000,
  taskTimeoutMs: 1_800_000,
};

describe('clampExecutionPolicy', () => {
  it('passes normal in-bounds values through unchanged', () => {
    const requested: Partial<TaskExecutionPolicy> = {
      maxTurns: 10,
      maxAutomaticRetries: 3,
      turnTimeoutMs: 60_000,
      taskTimeoutMs: 600_000,
    };
    expect(clampExecutionPolicy(BASE, requested)).toEqual(requested);
  });

  it('falls back to the trusted base when nothing is requested', () => {
    expect(clampExecutionPolicy(BASE, undefined)).toEqual(BASE);
  });

  it('clamps over-limit agent values down to the configured maxima', () => {
    const clamped = clampExecutionPolicy(BASE, {
      maxTurns: 1_000_000,
      maxAutomaticRetries: 9_999,
      turnTimeoutMs: 999_999_999,
      taskTimeoutMs: 999_999_999,
    });
    expect(clamped).toEqual({
      maxTurns: DEFAULT_EXECUTION_POLICY_BOUNDS.maxTurns,
      maxAutomaticRetries: DEFAULT_EXECUTION_POLICY_BOUNDS.maxAutomaticRetries,
      turnTimeoutMs: DEFAULT_EXECUTION_POLICY_BOUNDS.maxTurnTimeoutMs,
      taskTimeoutMs: DEFAULT_EXECUTION_POLICY_BOUNDS.maxTaskTimeoutMs,
    });
  });

  it('raises below-minimum timeouts and turn budget up to the minima', () => {
    const clamped = clampExecutionPolicy(BASE, {
      maxTurns: 0,
      turnTimeoutMs: 0,
      taskTimeoutMs: 1,
    });
    expect(clamped.maxTurns).toBe(1);
    expect(clamped.turnTimeoutMs).toBe(DEFAULT_EXECUTION_POLICY_BOUNDS.minTurnTimeoutMs);
    expect(clamped.taskTimeoutMs).toBe(DEFAULT_EXECUTION_POLICY_BOUNDS.minTaskTimeoutMs);
    // Untouched fields still come from the trusted base.
    expect(clamped.maxAutomaticRetries).toBe(BASE.maxAutomaticRetries);
  });

  it('honours a custom bounds object', () => {
    const strict: ExecutionPolicyBounds = {
      minTurnTimeoutMs: 5_000,
      maxTurnTimeoutMs: 10_000,
      minTaskTimeoutMs: 5_000,
      maxTaskTimeoutMs: 20_000,
      maxTurns: 3,
      maxAutomaticRetries: 1,
    };
    const clamped = clampExecutionPolicy(
      BASE,
      { maxTurns: 100, turnTimeoutMs: 1_000_000, taskTimeoutMs: 1_000_000, maxAutomaticRetries: 100 },
      strict,
    );
    expect(clamped).toEqual({
      maxTurns: 3,
      maxAutomaticRetries: 1,
      turnTimeoutMs: 10_000,
      taskTimeoutMs: 20_000,
    });
  });
});

describe('bridgeTokenTtlMs', () => {
  it('passes a normal turn timeout through when it is below the cap', () => {
    expect(bridgeTokenTtlMs(300_000)).toBe(300_000);
  });

  it('caps a turn timeout at the independent hard bound', () => {
    expect(bridgeTokenTtlMs(DEFAULT_EXECUTION_POLICY_BOUNDS.maxTurnTimeoutMs)).toBe(
      MAX_BRIDGE_TOKEN_TTL_MS,
    );
    expect(bridgeTokenTtlMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_BRIDGE_TOKEN_TTL_MS);
  });

  it('honours a custom cap', () => {
    expect(bridgeTokenTtlMs(500_000, 100_000)).toBe(100_000);
  });

  it('collapses invalid inputs to an immediately-expired token', () => {
    expect(bridgeTokenTtlMs(-5)).toBe(0);
    expect(bridgeTokenTtlMs(Number.NaN)).toBe(0);
  });

  it('is a genuinely independent cap below the maximum clamped turn timeout', () => {
    // The whole point of the cap: even a maximum-clamped turn timeout mints a
    // shorter-lived token than the turn itself is allowed to run.
    expect(MAX_BRIDGE_TOKEN_TTL_MS).toBeLessThan(
      DEFAULT_EXECUTION_POLICY_BOUNDS.maxTurnTimeoutMs,
    );
  });
});

describe('canCreateTurn queued reservations', () => {
  it('counts queued turns toward the per-task cap', () => {
    const file: TaskStoreFile = {
      schemaVersion: 2,
      revision: 1,
      tasks: {
        t: {
          id: 't',
          role: 'coordinator',
          lifecycle: 'open',
          goal: 'cap',
          parentId: null,
          dependencies: [],
          backend: 'fake',
          capabilities: [],
          executionPolicy: {
            maxTurns: 2,
            maxAutomaticRetries: 0,
            turnTimeoutMs: 60_000,
            taskTimeoutMs: 120_000,
          },
          revision: 0,
          createdAt: 't',
          updatedAt: 't',
        },
      },
      turns: {
        a: {
          id: 'a',
          taskId: 't',
          sequence: 1,
          trigger: 'user',
          status: 'running',
          inputs: [],
          createdAt: 't',
          startedAt: 't',
        },
        b: {
          id: 'b',
          taskId: 't',
          sequence: 2,
          trigger: 'user',
          status: 'queued',
          inputs: [],
          createdAt: 't2',
        },
      },
      messages: {},
      operations: {},
      cancelRequests: {},
    };
    expect(canCreateTurn(file, 't', { ...DEFAULT_RESOURCE_LIMITS, maxTurnsPerTask: 50 })).toEqual({
      ok: false,
      reason: 'max turns per task exceeded',
    });
  });
});

