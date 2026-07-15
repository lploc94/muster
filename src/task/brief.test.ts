import { describe, expect, it } from 'vitest';
import {
  BRIEF_LIST_MAX_ITEMS,
  BRIEF_SECTION_MAX,
  COMPILED_PROMPT_MAX,
  TASK_BRIEF_KINDS,
  assembleFirstTurnPrompt,
  clampSection,
  compileTaskPrompt,
  isTaskBriefKind,
  mergeBriefFromCreate,
  synthesizeBriefFromGoal,
} from './brief';
import {
  HOST_RULES_BASE,
  HOST_RULES_COORDINATOR,
  HOST_RULES_WORKER,
  type HostEnvironmentSnapshot,
} from './host-context';

const hostSnap = (): HostEnvironmentSnapshot => ({
  cwd: '/ws',
  trusted: true,
  availableBackends: ['opencode'],
  models: {
    opencode: {
      current: 'm1',
      options: [{ value: 'm1', name: 'M1' }],
    },
  },
});

describe('synthesizeBriefFromGoal', () => {
  it('builds generic brief from goal and description', () => {
    const brief = synthesizeBriefFromGoal('Ship feature X', 'More context here');
    expect(brief).toMatchObject({
      version: 1,
      kind: 'generic',
      title: 'Ship feature X',
      objective: 'Ship feature X',
      context: 'More context here',
      acceptanceCriteria: [],
      expectedOutputs: ['summary'],
    });
  });

  it('omits empty context and supports kind override', () => {
    const brief = synthesizeBriefFromGoal('Plan the work', undefined, 'plan');
    expect(brief.kind).toBe('plan');
    expect(brief.context).toBeUndefined();
  });
});

describe('breakdown briefKind', () => {
  it('is a recognized brief kind', () => {
    expect(TASK_BRIEF_KINDS).toContain('breakdown');
    expect(isTaskBriefKind('breakdown')).toBe(true);
  });

  it('emits the work-breakdown preamble in a compiled prompt', () => {
    const brief = synthesizeBriefFromGoal('Decompose the plan', undefined, 'breakdown');
    const prompt = compileTaskPrompt(brief, [], { taskId: 'bd', goal: 'Decompose the plan' });
    expect(prompt).toContain('work-breakdown agent');
    expect(prompt).toContain('ordered checklist');
    expect(prompt).toContain('machine-readable');
  });
});

describe('compileTaskPrompt', () => {
  it('includes kind preamble, objective, and untrusted pin framing', () => {
    const brief = synthesizeBriefFromGoal('Implement plan', 'ctx', 'implement');
    brief.acceptanceCriteria = ['tests pass'];
    const prompt = compileTaskPrompt(
      brief,
      [
        {
          as: 'implementationPlan',
          fromTaskId: 'plan',
          output: 'summary',
          producerResultRevision: 1,
          text: 'do step one',
        },
      ],
      { taskId: 'impl', goal: 'Implement plan' },
    );
    expect(prompt).toContain('implementation agent');
    expect(prompt).toContain('Implement plan');
    expect(prompt).toContain('Acceptance criteria');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('do step one');
  });

  it('truncates oversized compiled prompt', () => {
    const brief = synthesizeBriefFromGoal('x'.repeat(BRIEF_SECTION_MAX + 100));
    brief.context = 'y'.repeat(BRIEF_SECTION_MAX + 100);
    const prompt = compileTaskPrompt(brief, []);
    expect(prompt.length).toBeLessThanOrEqual(COMPILED_PROMPT_MAX);
  });
});

describe('clampSection', () => {
  it('no-ops under max', () => {
    expect(clampSection('abc')).toBe('abc');
  });
});

describe('mergeBriefFromCreate', () => {
  it('goal-only matches synthesizeBriefFromGoal', () => {
    const merged = mergeBriefFromCreate({ goal: 'Ship feature X', description: 'ctx' });
    expect(merged).toEqual(synthesizeBriefFromGoal('Ship feature X', 'ctx'));
  });

  it('overlays acceptanceCriteria and kind', () => {
    const merged = mergeBriefFromCreate({
      goal: 'Implement plan',
      brief: {
        kind: 'implement',
        acceptanceCriteria: ['tests pass', 'lint clean'],
        context: 'from plan',
      },
    });
    expect(merged.kind).toBe('implement');
    expect(merged.acceptanceCriteria).toEqual(['tests pass', 'lint clean']);
    expect(merged.context).toBe('from plan');
    expect(merged.objective).toBe('Implement plan');
  });

  it('top-level writePaths land when brief omits them', () => {
    const merged = mergeBriefFromCreate({
      goal: 'edit files',
      writePaths: ['src/a.ts'],
      readPaths: ['docs/x.md'],
    });
    expect(merged.writePaths).toEqual(['src/a.ts']);
    expect(merged.readPaths).toEqual(['docs/x.md']);
  });

  it('brief paths win over top-level convenience', () => {
    const merged = mergeBriefFromCreate({
      goal: 'edit',
      writePaths: ['top.ts'],
      brief: { writePaths: ['brief.ts'] },
    });
    expect(merged.writePaths).toEqual(['brief.ts']);
  });

  it('clamps oversize objective and truncates long lists', () => {
    const many = Array.from({ length: BRIEF_LIST_MAX_ITEMS + 5 }, (_, i) => `c${i}`);
    const merged = mergeBriefFromCreate({
      goal: 'g',
      brief: {
        objective: 'O'.repeat(BRIEF_SECTION_MAX + 50),
        acceptanceCriteria: many,
      },
    });
    expect(merged.objective.length).toBe(BRIEF_SECTION_MAX);
    expect(merged.acceptanceCriteria).toHaveLength(BRIEF_LIST_MAX_ITEMS);
  });
});

describe('assembleFirstTurnPrompt', () => {
  it('orders host → role → brief → pins for coordinator', () => {
    const brief = synthesizeBriefFromGoal('Coordinate work', undefined, 'coordinate');
    brief.acceptanceCriteria = ['children done'];
    brief.context = 'extra context';
    const result = assembleFirstTurnPrompt({
      snapshot: hostSnap(),
      self: {
        taskId: 'root',
        role: 'coordinator',
        backend: 'opencode',
        model: 'm1',
      },
      tools: ['create_task', 'set_task_lifecycle'],
      brief,
      resolvedInputs: [
        {
          as: 'plan',
          fromTaskId: 'p1',
          output: 'summary',
          producerResultRevision: 1,
          text: 'step A',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prompt = result.prompt;
    const iHost = prompt.indexOf('# Muster host context');
    const iRole = prompt.indexOf('# Role');
    const iObj = prompt.indexOf('# Objective');
    const iCtx = prompt.indexOf('# Context');
    const iAc = prompt.indexOf('# Acceptance criteria');
    const iPin = prompt.indexOf('untrusted-input');
    expect(iHost).toBe(0);
    expect(iRole).toBeGreaterThan(iHost);
    expect(iObj).toBeGreaterThan(iRole);
    expect(iCtx).toBeGreaterThan(iObj);
    expect(iAc).toBeGreaterThan(iCtx);
    expect(iPin).toBeGreaterThan(iAc);
    expect(prompt).toContain('## Available backends');
    expect(prompt).toContain('set_task_lifecycle');
    for (const r of HOST_RULES_BASE) expect(prompt).toContain(r);
    for (const r of HOST_RULES_COORDINATOR) expect(prompt).toContain(r);
    expect(prompt).toContain('<untrusted-input name="plan"');
    expect(prompt).toContain('</untrusted-input>');
  });

  it('worker tier: host base + scope; no backends section', () => {
    const brief = synthesizeBriefFromGoal('Implement X', undefined, 'implement');
    const result = assembleFirstTurnPrompt({
      snapshot: hostSnap(),
      self: {
        taskId: 'c1',
        role: 'worker',
        backend: 'opencode',
        parentTaskId: 'root',
      },
      taskCwd: '/child/cwd',
      brief,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain('cwd: `/child/cwd`');
    expect(result.prompt).toContain('## Scope');
    expect(result.prompt).not.toContain('## Available backends');
    expect(result.prompt).not.toContain('## Models');
    for (const r of HOST_RULES_WORKER) expect(result.prompt).toContain(r);
  });

  it('returns prompt_budget_exceeded when protected pins cannot fit', () => {
    const brief = synthesizeBriefFromGoal('x'.repeat(100));
    const hugePin = 'P'.repeat(COMPILED_PROMPT_MAX);
    const result = assembleFirstTurnPrompt({
      snapshot: hostSnap(),
      self: { taskId: 't', role: 'worker', backend: 'opencode' },
      brief,
      resolvedInputs: [
        {
          as: 'big',
          fromTaskId: 'p',
          output: 'summary',
          producerResultRevision: 1,
          text: hugePin,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('prompt_budget_exceeded');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('never mid-tag cuts pin framing when optional sections drop', () => {
    const brief = synthesizeBriefFromGoal('obj');
    brief.context = 'C'.repeat(BRIEF_SECTION_MAX);
    brief.constraints = Array.from({ length: 20 }, () => 'c'.repeat(400));
    brief.acceptanceCriteria = Array.from({ length: 20 }, () => 'a'.repeat(400));
    const pinText = 'pin-body-ok';
    const result = assembleFirstTurnPrompt({
      snapshot: hostSnap(),
      self: { taskId: 't', role: 'coordinator', backend: 'opencode' },
      tools: ['create_task'],
      brief,
      resolvedInputs: [
        {
          as: 'in',
          fromTaskId: 'up',
          output: 'summary',
          producerResultRevision: 1,
          text: pinText,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt).toContain(`<untrusted-input name="in"`);
    expect(result.prompt).toContain(pinText);
    expect(result.prompt).toContain('</untrusted-input>');
    expect(result.prompt.length).toBeLessThanOrEqual(COMPILED_PROMPT_MAX);
  });
});
