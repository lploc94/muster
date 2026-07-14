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
      { opId: 'op-1', goal: 'child goal', backend: 'grok' },
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
      { opId: 'op-1', goal: 'plan work', backend: 'codex', model: 'gpt-5' },
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
        goal: 'fast plan',
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

  it('omits model when empty string', () => {
    const result = dispatch(
      'create_task',
      { opId: 'op-1', goal: 'x', backend: 'opencode', model: '' },
      ctx(['create_task']),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.command.kind === 'create_task') {
      expect(result.command.spec.model).toBeUndefined();
    }
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
      { opId: 'op-1', goal: 'g', backend: 'grok' },
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
        backend: 'grok',
        inputBindings: [{ fromTaskId: 'p', output: 'artifact', as: 'a' }],
      },
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