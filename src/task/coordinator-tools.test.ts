import { describe, expect, it } from 'vitest';
import {
  dispatch,
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from './coordinator-tools';
import type { CredentialContext } from '../bridge/credentials';

function ctx(actions: string[]): CredentialContext {
  return {
    credentialId: 'c1',
    rootId: 'root',
    callerTaskId: 'task-1',
    turnId: 'turn-1',
    allowedActions: new Set(actions as import('./capabilities').ToolAction[]),
    expiry: Date.now() + 60_000,
  };
}

describe('coordinator-tools dispatch', () => {
  it('maps a valid presentation upsert owned by the caller to ToolCommand', () => {
    const result = dispatch(
      'upsert_presentation',
      {
        presentationId: 'release-notes',
        ownerTaskId: 'task-1',
        opId: 'op-present-1',
        revision: 1,
        title: 'Release notes',
        markdown: '# Ready',
      },
      ctx(['upsert_presentation']),
    );

    expect(result).toEqual({
      ok: true,
      command: {
        kind: 'upsert_presentation',
        presentationId: 'release-notes',
        ownerTaskId: 'task-1',
        opId: 'op-present-1',
        revision: 1,
        title: 'Release notes',
        markdown: '# Ready',
      },
    });
  });

  it('returns the stable unauthorized code when presentation capability is absent', () => {
    const result = dispatch(
      'upsert_presentation',
      {
        presentationId: 'release-notes',
        ownerTaskId: 'task-1',
        opId: 'op-present-1',
        revision: 1,
        title: 'Release notes',
        markdown: '# Ready',
      },
      ctx([]),
    );

    expect(result).toEqual({ ok: false, toolError: 'unauthorized' });
  });

  it('returns invalid_arguments for a non-object presentation payload', () => {
    const result = dispatch('upsert_presentation', null, ctx(['upsert_presentation']));

    expect(result).toEqual({ ok: false, toolError: 'invalid_arguments' });
  });

  it('rejects a presentation owner that does not match the credential caller', () => {
    const result = dispatch(
      'upsert_presentation',
      {
        presentationId: 'release-notes',
        ownerTaskId: 'task-forged',
        opId: 'op-present-1',
        revision: 1,
        title: 'Release notes',
        markdown: '# Ready',
      },
      ctx(['upsert_presentation']),
    );

    expect(result).toEqual({ ok: false, toolError: 'owner_mismatch' });
  });

  it.each([
    ['unknown field', { extra: true }],
    ['invalid presentation ID', { presentationId: 'contains spaces' }],
    ['invalid owner task ID', { ownerTaskId: '../task-1' }],
    ['invalid operation ID', { opId: '' }],
    ['non-positive revision', { revision: 0 }],
    ['wrong title type', { title: 42 }],
    ['empty Markdown', { markdown: '' }],
  ])('rejects presentation arguments with %s', (_label, override) => {
    const result = dispatch(
      'upsert_presentation',
      {
        presentationId: 'release-notes',
        ownerTaskId: 'task-1',
        opId: 'op-present-1',
        revision: 1,
        title: 'Release notes',
        markdown: '# Ready',
        ...override,
      },
      ctx(['upsert_presentation']),
    );

    expect(result).toEqual({ ok: false, toolError: 'invalid_arguments' });
  });

  it.each([
    ['presentation ID', { presentationId: `p${'x'.repeat(PRESENTATION_ID_MAX_LENGTH)}` }],
    ['owner task ID', { ownerTaskId: `t${'x'.repeat(PRESENTATION_ID_MAX_LENGTH)}` }],
    ['operation ID', { opId: `o${'x'.repeat(PRESENTATION_ID_MAX_LENGTH)}` }],
    ['title', { title: 'x'.repeat(PRESENTATION_TITLE_MAX_LENGTH + 1) }],
    ['Markdown', { markdown: 'x'.repeat(PRESENTATION_MARKDOWN_MAX_LENGTH + 1) }],
  ])('rejects an oversized presentation %s without reflecting content', (_label, override) => {
    const result = dispatch(
      'upsert_presentation',
      {
        presentationId: 'release-notes',
        ownerTaskId: 'task-1',
        opId: 'op-present-1',
        revision: 1,
        title: 'Release notes',
        markdown: '# Ready',
        ...override,
      },
      ctx(['upsert_presentation']),
    );

    expect(result).toEqual({ ok: false, toolError: 'payload_too_large' });
  });

  it('maps create_task to ToolCommand', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'child goal', taskType: 'worker', backend: 'grok' },
      ctx(['create_task', 'ask_user']),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.kind).toBe('create_task');
    }
  });

  it('maps create_task model into CreateChildSpec', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'plan work', taskType: 'worker', backend: 'codex', model: 'gpt-5' },
      ctx(['create_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'create_task') {
      expect(result.command.spec.model).toBe('gpt-5');
      expect(result.command.spec.backend).toBe('codex');
    }
  });

  it('accepts opencode provider/model ids with slash', () => {
    const result = dispatch(
      'delegate_task',
      {
        opId: 'op-1',
        goal: 'fast plan', taskType: 'worker',
        backend: 'opencode',
        model: 'opencode-go/deepseek-v4-flash',
      },
      ctx(['delegate_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'delegate_task') {
      expect(result.command.spec.backend).toBe('opencode');
      expect(result.command.spec.model).toBe('opencode-go/deepseek-v4-flash');
    }
  });

  it('rejects empty-string model override (present but invalid)', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'x', taskType: 'worker', backend: 'opencode', model: '' },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });

  it('rejects non-string backend override', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'x', taskType: 'worker', backend: 123 },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });

  it('maps release_tasks to ToolCommand', () => {
    const result = dispatch(
      'release_tasks',
      { opId: 'op-rel', taskIds: ['a', 'b'], includeDependencies: true },
      ctx(['release_tasks']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'release_tasks') {
      expect(result.command.taskIds).toEqual(['a', 'b']);
      expect(result.command.includeDependencies).toBe(true);
    }
  });

  it('rejects release_tasks with empty taskIds', () => {
    const result = dispatch(
      'release_tasks',
      { opId: 'op-rel', taskIds: [] },
      ctx(['release_tasks']),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects missing opId', () => {
    const result = dispatch('start_task', { childId: 'c1' }, ctx(['start_task']));
    expect(result).toEqual({ ok: false, toolError: 'opId is required' });
  });

  it('rejects action outside allowedActions', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'g', taskType: 'worker', backend: 'grok' },
      ctx(['ask_user']),
    );
    expect(result).toEqual({ ok: false, toolError: 'action not permitted: create_task' });
  });

  it('rejects invalid known executionPolicy fields', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'child',
        taskType: 'worker',
        backend: 'grok',
        executionPolicy: { maxTurns: -1, turnTimeoutMs: 60_000 },
      },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });

  it('accepts zero maxAutomaticRetries', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'child',
        taskType: 'worker',
        backend: 'grok',
        executionPolicy: { maxAutomaticRetries: 0 },
      },
      ctx(['create_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.kind).toBe('create_task');
      if (result.command.kind === 'create_task') {
        expect(result.command.spec.executionPolicy?.maxAutomaticRetries).toBe(0);
      }
    }
  });

  it('maps rich create fields (description, brief, bindings, paths, claimsGit)', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'implement feature',
        taskType: 'worker',
        backend: 'grok',
        description: 'more context',
        brief: {
          kind: 'implement',
          acceptanceCriteria: ['tests pass'],
        },
        inputBindings: [{ fromTaskId: 'plan', output: 'summary', as: 'plan' }],
        claimsGit: true,
        writePaths: ['src/x.ts'],
        readPaths: ['docs/y.md'],
      },
      ctx(['create_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'create_task') {
      expect(result.command.spec.description).toBe('more context');
      expect(result.command.spec.brief).toEqual({
        kind: 'implement',
        acceptanceCriteria: ['tests pass'],
      });
      expect(result.command.spec.inputBindings).toEqual([
        { fromTaskId: 'plan', output: 'summary', as: 'plan' },
      ]);
      expect(result.command.spec.claimsGit).toBe(true);
      expect(result.command.spec.writePaths).toEqual(['src/x.ts']);
      expect(result.command.spec.readPaths).toEqual(['docs/y.md']);
    }
  });

  it('rejects invalid brief.kind', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'x',
        taskType: 'worker',
        backend: 'grok',
        brief: { kind: 'nope' },
      },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });

  it('rejects unknown brief keys fail-closed', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'x',
        taskType: 'worker',
        backend: 'grok',
        brief: { objective: 'o', secret: true },
      },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });

  it('rejects non-summary binding output', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'x',
        taskType: 'worker',
        backend: 'grok',
        inputBindings: [{ fromTaskId: 'p', output: 'artifact', as: 'a' }],
      },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });

  it('maps get_host_context with empty args and no opId', () => {
    const result = dispatch('get_host_context', {}, ctx(['get_host_context']));
    expect(result).toEqual({ ok: true, command: { kind: 'get_host_context' } });
  });

  it('rejects get_host_context with extra args', () => {
    const result = dispatch(
      'get_host_context',
      { foo: 1 },
      ctx(['get_host_context']),
    );
    expect(result.ok).toBe(false);
  });

  it('maps list_task_types with empty args and no opId', () => {
    const result = dispatch('list_task_types', {}, ctx(['list_task_types']));
    expect(result).toEqual({ ok: true, command: { kind: 'list_task_types' } });
  });

  it('rejects list_task_types with extra args', () => {
    const result = dispatch(
      'list_task_types',
      { foo: 1 },
      ctx(['list_task_types']),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects public create without taskType', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'child', backend: 'grok' },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });

  it('maps rich fields on delegate_task', () => {
    const result = dispatch(
      'delegate_task',
      {
        opId: 'op-d',
        goal: 'child',
        taskType: 'worker',
        backend: 'opencode',
        brief: { kind: 'plan', objective: 'write plan' },
      },
      ctx(['delegate_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'delegate_task') {
      expect(result.command.spec.brief?.kind).toBe('plan');
      expect(result.command.spec.brief?.objective).toBe('write plan');
    }
  });
});

describe('coordinator-tools batch dispatch', () => {
  it('maps a valid create_tasks batch to a command with parsed specs', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [
          { localId: 'a', goal: 'first', taskType: 'plan' },
          {
            localId: 'b',
            goal: 'second',
            taskType: 'implement',
            dependsOn: ['a'],
            inputBindings: [{ fromLocalId: 'a', output: 'summary', as: 'plan' }],
          },
        ],
      },
      ctx(['create_tasks']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'create_tasks') {
      expect(result.command.specs).toHaveLength(2);
      expect(result.command.specs[1].localId).toBe('b');
      expect(result.command.specs[1].dependsOn).toEqual(['a']);
      expect(result.command.specs[1].inputBindings).toEqual([
        { fromLocalId: 'a', output: 'summary', as: 'plan' },
      ]);
    }
  });

  it('maps delegate_tasks with a pre-existing task binding', () => {
    const result = dispatch(
      'delegate_tasks',
      {
        opId: 'op-batch',
        tasks: [
          {
            localId: 'a',
            goal: 'consume prior',
            taskType: 'implement',
            inputBindings: [{ fromTaskId: 'task-prior', output: 'summary', as: 'prior' }],
          },
        ],
      },
      ctx(['delegate_tasks']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'delegate_tasks') {
      expect(result.command.specs[0].inputBindings).toEqual([
        { fromTaskId: 'task-prior', output: 'summary', as: 'prior' },
      ]);
    }
  });

  it('rejects a batch with a duplicate localId', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [
          { localId: 'a', goal: 'x', taskType: 'plan' },
          { localId: 'a', goal: 'y', taskType: 'plan' },
        ],
      },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects dependsOn referencing an unknown localId', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [{ localId: 'a', goal: 'x', taskType: 'plan', dependsOn: ['ghost'] }],
      },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects a binding referencing an unknown sibling localId', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [
          {
            localId: 'a',
            goal: 'x',
            taskType: 'plan',
            inputBindings: [{ fromLocalId: 'ghost', output: 'summary', as: 'p' }],
          },
        ],
      },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects a binding that supplies both fromLocalId and fromTaskId', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [
          { localId: 'a', goal: 'x', taskType: 'plan' },
          {
            localId: 'b',
            goal: 'y',
            taskType: 'plan',
            inputBindings: [
              { fromLocalId: 'a', fromTaskId: 'task-x', output: 'summary', as: 'p' },
            ],
          },
        ],
      },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects a self dependsOn', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [{ localId: 'a', goal: 'x', taskType: 'plan', dependsOn: ['a'] }],
      },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects an invalid localId pattern', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [{ localId: 'Bad Id', goal: 'x', taskType: 'plan' }],
      },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects a per-item spec missing taskType', () => {
    const result = dispatch(
      'create_tasks',
      { opId: 'op-batch', tasks: [{ localId: 'a', goal: 'x' }] },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects a batch missing opId', () => {
    const result = dispatch(
      'create_tasks',
      { tasks: [{ localId: 'a', goal: 'x', taskType: 'plan' }] },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'opId is required' });
  });

  it('rejects an empty tasks array', () => {
    const result = dispatch('create_tasks', { opId: 'op-batch', tasks: [] }, ctx(['create_tasks']));
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects a batch over the 16-task cap', () => {
    const tasks = Array.from({ length: 17 }, (_, i) => ({
      localId: `t${i}`,
      goal: 'x',
      taskType: 'plan',
    }));
    const result = dispatch('create_tasks', { opId: 'op-batch', tasks }, ctx(['create_tasks']));
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
  });

  it('rejects create_tasks outside allowedActions (capability gate)', () => {
    const result = dispatch(
      'create_tasks',
      { opId: 'op-batch', tasks: [{ localId: 'a', goal: 'x', taskType: 'plan' }] },
      ctx(['ask_user']),
    );
    expect(result).toEqual({ ok: false, toolError: 'action not permitted: create_tasks' });
  });
});