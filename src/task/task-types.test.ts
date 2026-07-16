import { describe, expect, it } from 'vitest';
import {
  TASK_TYPE_DESCRIPTION_MAX,
  TASK_TYPE_DIAGNOSTIC_MAX,
  TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX,
  TASK_TYPE_MAX,
  parseTaskTypeRegistry,
  resolveCreateChildSpec,
  summarizeTaskTypes,
} from './task-types';

const sampleRaw = {
  plan: {
    description: 'Produce an actionable implementation plan',
    backend: 'codex',
    model: 'gpt-5.5',
    role: 'worker',
    briefKind: 'plan',
  },
  implement: {
    backend: 'grok',
    model: 'grok-4.5',
    briefKind: 'implement',
  },
  coordinate: {
    backend: 'grok',
    model: 'grok-4.5',
    role: 'coordinator',
    briefKind: 'coordinate',
  },
};

describe('parseTaskTypeRegistry', () => {
  it('returns empty for undefined/null/{}', () => {
    for (const raw of [undefined, null, {}]) {
      const r = parseTaskTypeRegistry(raw);
      expect(r.status).toBe('empty');
      expect(r.registry.size).toBe(0);
      expect(r.diagnostics).toEqual([]);
    }
  });

  it('empty is distinct from invalid (fail-closed create/delegate path)', () => {
    const empty = parseTaskTypeRegistry({});
    const invalid = parseTaskTypeRegistry({ plan: { backend: 123 } });
    expect(empty.status).toBe('empty');
    expect(invalid.status).toBe('invalid');
    expect(empty.diagnostics).toEqual([]);
    expect(invalid.diagnostics.length).toBeGreaterThan(0);
    // Both yield empty registry — callers must branch on status, not size alone.
    expect(empty.registry.size).toBe(0);
    expect(invalid.registry.size).toBe(0);
  });

  it('parses a valid registry as ok', () => {
    const r = parseTaskTypeRegistry(sampleRaw);
    expect(r.status).toBe('ok');
    expect(r.registry.size).toBe(3);
    expect(r.registry.get('plan')).toEqual({
      description: 'Produce an actionable implementation plan',
      backend: 'codex',
      model: 'gpt-5.5',
      role: 'worker',
      briefKind: 'plan',
    });
    expect(r.registry.get('implement')?.role).toBeUndefined();
    expect(r.diagnostics).toEqual([]);
  });

  it('returns invalid for non-object shape', () => {
    const r = parseTaskTypeRegistry('not-an-object');
    expect(r.status).toBe('invalid');
    expect(r.registry.size).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it('returns invalid for unknown entry keys', () => {
    const r = parseTaskTypeRegistry({
      plan: { backend: 'codex', extra: true },
    });
    expect(r.status).toBe('invalid');
    expect(r.registry.size).toBe(0);
    expect(r.diagnostics.some((d) => d.code === 'unknown_key')).toBe(true);
  });

  it('returns invalid for bad type id', () => {
    const r = parseTaskTypeRegistry({
      'Bad Id': { backend: 'codex' },
    });
    expect(r.status).toBe('invalid');
    expect(r.diagnostics.some((d) => d.code === 'invalid_type_id')).toBe(true);
  });

  it('returns invalid when backend missing', () => {
    const r = parseTaskTypeRegistry({
      plan: { model: 'x' },
    });
    expect(r.status).toBe('invalid');
    expect(r.registry.size).toBe(0);
  });

  it('returns invalid for oversize description', () => {
    const r = parseTaskTypeRegistry({
      plan: {
        backend: 'codex',
        description: 'x'.repeat(TASK_TYPE_DESCRIPTION_MAX + 1),
      },
    });
    expect(r.status).toBe('invalid');
  });

  it('returns invalid when exceeding max types', () => {
    const raw: Record<string, { backend: string }> = {};
    for (let i = 0; i < TASK_TYPE_MAX + 1; i++) {
      raw[`t${i}`] = { backend: 'codex' };
    }
    // t0 fails id? t0 is valid ([a-z][a-z0-9_-]*). Good.
    const r = parseTaskTypeRegistry(raw);
    expect(r.status).toBe('invalid');
    expect(r.diagnostics.some((d) => d.code === 'too_many_types')).toBe(true);
  });

  it('returns invalid for bad role / briefKind', () => {
    expect(
      parseTaskTypeRegistry({ plan: { backend: 'codex', role: 'boss' } }).status,
    ).toBe('invalid');
    expect(
      parseTaskTypeRegistry({ plan: { backend: 'codex', briefKind: 'nope' } }).status,
    ).toBe('invalid');
  });

  it('bounds diagnostic count and message length', () => {
    const hugeId = `Bad${'x'.repeat(500)}`;
    const raw: Record<string, unknown> = {
      [hugeId]: { backend: 'codex' },
    };
    // Stay under TASK_TYPE_MAX so we exercise per-entry diagnostics, not too_many_types.
    for (let i = 0; i < 20; i++) {
      raw[`t${i}`] = {
        backend: 'codex',
        extraA: true,
        extraB: true,
        extraC: true,
      };
    }
    const r = parseTaskTypeRegistry(raw);
    expect(r.status).toBe('invalid');
    expect(r.diagnostics.length).toBeLessThanOrEqual(TASK_TYPE_DIAGNOSTIC_MAX);
    expect(r.diagnostics.length).toBe(TASK_TYPE_DIAGNOSTIC_MAX);
    for (const d of r.diagnostics) {
      expect(d.message.length).toBeLessThanOrEqual(TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX);
    }
    // huge id is truncated in the message
    expect(r.diagnostics[0]?.message.length).toBeLessThanOrEqual(
      TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX,
    );
  });
});

describe('resolveCreateChildSpec', () => {
  const ok = parseTaskTypeRegistry(sampleRaw);

  it('resolves preset only (backend/model/role/kind)', () => {
    const r = resolveCreateChildSpec({ taskType: 'plan' }, ok);
    expect(r).toEqual({
      ok: true,
      resolved: {
        taskType: 'plan',
        backend: 'codex',
        model: 'gpt-5.5',
        role: 'worker',
        briefKind: 'plan',
      },
    });
  });

  it('defaults role to worker and briefKind to generic', () => {
    const reg = parseTaskTypeRegistry({ bare: { backend: 'opencode' } });
    const r = resolveCreateChildSpec({ taskType: 'bare' }, reg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.role).toBe('worker');
    expect(r.resolved.briefKind).toBe('generic');
    expect(r.resolved.model).toBeUndefined();
  });

  it('explicit model wins', () => {
    const r = resolveCreateChildSpec(
      { taskType: 'plan', model: 'gpt-special' },
      ok,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.model).toBe('gpt-special');
    expect(r.resolved.backend).toBe('codex');
  });

  it('backend change without model clears preset model', () => {
    const r = resolveCreateChildSpec(
      { taskType: 'plan', backend: 'grok' },
      ok,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.backend).toBe('grok');
    expect(r.resolved.model).toBeUndefined();
  });

  it('backend change with explicit model keeps explicit model', () => {
    const r = resolveCreateChildSpec(
      { taskType: 'plan', backend: 'grok', model: 'grok-4.5' },
      ok,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved).toMatchObject({
      backend: 'grok',
      model: 'grok-4.5',
    });
  });

  it('explicit role wins', () => {
    const r = resolveCreateChildSpec(
      { taskType: 'implement', role: 'coordinator' },
      ok,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.role).toBe('coordinator');
  });

  it('unknown type fails even with backend override', () => {
    const r = resolveCreateChildSpec(
      { taskType: 'nope', backend: 'codex' },
      ok,
    );
    expect(r).toEqual({
      ok: false,
      code: 'unknown_task_type',
      message: 'Unknown task type "nope"',
    });
  });

  it('bounds oversized unknown taskType in error message', () => {
    const huge = `nope${'x'.repeat(500)}`;
    const r = resolveCreateChildSpec({ taskType: huge }, ok);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('unknown_task_type');
    expect(r.message.length).toBeLessThanOrEqual(TASK_TYPE_DIAGNOSTIC_MESSAGE_MAX);
  });

  it('empty registry → task_types_not_configured', () => {
    const empty = parseTaskTypeRegistry({});
    const r = resolveCreateChildSpec({ taskType: 'plan' }, empty);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('task_types_not_configured');
  });

  it('invalid registry → invalid_task_type_config (distinct from empty)', () => {
    const inv = parseTaskTypeRegistry({ bad: { backend: 1 } });
    expect(inv.status).toBe('invalid');
    const r = resolveCreateChildSpec({ taskType: 'plan' }, inv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid_task_type_config');
  });

  it('no partial resolve on unknown type', () => {
    const r = resolveCreateChildSpec({ taskType: 'missing' }, ok);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect('resolved' in r).toBe(false);
  });
});

describe('summarizeTaskTypes', () => {
  it('returns empty list + diagnostics when invalid', () => {
    const inv = parseTaskTypeRegistry({ x: { backend: 1 } });
    const s = summarizeTaskTypes(inv);
    expect(s.taskTypes).toEqual([]);
    expect(s.diagnostics.length).toBeGreaterThan(0);
  });

  it('summarizes ok registry sorted by id', () => {
    const ok = parseTaskTypeRegistry(sampleRaw);
    const s = summarizeTaskTypes(ok, (b) =>
      b === 'codex' ? 'available' : 'unknown',
    );
    expect(s.taskTypes.map((t) => t.id)).toEqual([
      'coordinate',
      'implement',
      'plan',
    ]);
    expect(s.taskTypes.find((t) => t.id === 'plan')).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.5',
      defaultRole: 'worker',
      defaultBriefKind: 'plan',
      availability: 'available',
    });
  });
});
