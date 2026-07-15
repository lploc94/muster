import { describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import {
  MUSTER_DEFAULT_TASK_TYPES,
  buildTaskTypesSettingsSnapshot,
  handleTaskTypesSettingsUpdateAction,
  loadTaskTypeRegistry,
  persistTaskTypesUpdate,
  pickExplicitTaskTypesValue,
  readTaskTypeRegistryFromRaw,
  rowsToTaskTypesMap,
  validateTaskTypesUpdate,
} from './task-types-config';

const props = packageJson.contributes.configuration.properties;

describe('task-types host config', () => {
  it('contributes muster.taskTypes as resource-scoped object with ship defaults', () => {
    const entry = props['muster.taskTypes'] as {
      type: string;
      default: Record<string, { backend: string }>;
      scope?: string;
    };
    expect(entry.type).toBe('object');
    expect(entry.scope).toBe('resource');
    expect(entry.default.plan?.backend).toBe('codex');
    expect(entry.default.implement?.backend).toBe('grok');
    expect(entry.default.coordinate?.backend).toBe('opencode');
    // Ship defaults omit model pins
    expect((entry.default.plan as { model?: string }).model).toBeUndefined();
    expect(MUSTER_DEFAULT_TASK_TYPES.plan?.backend).toBe('codex');
  });

  it('round-trips a valid map via mock reader', () => {
    const byCwd = new Map<string, unknown>([
      [
        '/ws/a',
        {
          plan: { backend: 'codex', model: 'gpt-5.5', briefKind: 'plan' },
        },
      ],
      [
        '/ws/b',
        {
          implement: { backend: 'grok', model: 'grok-4.5' },
        },
      ],
    ]);

    const readRaw = (cwd?: string) => byCwd.get(cwd ?? '') ?? {};

    const a = loadTaskTypeRegistry(readRaw, '/ws/a');
    expect(a.status).toBe('ok');
    expect(a.registry.has('plan')).toBe(true);
    expect(a.registry.has('implement')).toBe(false);

    const b = loadTaskTypeRegistry(readRaw, '/ws/b');
    expect(b.status).toBe('ok');
    expect(b.registry.has('implement')).toBe(true);
    expect(b.registry.has('plan')).toBe(false);
  });

  it('malformed setting → invalid status with non-empty diagnostics', () => {
    const r = readTaskTypeRegistryFromRaw({
      plan: { backend: 123 },
    });
    expect(r.status).toBe('invalid');
    expect(r.registry.size).toBe(0);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it('empty / missing → empty (not invalid)', () => {
    expect(readTaskTypeRegistryFromRaw(undefined).status).toBe('empty');
    expect(readTaskTypeRegistryFromRaw({}).status).toBe('empty');
    expect(loadTaskTypeRegistry(() => undefined).status).toBe('empty');
  });

  it('read throw → invalid, not empty', () => {
    const r = loadTaskTypeRegistry(() => {
      throw new Error('boom');
    });
    expect(r.status).toBe('invalid');
    expect(r.diagnostics.some((d) => d.code === 'read_failed')).toBe(true);
  });

  it('builds settings snapshot with defaults and constraints', () => {
    const snap = buildTaskTypesSettingsSnapshot(() => MUSTER_DEFAULT_TASK_TYPES);
    expect(snap.status).toBe('ok');
    expect(snap.types.map((t) => t.id).sort()).toEqual(
      Object.keys(MUSTER_DEFAULT_TASK_TYPES).sort(),
    );
    expect(snap.defaults.length).toBeGreaterThan(0);
    expect(snap.constraints.maxTypes).toBe(32);
    expect(snap.types.find((t) => t.id === 'plan')?.model).toBeUndefined();
  });

  it('validate accepts ship defaults map and row list', () => {
    expect(validateTaskTypesUpdate(MUSTER_DEFAULT_TASK_TYPES)).toEqual({ ok: true });
    expect(
      validateTaskTypesUpdate({
        types: [
          {
            id: 'plan',
            backend: 'codex',
            role: 'worker',
            briefKind: 'plan',
            description: 'plan work',
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it('validate rejects malformed map', () => {
    const r = validateTaskTypesUpdate({ plan: { backend: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid_task_type_config');
  });

  it('rowsToTaskTypesMap round-trips model pins', () => {
    const map = rowsToTaskTypesMap([
      {
        id: 'plan',
        backend: 'codex',
        model: 'gpt-5.5',
        role: 'worker',
        briefKind: 'plan',
      },
    ]);
    expect(map.plan).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.5',
      role: 'worker',
      briefKind: 'plan',
    });
  });

  it('persist writes validated map to configuration', async () => {
    const update = vi.fn(async () => {});
    const result = await persistTaskTypesUpdate(
      { update },
      {
        types: [
          {
            id: 'plan',
            backend: 'codex',
            role: 'worker',
            briefKind: 'plan',
            model: 'gpt-5.5',
          },
        ],
      },
      1,
    );
    expect(result).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith(
      'taskTypes',
      expect.objectContaining({
        plan: expect.objectContaining({ backend: 'codex', model: 'gpt-5.5' }),
      }),
      1,
    );
  });

  it('handle update action returns result + snapshot on success', async () => {
    let stored: unknown = {};
    const messages = await handleTaskTypesSettingsUpdateAction(
      {
        update: async (_k, value) => {
          stored = value;
        },
      },
      MUSTER_DEFAULT_TASK_TYPES,
      1,
      () => stored,
    );
    expect(messages[0]).toMatchObject({
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: true },
    });
    expect(messages[1]?.type).toBe('taskTypesSettingsSnapshot');
  });

  it('handle update does not write on invalid input', async () => {
    const update = vi.fn();
    const messages = await handleTaskTypesSettingsUpdateAction(
      { update },
      { bad: { backend: 1 } },
      1,
      () => ({}),
    );
    expect(update).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: false, code: 'invalid_task_type_config' },
    });
  });

  it('pickExplicitTaskTypesValue prefers workspace {} over package defaults', () => {
    expect(
      pickExplicitTaskTypesValue({
        workspaceValue: {},
        defaultValue: MUSTER_DEFAULT_TASK_TYPES,
      }),
    ).toEqual({});
    expect(
      pickExplicitTaskTypesValue({
        defaultValue: MUSTER_DEFAULT_TASK_TYPES,
      }),
    ).toEqual(MUSTER_DEFAULT_TASK_TYPES);
  });

  it('pickExplicitTaskTypesValue seeds shipped defaults when no scope is set (stale manifest)', () => {
    // Nothing explicit and `inspect().defaultValue` is undefined (stale/not-yet-registered
    // manifest). Seed the baked-in defaults instead of an empty/undefined map so the panel
    // stays valid and create/delegate is not blocked.
    expect(pickExplicitTaskTypesValue({})).toEqual(MUSTER_DEFAULT_TASK_TYPES);
    expect(
      pickExplicitTaskTypesValue({
        workspaceFolderValue: undefined,
        workspaceValue: undefined,
        globalValue: undefined,
        defaultValue: undefined,
      }),
    ).toEqual(MUSTER_DEFAULT_TASK_TYPES);
    // An explicit `{}` at any scope is still a deliberate opt-out — never re-seeded,
    // even when defaultValue is absent.
    expect(pickExplicitTaskTypesValue({ globalValue: {} })).toEqual({});
    expect(pickExplicitTaskTypesValue({ workspaceValue: {} })).toEqual({});
  });

  it('validate rejects invalid role / briefKind / duplicate ids (no silent normalize)', () => {
    expect(
      validateTaskTypesUpdate({
        types: [{ id: 'plan', backend: 'codex', role: 'boss', briefKind: 'plan' }],
      }).ok,
    ).toBe(false);
    expect(
      validateTaskTypesUpdate({
        types: [{ id: 'plan', backend: 'codex', role: 'worker', briefKind: 'nope' }],
      }).ok,
    ).toBe(false);
    expect(
      validateTaskTypesUpdate({
        types: [
          { id: 'plan', backend: 'codex', role: 'worker', briefKind: 'plan' },
          { id: 'plan', backend: 'grok', role: 'worker', briefKind: 'implement' },
        ],
      }).ok,
    ).toBe(false);
  });

  it('validate rejects special invalid ids like __proto__', () => {
    const r = validateTaskTypesUpdate({
      types: [{ id: '__proto__', backend: 'codex', role: 'worker', briefKind: 'plan' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid_task_type_config');
  });
});
