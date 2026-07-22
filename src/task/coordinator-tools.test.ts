import { describe, expect, it } from 'vitest';
import {
  dispatch,
  PRESENTATION_ID_MAX_LENGTH,
  PRESENTATION_MARKDOWN_MAX_LENGTH,
  PRESENTATION_TITLE_MAX_LENGTH,
} from './coordinator-tools';
import type { CredentialContext } from '../bridge/credentials';
import { normalizeVerdict } from './verdict';
import { DEFAULT_WORKFLOW_POLICY } from './workflow';

function ctx(actions: string[]): CredentialContext {
  return {
    credentialId: 'c1',
    rootId: 'root',
    callerTaskId: 'task-1',
    turnId: 'turn-1',
    attemptId: 'attempt-1',
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
      ctx(['create_task', 'complete_task']),
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

  it('maps delegate_task waitForCompletion', () => {
    const result = dispatch(
      'delegate_task',
      { opId: 'op-1', goal: 'g', taskType: 'worker', waitForCompletion: true },
      ctx(['delegate_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'delegate_task') {
      expect(result.command.waitForCompletion).toBe(true);
    }
  });

  it('maps release_tasks waitForTaskIds', () => {
    const result = dispatch(
      'release_tasks',
      { opId: 'op-rel', taskIds: ['a', 'b'], waitForTaskIds: ['b'] },
      ctx(['release_tasks']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'release_tasks') {
      expect(result.command.waitForTaskIds).toEqual(['b']);
    }
  });

  it('maps delegate_tasks waitForLocalIds and rejects unknown localId', () => {
    const ok = dispatch(
      'delegate_tasks',
      {
        opId: 'op-1',
        waitForLocalIds: ['a'],
        tasks: [{ localId: 'a', goal: 'x', taskType: 'worker' }],
      },
      ctx(['delegate_tasks']),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.command.kind === 'delegate_tasks') {
      expect(ok.command.waitForLocalIds).toEqual(['a']);
    }
    const bad = dispatch(
      'delegate_tasks',
      {
        opId: 'op-1',
        waitForLocalIds: ['ghost'],
        tasks: [{ localId: 'a', goal: 'x', taskType: 'worker' }],
      },
      ctx(['delegate_tasks']),
    );
    expect(bad.ok).toBe(false);
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
    const result = dispatch('complete_task', { summary: 'done' }, ctx(['complete_task']));
    expect(result).toEqual({ ok: false, toolError: 'opId is required' });
  });

  it('maps define_workflow and start_workflow to ToolCommands and rejects malformed payloads', () => {
    const topology = {
      kind: 'one_node_v1',
      entryNodeId: 'entry',
      nodes: [{ nodeId: 'entry' }],
    };
    const defined = dispatch(
      'define_workflow',
      {
        opId: 'op-def-1',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology,
        entryContracts: [],
        policy: DEFAULT_WORKFLOW_POLICY,
      },
      ctx(['define_workflow']),
    );
    expect(defined).toEqual({
      ok: true,
      command: {
        kind: 'define_workflow',
        opId: 'op-def-1',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology,
        entryContracts: [],
        policy: DEFAULT_WORKFLOW_POLICY,
      },
    });

    const started = dispatch(
      'start_workflow',
      {
        opId: 'op-start-1',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'idem-1',
        goal: 'run one-node',
        backend: 'grok',
        entryInputs: [],
      },
      ctx(['start_workflow']),
    );
    expect(started).toEqual({
      ok: true,
      command: {
        kind: 'start_workflow',
        opId: 'op-start-1',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'idem-1',
        goal: 'run one-node',
        backend: 'grok',
        entryInputs: [],
      },
    });

    const unauthorized = dispatch(
      'define_workflow',
      {
        opId: 'op-def-2',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology,
      },
      ctx(['complete_task']),
    );
    expect(unauthorized).toEqual({
      ok: false,
      toolError: 'action not permitted: define_workflow',
    });

    const missingKey = dispatch(
      'start_workflow',
      {
        opId: 'op-start-2',
        definitionId: 'wf-one',
        version: 1,
      },
      ctx(['start_workflow']),
    );
    expect(missingKey.ok).toBe(false);

    const badTopology = dispatch(
      'define_workflow',
      {
        opId: 'op-def-3',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology: { kind: 'two_node_v1' },
      },
      ctx(['define_workflow']),
    );
    expect(badTopology.ok).toBe(false);
  });

  it('rejects action outside allowedActions', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'g', taskType: 'worker', backend: 'grok' },
      ctx(['complete_task']),
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

  it('maps brief.skills into CreateChildSpec (raw string array, no normalization here)', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'implement feature',
        taskType: 'worker',
        backend: 'grok',
        brief: { kind: 'implement', skills: ['plan', 'review'] },
      },
      ctx(['create_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'create_task') {
      expect(result.command.spec.brief).toEqual({
        kind: 'implement',
        skills: ['plan', 'review'],
      });
    }
  });

  it('rejects brief.skills that is not a string array', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-1',
        goal: 'x',
        taskType: 'worker',
        backend: 'grok',
        brief: { skills: [1, 2] },
      },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
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

  it('threads an explicit requiredVerdict through a batch child dependency (verify-gate-loop C)', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [
          {
            localId: 'ship',
            goal: 'ship it',
            taskType: 'implement',
            dependencies: [
              {
                taskId: 'task-verify',
                requiredOutcome: 'succeeded',
                onUnsatisfied: 'block',
                requiredVerdict: 'pass',
              },
            ],
          },
        ],
      },
      ctx(['create_tasks']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'create_tasks') {
      expect(result.command.specs[0].dependencies).toEqual([
        {
          taskId: 'task-verify',
          requiredOutcome: 'succeeded',
          onUnsatisfied: 'block',
          requiredVerdict: 'pass',
        },
      ]);
    }
  });

  it('rejects a batch child dependency with an invalid requiredVerdict (fail-closed)', () => {
    const result = dispatch(
      'create_tasks',
      {
        opId: 'op-batch',
        tasks: [
          {
            localId: 'ship',
            goal: 'ship it',
            taskType: 'implement',
            dependencies: [
              {
                taskId: 'task-verify',
                requiredOutcome: 'succeeded',
                onUnsatisfied: 'block',
                requiredVerdict: 'fail',
              },
            ],
          },
        ],
      },
      ctx(['create_tasks']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_tasks arguments' });
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
      ctx(['complete_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'action not permitted: create_tasks' });
  });
});

describe('complete_task verdict parsing', () => {
  function completeCommand(args: Record<string, unknown>) {
    const result = dispatch('complete_task', args, ctx(['complete_task']));
    if (!result.ok) throw new Error(result.toolError);
    if (result.command.kind !== 'complete_task') throw new Error('wrong command');
    return result.command;
  }

  it('completes without a verdict (backward-compatible, no verdict key)', () => {
    const command = completeCommand({ opId: 'op-c', result: 'done' });
    expect(command).toEqual({ kind: 'complete_task', opId: 'op-c', result: 'done' });
    expect('verdict' in command).toBe(false);
  });

  it('carries a structured verdict input through the command', () => {
    const command = completeCommand({
      opId: 'op-c',
      result: 'done',
      verdict: {
        status: 'pass',
        rationale: 'all checks passed',
        criteria: [{ label: 'builds', status: 'pass' }],
      },
    });
    expect(command.verdict).toEqual({
      status: 'pass',
      rationale: 'all checks passed',
      criteria: [{ label: 'builds', status: 'pass' }],
    });
  });

  it('never rejects the call for a malformed verdict; normalizes to inconclusive', () => {
    const command = completeCommand({
      opId: 'op-c',
      result: 'done',
      verdict: { status: 'garbage', rationale: 'unknown' },
    });
    // Parse keeps the raw token; normalization at seal time fail-closes it.
    const normalized = normalizeVerdict(command.verdict, { at: 't0' });
    expect(normalized?.status).toBe('inconclusive');
    expect(normalized?.rationale).toBe('unknown');
  });

  it('ignores a non-object verdict arg (treated as no verdict)', () => {
    const command = completeCommand({ opId: 'op-c', result: 'done', verdict: 'pass' });
    expect(command.verdict).toBeUndefined();
  });

  it('still requires result when a verdict is present', () => {
    const result = dispatch(
      'complete_task',
      { opId: 'op-c', verdict: { status: 'pass' } },
      ctx(['complete_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'result is required' });
  });
});

describe('parseDependency requiredVerdict', () => {
  it('accepts requiredVerdict:pass on a create_task dependency', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-d',
        goal: 'gate on verify',
        taskType: 'implement',
        dependencies: [
          { taskId: 'verify-1', requiredOutcome: 'succeeded', onUnsatisfied: 'fail', requiredVerdict: 'pass' },
        ],
      },
      ctx(['create_task']),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.command.kind !== 'create_task') return;
    expect(result.command.spec.dependencies?.[0].requiredVerdict).toBe('pass');
  });

  it('rejects an invalid requiredVerdict value (fail closed)', () => {
    const result = dispatch(
      'create_task',
      {
        opId: 'op-d',
        goal: 'g',
        taskType: 'implement',
        dependencies: [
          { taskId: 'v', requiredOutcome: 'succeeded', onUnsatisfied: 'fail', requiredVerdict: 'fail' },
        ],
      },
      ctx(['create_task']),
    );
    expect(result).toEqual({ ok: false, toolError: 'invalid create_task arguments' });
  });
});

describe('workflow_next tool surface', () => {
  it('maps workflow_next with change and optional result', () => {
    const withBody = dispatch(
      'workflow_next',
      { opId: 'op-n1', change: 'updated', result: 'producer body' },
      ctx(['workflow_next']),
    );
    expect(withBody).toEqual({
      ok: true,
      command: {
        kind: 'workflow_next',
        opId: 'op-n1',
        change: 'updated',
        result: 'producer body',
      },
    });

    const unchanged = dispatch(
      'workflow_next',
      { opId: 'op-n2', change: 'unchanged' },
      ctx(['workflow_next']),
    );
    expect(unchanged).toEqual({
      ok: true,
      command: { kind: 'workflow_next', opId: 'op-n2', change: 'unchanged' },
    });
  });

  it('rejects missing/invalid change and unauthorized callers', () => {
    expect(
      dispatch('workflow_next', { opId: 'op-n', change: 'maybe' }, ctx(['workflow_next'])),
    ).toEqual({ ok: false, toolError: 'change must be "updated" or "unchanged"' });

    expect(
      dispatch('workflow_next', { opId: 'op-n' }, ctx(['workflow_next'])),
    ).toEqual({ ok: false, toolError: 'change is required' });

    expect(
      dispatch(
        'workflow_next',
        { opId: 'op-n', change: 'updated' },
        ctx(['complete_task']),
      ),
    ).toEqual({ ok: false, toolError: 'action not permitted: workflow_next' });
  });

  it('maps workflow_prev with all or non-empty targets and optional note', () => {
    expect(
      dispatch(
        'workflow_prev',
        { opId: 'op-p', targets: 'all' },
        ctx(['workflow_prev']),
      ),
    ).toEqual({
      ok: true,
      command: { kind: 'workflow_prev', opId: 'op-p', targets: 'all' },
    });
    expect(
      dispatch(
        'workflow_prev',
        { opId: 'op-p', targets: ['from_p1'], note: 'fix me' },
        ctx(['workflow_prev']),
      ),
    ).toEqual({
      ok: true,
      command: {
        kind: 'workflow_prev',
        opId: 'op-p',
        targets: ['from_p1'],
        note: 'fix me',
      },
    });
  });

  it('rejects empty/invalid workflow_prev targets at parse time', () => {
    expect(
      dispatch(
        'workflow_prev',
        { opId: 'op-p', targets: [] },
        ctx(['workflow_prev']),
      ),
    ).toEqual({
      ok: false,
      toolError: 'targets must be "all" or a non-empty string array of inputRefs',
    });
    expect(
      dispatch(
        'workflow_prev',
        { opId: 'op-p', targets: [''] },
        ctx(['workflow_prev']),
      ),
    ).toEqual({
      ok: false,
      toolError: 'targets must be "all" or a non-empty string array of inputRefs',
    });
    expect(
      dispatch(
        'workflow_prev',
        { opId: 'op-p' },
        ctx(['workflow_prev']),
      ),
    ).toEqual({
      ok: false,
      toolError: 'targets must be "all" or a non-empty string array of inputRefs',
    });
    expect(
      dispatch(
        'workflow_prev',
        { opId: 'op-p', targets: 'all' },
        ctx(['complete_task']),
      ),
    ).toEqual({ ok: false, toolError: 'action not permitted: workflow_prev' });
  });

  it('maps workflow_fail with optional reason', () => {
    expect(
      dispatch(
        'workflow_fail',
        { opId: 'op-f' },
        ctx(['workflow_fail']),
      ),
    ).toEqual({
      ok: true,
      command: { kind: 'workflow_fail', opId: 'op-f' },
    });
    expect(
      dispatch(
        'workflow_fail',
        { opId: 'op-f', reason: 'cannot continue' },
        ctx(['workflow_fail']),
      ),
    ).toEqual({
      ok: true,
      command: { kind: 'workflow_fail', opId: 'op-f', reason: 'cannot continue' },
    });
  });

  it('rejects invalid workflow_fail reason at parse time', () => {
    expect(
      dispatch(
        'workflow_fail',
        { opId: 'op-f', reason: '' },
        ctx(['workflow_fail']),
      ),
    ).toEqual({
      ok: false,
      toolError: 'reason must be a non-empty string when provided',
    });
    expect(
      dispatch(
        'workflow_fail',
        { opId: 'op-f' },
        ctx(['complete_task']),
      ),
    ).toEqual({ ok: false, toolError: 'action not permitted: workflow_fail' });
  });

  it('maps child workflow bindings with exact entry and artifact revision identity', () => {
    const binding = {
      childEntryNodeId: 'entry-a',
      inputRef: 'request',
      artifactId: 'artifact-1',
      artifactRevision: 3,
    };
    expect(dispatch(
      'invoke_child_workflow',
      {
        opId: 'op-child',
        childDefinitionId: 'wf-child',
        childDefinitionVersion: 2,
        entryBindings: [binding],
      },
      ctx(['invoke_child_workflow']),
    )).toEqual({
      ok: true,
      command: {
        kind: 'invoke_child_workflow',
        opId: 'op-child',
        childDefinitionId: 'wf-child',
        childDefinitionVersion: 2,
        entryBindings: [binding],
      },
    });
    expect(dispatch(
      'invoke_child_workflow',
      {
        opId: 'op-child-invalid',
        childDefinitionId: 'wf-child',
        childDefinitionVersion: 2,
        entryBindings: [{ ...binding, artifactRevision: 0 }],
      },
      ctx(['invoke_child_workflow']),
    )).toEqual({
      ok: false,
      toolError:
        'each entryBinding requires childEntryNodeId, inputRef, artifactId, and a positive artifactRevision',
    });
  });
});
