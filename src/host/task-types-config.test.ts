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
  sanitizeTaskTypesUpdateError,
  validateTaskTypesUpdate,
} from './task-types-config';

/** VS Code ConfigurationTarget.Workspace — custom Settings writes this target only. */
const CONFIGURATION_TARGET_WORKSPACE = 2;

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
    expect(entry.default.explore).toMatchObject({
      backend: 'opencode',
      briefKind: 'research',
    });
    // Ship defaults omit model pins
    expect((entry.default.plan as { model?: string }).model).toBeUndefined();
    expect((entry.default.explore as { model?: string }).model).toBeUndefined();
    expect(MUSTER_DEFAULT_TASK_TYPES.plan?.backend).toBe('codex');
    expect(MUSTER_DEFAULT_TASK_TYPES.explore?.backend).toBe('opencode');
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

  it('rowsToTaskTypesMap round-trips model pins and fallback chains', () => {
    const map = rowsToTaskTypesMap([
      {
        id: 'plan',
        backend: 'codex',
        model: 'gpt-5.5',
        fallbacks: [{ backend: 'opencode' }, { backend: 'grok', model: 'grok-4' }],
        role: 'worker',
        briefKind: 'plan',
      },
    ]);
    expect(map.plan).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.5',
      fallbacks: [{ backend: 'opencode' }, { backend: 'grok', model: 'grok-4' }],
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

  it('buildTaskTypesSettingsSnapshot surfaces empty status with no diagnostics', () => {
    const snap = buildTaskTypesSettingsSnapshot(() => ({}));
    expect(snap.status).toBe('empty');
    expect(snap.types).toEqual([]);
    expect(snap.diagnostics).toEqual([]);
    expect(snap.defaults.length).toBeGreaterThan(0);
  });

  it('buildTaskTypesSettingsSnapshot surfaces invalid diagnostics without types', () => {
    const snap = buildTaskTypesSettingsSnapshot(() => ({
      plan: { backend: 123 },
    }));
    expect(snap.status).toBe('invalid');
    expect(snap.types).toEqual([]);
    expect(snap.diagnostics.length).toBeGreaterThan(0);
    expect(snap.diagnostics[0]?.message.length).toBeGreaterThan(0);
  });

  it('persist writes validated map using ConfigurationTarget.Workspace only', async () => {
    const update = vi.fn(async () => {});
    const result = await persistTaskTypesUpdate(
      { update },
      MUSTER_DEFAULT_TASK_TYPES,
      CONFIGURATION_TARGET_WORKSPACE,
    );
    expect(result).toEqual({ ok: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      'taskTypes',
      expect.objectContaining({
        plan: expect.objectContaining({ backend: 'codex' }),
      }),
      CONFIGURATION_TARGET_WORKSPACE,
    );
    // Never Global (1) or WorkspaceFolder (3) from the custom Settings path.
    expect(update.mock.calls[0]?.[2]).toBe(CONFIGURATION_TARGET_WORKSPACE);
  });

  it('sanitizeTaskTypesUpdateError strips raw host exceptions', () => {
    const result = sanitizeTaskTypesUpdateError(
      new Error('EACCES /Users/secret/settings.json path=/home/private'),
    );
    expect(result).toEqual({
      ok: false,
      code: 'updateFailed',
      message: 'Unable to update muster.taskTypes.',
    });
    expect(JSON.stringify(result)).not.toMatch(/EACCES|secret|private/i);
  });

  it('persist sanitizes write failures and does not claim success', async () => {
    const update = vi.fn(async () => {
      throw new Error('EPERM /tmp/secret-workspace/.vscode/settings.json');
    });
    const result = await persistTaskTypesUpdate(
      { update },
      MUSTER_DEFAULT_TASK_TYPES,
      CONFIGURATION_TARGET_WORKSPACE,
    );
    expect(result).toEqual({
      ok: false,
      code: 'updateFailed',
      message: 'Unable to update muster.taskTypes.',
    });
    expect(JSON.stringify(result)).not.toMatch(/EPERM|secret-workspace/i);
  });

  it('handle update action omits snapshot on write failure (saved state unchanged)', async () => {
    let stored: unknown = { plan: { backend: 'codex', role: 'worker', briefKind: 'plan' } };
    const messages = await handleTaskTypesSettingsUpdateAction(
      {
        update: async () => {
          throw new Error('disk full /Users/secret');
        },
      },
      MUSTER_DEFAULT_TASK_TYPES,
      CONFIGURATION_TARGET_WORKSPACE,
      () => stored,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: false, code: 'updateFailed', message: 'Unable to update muster.taskTypes.' },
    });
    // Host storage untouched — success-then-snapshot only.
    expect(stored).toEqual({ plan: { backend: 'codex', role: 'worker', briefKind: 'plan' } });
  });

  it('handle update action returns result then snapshot on Workspace success', async () => {
    let stored: unknown = {};
    const update = vi.fn(async (_k: string, value: unknown, target: unknown) => {
      expect(target).toBe(CONFIGURATION_TARGET_WORKSPACE);
      stored = value;
    });
    const messages = await handleTaskTypesSettingsUpdateAction(
      { update },
      MUSTER_DEFAULT_TASK_TYPES,
      CONFIGURATION_TARGET_WORKSPACE,
      () => stored,
    );
    expect(update).toHaveBeenCalledWith(
      'taskTypes',
      expect.any(Object),
      CONFIGURATION_TARGET_WORKSPACE,
    );
    expect(messages[0]).toMatchObject({
      type: 'taskTypesSettingsUpdateResult',
      result: { ok: true },
    });
    expect(messages[1]?.type).toBe('taskTypesSettingsSnapshot');
    if (messages[1]?.type === 'taskTypesSettingsSnapshot') {
      expect(messages[1].snapshot.status).toBe('ok');
      expect(messages[1].snapshot.types.length).toBeGreaterThan(0);
    }
  });
});
