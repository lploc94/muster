import { describe, expect, it } from 'vitest';
import {
  HOST_BLOCK_MAX,
  HOST_MODELS_PER_BACKEND,
  HOST_RULES_BASE,
  HOST_RULES_COORDINATOR,
  HOST_RULES_WORKER,
  buildHostContext,
  formatHostContextMarkdown,
  minimalHostSnapshot,
  type HostEnvironmentSnapshot,
} from './host-context';

const baseSnapshot = (): HostEnvironmentSnapshot => ({
  cwd: '/workspace',
  trusted: true,
  availableBackends: ['opencode', 'codex'],
  models: {
    opencode: {
      current: 'deepseek-v4-flash',
      options: [
        { value: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { value: 'gpt-4.1', name: 'GPT-4.1' },
      ],
    },
    codex: {
      options: [{ value: 'o3', name: 'o3' }],
    },
  },
});

describe('buildHostContext', () => {
  it('coordinator includes backends, models, tools and playbook rules', () => {
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: {
        taskId: 'root',
        role: 'coordinator',
        backend: 'opencode',
        model: 'deepseek-v4-flash',
        goal: 'Ship feature',
      },
      tools: ['create_task', 'wait_for_tasks', 'set_task_lifecycle'],
    });
    expect(ctx.version).toBe(1);
    expect(ctx.workspace).toEqual({ cwd: '/workspace', trusted: true });
    expect(ctx.availableBackends).toEqual(['opencode', 'codex']);
    expect(ctx.models?.opencode?.current).toBe('deepseek-v4-flash');
    expect(ctx.tools).toContain('set_task_lifecycle');
    expect(ctx.scope).toBeUndefined();
    expect(ctx.rules).toEqual([...HOST_RULES_BASE, ...HOST_RULES_COORDINATOR]);
  });

  it('worker omits backends/models/tools and includes scope', () => {
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: {
        taskId: 'child-1',
        role: 'worker',
        backend: 'opencode',
        parentTaskId: 'root',
      },
      tools: ['create_task'],
    });
    expect(ctx.availableBackends).toBeUndefined();
    expect(ctx.models).toBeUndefined();
    expect(ctx.tools).toBeUndefined();
    expect(ctx.scope).toEqual({
      singleTask: true,
      completeVia: 'complete_task',
      doNot: expect.arrayContaining(['create siblings or pick next work']),
    });
    expect(ctx.rules).toEqual([...HOST_RULES_BASE, ...HOST_RULES_WORKER]);
  });

  it('taskCwd overrides snapshot.cwd', () => {
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: { taskId: 't', role: 'worker', backend: 'codex' },
      taskCwd: '/task/cwd',
    });
    expect(ctx.workspace.cwd).toBe('/task/cwd');
  });

  it('caps model options per backend', () => {
    const many = Array.from({ length: HOST_MODELS_PER_BACKEND + 5 }, (_, i) => ({
      value: `m${i}`,
      name: `Model ${i}`,
    }));
    const snap = baseSnapshot();
    snap.models.opencode = { options: many };
    const ctx = buildHostContext({
      snapshot: snap,
      self: { taskId: 'r', role: 'coordinator', backend: 'opencode' },
    });
    expect(ctx.models?.opencode?.options).toHaveLength(HOST_MODELS_PER_BACKEND);
  });
});

describe('formatHostContextMarkdown', () => {
  it('renders coordinator sections in order', () => {
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: {
        taskId: 'root',
        role: 'coordinator',
        backend: 'opencode',
        model: 'deepseek-v4-flash',
      },
      tools: ['create_task', 'release_tasks'],
    });
    const md = formatHostContextMarkdown(ctx);
    expect(md.startsWith('# Muster host context')).toBe(true);
    expect(md).toContain('## Workspace');
    expect(md).toContain('## Self');
    expect(md).toContain('## Rules');
    expect(md).toContain('## Available backends');
    expect(md).toContain('## Models');
    expect(md).toContain('## Tools');
    expect(md).toContain('`create_task`');
    expect(md).not.toContain('## Scope');
    // Exact base rule bullets present
    for (const rule of HOST_RULES_BASE) {
      expect(md).toContain(rule);
    }
  });

  it('renders worker scope without backends', () => {
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: {
        taskId: 'w1',
        role: 'worker',
        backend: 'opencode',
        parentTaskId: 'root',
      },
    });
    const md = formatHostContextMarkdown(ctx);
    expect(md).toContain('## Scope');
    expect(md).toContain('single task');
    expect(md).not.toContain('## Available backends');
    expect(md).not.toContain('## Models');
    for (const rule of HOST_RULES_WORKER) {
      expect(md).toContain(rule);
    }
  });

  it('stays within HOST_BLOCK_MAX', () => {
    const options = Array.from({ length: HOST_MODELS_PER_BACKEND }, (_, i) => ({
      value: `model-${i}-${'x'.repeat(200)}`,
      name: `Very Long Model Name ${i} ${'y'.repeat(200)}`,
    }));
    const snap: HostEnvironmentSnapshot = {
      cwd: '/w',
      trusted: false,
      availableBackends: ['a', 'b', 'c', 'd', 'e'],
      models: {
        a: { current: 'c', options },
        b: { options },
        c: { options },
      },
    };
    const ctx = buildHostContext({
      snapshot: snap,
      self: { taskId: 'r', role: 'coordinator', backend: 'a' },
      tools: Array.from({ length: 20 }, (_, i) => `tool_${i}`),
    });
    const md = formatHostContextMarkdown(ctx);
    expect(md.length).toBeLessThanOrEqual(HOST_BLOCK_MAX);
  });
});

describe('minimalHostSnapshot', () => {
  it('empty backends/models with given trust', () => {
    expect(minimalHostSnapshot('/x', true)).toEqual({
      cwd: '/x',
      trusted: true,
      availableBackends: [],
      models: {},
    });
  });
});
