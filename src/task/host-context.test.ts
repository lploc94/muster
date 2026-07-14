import { describe, expect, it } from 'vitest';
import {
  HOST_BLOCK_MAX,
  HOST_MODELS_PER_BACKEND,
  HOST_RULES_BASE,
  HOST_RULES_COORDINATOR,
  HOST_RULES_TASK_TYPES,
  HOST_RULES_WORKER,
  buildHostContext,
  formatHostContextMarkdown,
  minimalHostSnapshot,
  type HostEnvironmentSnapshot,
} from './host-context';
import type { TaskTypeSummary } from './task-types';

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

  it('when task types present: injects types, all 4 type rules, demotes backends/models', () => {
    const types: TaskTypeSummary[] = [
      {
        id: 'plan',
        backend: 'codex',
        defaultRole: 'worker',
        defaultBriefKind: 'plan',
        description: 'plan work',
        availability: 'unknown',
      },
      {
        id: 'implement',
        backend: 'grok',
        defaultRole: 'worker',
        defaultBriefKind: 'implement',
        availability: 'unknown',
      },
    ];
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: { taskId: 'root', role: 'coordinator', backend: 'opencode' },
      tools: ['create_task', 'list_task_types'],
      taskTypes: types,
      suppressBackendCatalog: true,
    });
    expect(ctx.taskTypes?.map((t) => t.id)).toEqual(['plan', 'implement']);
    expect(ctx.availableBackends).toBeUndefined();
    expect(ctx.models).toBeUndefined();
    for (const rule of HOST_RULES_TASK_TYPES) {
      expect(ctx.rules).toContain(rule);
    }
    expect(ctx.rules).toHaveLength(12);
    const md = formatHostContextMarkdown(ctx);
    expect(md).toContain('## Task types');
    expect(md).toContain('`plan`');
    expect(md).toContain('`implement`');
    for (const rule of HOST_RULES_TASK_TYPES) {
      expect(md).toContain(rule);
    }
  });

  it('empty taskTypes array still renders configure guidance', () => {
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: { taskId: 'root', role: 'coordinator', backend: 'opencode' },
      taskTypes: [],
      suppressBackendCatalog: true,
    });
    expect(ctx.taskTypes).toEqual([]);
    const md = formatHostContextMarkdown(ctx);
    expect(md).toContain('## Task types');
    expect(md).toContain('muster.taskTypes');
  });

  it('get_host_context path keeps backends when types present (no suppress)', () => {
    const types: TaskTypeSummary[] = [
      {
        id: 'plan',
        backend: 'codex',
        defaultRole: 'worker',
        defaultBriefKind: 'plan',
        availability: 'available',
      },
    ];
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: { taskId: 'root', role: 'coordinator', backend: 'opencode' },
      taskTypes: types,
      // suppressBackendCatalog omitted/false → diagnostic catalogs remain
    });
    expect(ctx.taskTypes?.map((t) => t.id)).toEqual(['plan']);
    expect(ctx.availableBackends).toEqual(['opencode', 'codex']);
    expect(ctx.models).toBeDefined();
  });

  it('max 32 types retains all ids under HOST_BLOCK_MAX (descriptions may drop)', () => {
    const types: TaskTypeSummary[] = Array.from({ length: 32 }, (_, i) => ({
      id: `t${i}`,
      backend: 'codex',
      defaultRole: 'worker' as const,
      defaultBriefKind: 'generic',
      description: 'x'.repeat(200),
      availability: 'unknown' as const,
    }));
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: { taskId: 'root', role: 'coordinator', backend: 'opencode', goal: 'g'.repeat(500) },
      taskTypes: types,
      suppressBackendCatalog: true,
    });
    const md = formatHostContextMarkdown(ctx);
    expect(md.length).toBeLessThanOrEqual(HOST_BLOCK_MAX);
    for (let i = 0; i < 32; i++) {
      expect(md).toContain(`\`t${i}\``);
    }
    for (const rule of HOST_RULES_TASK_TYPES) {
      expect(md).toContain(rule);
    }
  });

  it('worker first prompt has no task-type create catalog', () => {
    const types: TaskTypeSummary[] = [
      {
        id: 'plan',
        backend: 'codex',
        defaultRole: 'worker',
        defaultBriefKind: 'plan',
        availability: 'unknown',
      },
    ];
    const ctx = buildHostContext({
      snapshot: baseSnapshot(),
      self: { taskId: 'c', role: 'worker', backend: 'opencode' },
      taskTypes: types,
    });
    expect(ctx.taskTypes).toBeUndefined();
    const md = formatHostContextMarkdown(ctx);
    expect(md).not.toContain('## Task types');
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
