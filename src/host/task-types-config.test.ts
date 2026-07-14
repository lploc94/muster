import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import {
  TASK_TYPES_CONFIG_KEY,
  TASK_TYPES_CONFIG_SECTION,
  loadTaskTypeRegistry,
  readTaskTypeRegistryFromRaw,
} from './task-types-config';

const props = packageJson.contributes.configuration.properties;

describe('task-types host config', () => {
  it('contributes muster.taskTypes as resource-scoped object', () => {
    const entry = props['muster.taskTypes'] as {
      type: string;
      default: unknown;
      scope?: string;
    };
    expect(entry.type).toBe('object');
    expect(entry.default).toEqual({});
    expect(entry.scope).toBe('resource');
    expect(TASK_TYPES_CONFIG_SECTION).toBe('muster');
    expect(TASK_TYPES_CONFIG_KEY).toBe('taskTypes');
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
});
