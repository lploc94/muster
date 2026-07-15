import { describe, expect, it } from 'vitest';
import {
  BRIEF_LIST_MAX_ITEMS,
  BRIEF_SECTION_MAX,
  COMPILED_PROMPT_MAX,
  MAX_BRIEF_SKILLS,
  SKILL_NAME_RE,
  TASK_BRIEF_KINDS,
  assembleFirstTurnPrompt,
  clampSection,
  compileTaskPrompt,
  isTaskBriefKind,
  mergeBriefFromCreate,
  normalizeSkillNames,
  resolveSkillInvocation,
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

describe('verify preamble + verdict-by-default (ISSUE 6 / verify-gate-loop A)', () => {
  it('appends the # Verdict instruction for a plain verify-kind brief BY DEFAULT', () => {
    // verify-gate-loop A: emitting a verdict is the job of a verify task, so a plain
    // verify brief (no hostRun/emitVerdict flag) now includes the verdict section.
    const brief = synthesizeBriefFromGoal('Verify the widget', undefined, 'verify');
    const prompt = compileTaskPrompt(brief, [], { taskId: 'vfy', goal: 'Verify the widget' });
    expect(prompt).toContain('You are a verification agent. Confirm acceptance criteria and definition of done.');
    expect(prompt).toContain('# Verdict');
    expect(prompt).toContain('structured verdict');
    expect(prompt).toContain("never a default 'pass'");
  });

  it('does NOT append the # Verdict instruction for a non-verify brief without the flag', () => {
    // A non-verify kind (here `implement`) with no emitVerdict/hostRun opt-in stays clean.
    const brief = synthesizeBriefFromGoal('Build the widget', undefined, 'implement');
    const prompt = compileTaskPrompt(brief, [], { taskId: 'impl', goal: 'Build the widget' });
    expect(prompt).not.toContain('# Verdict');
    expect(prompt).not.toContain('structured verdict');
  });

  it('appends the # Verdict instruction only when emitVerdict is opted in', () => {
    const brief = mergeBriefFromCreate({
      goal: 'Verify the widget',
      brief: { kind: 'verify', verification: { emitVerdict: true } },
    });
    expect(brief.verification?.emitVerdict).toBe(true);
    const prompt = compileTaskPrompt(brief, [], { taskId: 'vfy', goal: 'Verify the widget' });
    // Legacy preamble stays; the verdict instruction is added as an extra section.
    expect(prompt).toContain('You are a verification agent. Confirm acceptance criteria and definition of done.');
    expect(prompt).toContain('# Verdict');
    expect(prompt).toContain('structured verdict');
    expect(prompt).toContain("never a default 'pass'");
  });

  it('appends the # Verdict instruction when hostRun is opted in', () => {
    const brief = mergeBriefFromCreate({
      goal: 'Verify the widget',
      brief: { kind: 'verify', verification: { commands: ['npm test'], hostRun: true } },
    });
    expect(brief.verification?.hostRun).toBe(true);
    const prompt = compileTaskPrompt(brief, [], { taskId: 'vfy', goal: 'Verify the widget' });
    expect(prompt).toContain('# Verdict');
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

describe('normalizeSkillNames', () => {
  it('dedupes (case-sensitive) and preserves first-seen order', () => {
    expect(normalizeSkillNames(['plan', 'review', 'plan', 'Plan'])).toEqual([
      'plan',
      'review',
      'Plan',
    ]);
  });

  it('trims whitespace and drops blanks / non-strings', () => {
    expect(normalizeSkillNames(['  plan  ', '', '   ', 3, null, 'review'])).toEqual([
      'plan',
      'review',
    ]);
  });

  it(`caps at MAX_BRIEF_SKILLS (${MAX_BRIEF_SKILLS})`, () => {
    const many = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const out = normalizeSkillNames(many);
    expect(out).toHaveLength(MAX_BRIEF_SKILLS);
    expect(out?.[0]).toBe('s0');
  });

  it('returns undefined for a non-array or an empty result', () => {
    expect(normalizeSkillNames(undefined)).toBeUndefined();
    expect(normalizeSkillNames('plan')).toBeUndefined();
    expect(normalizeSkillNames([])).toBeUndefined();
    expect(normalizeSkillNames(['', '  '])).toBeUndefined();
  });
});

describe('resolveSkillInvocation', () => {
  it('UNKNOWN backend (undefined advertised): injects all valid names optimistically', () => {
    const r = resolveSkillInvocation(['plan', 'review'], undefined);
    expect(r.commandLines).toEqual(['/plan', '/review']);
    expect(r.unavailable).toEqual([]);
  });

  it('KNOWN backend: injects only advertised names, others → unavailable', () => {
    const r = resolveSkillInvocation(['plan', 'ghost'], new Set(['plan', 'other']));
    expect(r.commandLines).toEqual(['/plan']);
    expect(r.unavailable).toEqual(['ghost']);
  });

  it('KNOWN-but-empty set is fail-closed: nothing injected', () => {
    const r = resolveSkillInvocation(['plan'], new Set());
    expect(r.commandLines).toEqual([]);
    expect(r.unavailable).toEqual(['plan']);
  });

  it('rejects names failing SKILL_NAME_RE (never a command line, even on UNKNOWN)', () => {
    const bad = ['ok', 'has space', 'new\nline', '/slash', 'trailing;rm', '-leadingdash'];
    const r = resolveSkillInvocation(bad, undefined);
    expect(r.commandLines).toEqual(['/ok']);
    expect(r.unavailable).toEqual(['has space', 'new\nline', '/slash', 'trailing;rm', '-leadingdash']);
    expect(SKILL_NAME_RE.test('ok')).toBe(true);
    expect(SKILL_NAME_RE.test('a.b_c-1')).toBe(true);
  });

  it('handles undefined skills', () => {
    expect(resolveSkillInvocation(undefined, new Set(['x']))).toEqual({
      commandLines: [],
      unavailable: [],
    });
  });
});

describe('mergeBriefFromCreate — skills', () => {
  it('carries normalized skills from overlay (dedup + order + cap)', () => {
    const merged = mergeBriefFromCreate({
      goal: 'Do the thing',
      brief: { skills: ['plan', 'plan', '  review  ', ''] },
    });
    expect(merged.skills).toEqual(['plan', 'review']);
  });

  it('omits skills when overlay has none or only blanks', () => {
    expect(mergeBriefFromCreate({ goal: 'g' }).skills).toBeUndefined();
    expect(mergeBriefFromCreate({ goal: 'g', brief: { skills: [] } }).skills).toBeUndefined();
  });
});

describe('assembleFirstTurnPrompt — skill injection', () => {
  const baseInput = () => ({
    snapshot: hostSnap(),
    self: { taskId: 'c1', role: 'worker' as const, backend: 'opencode' },
    brief: synthesizeBriefFromGoal('Implement X', undefined, 'implement'),
  });

  it('prepends `/name` lines then a blank line before the body (UNKNOWN backend)', () => {
    const brief = synthesizeBriefFromGoal('Implement X', undefined, 'implement');
    brief.skills = ['plan', 'review'];
    const result = assembleFirstTurnPrompt({ ...baseInput(), brief });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.startsWith('/plan\n/review\n\n')).toBe(true);
    expect(result.prompt.indexOf('/plan')).toBeLessThan(result.prompt.indexOf('# Muster host context'));
    expect(result.unavailableSkills).toEqual([]);
  });

  it('no skills → prompt unchanged and unavailableSkills empty', () => {
    const result = assembleFirstTurnPrompt(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.startsWith('/')).toBe(false);
    expect(result.prompt.startsWith('# Muster host context')).toBe(true);
    expect(result.unavailableSkills).toEqual([]);
  });

  it('KNOWN backend: injects only advertised skills and surfaces the rest', () => {
    const brief = synthesizeBriefFromGoal('Implement X', undefined, 'implement');
    brief.skills = ['plan', 'ghost'];
    const result = assembleFirstTurnPrompt({
      ...baseInput(),
      brief,
      advertisedCommands: new Set(['plan']),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.startsWith('/plan\n\n')).toBe(true);
    expect(result.prompt).not.toContain('/ghost');
    expect(result.unavailableSkills).toEqual(['ghost']);
  });

  it('counts the skill prefix against COMPILED_PROMPT_MAX (prefix cannot bypass budget)', () => {
    const brief = synthesizeBriefFromGoal('small objective');
    // Oversized but SKILL_NAME_RE-valid name: without counting the prefix it would
    // silently blow past the budget. UNKNOWN backend → optimistic inject attempted.
    brief.skills = ['a'.repeat(COMPILED_PROMPT_MAX)];
    const result = assembleFirstTurnPrompt({ ...baseInput(), brief });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('prompt_budget_exceeded');
  });

  it('reserves the prefix during optional-section packing: drops an optional section to fit, still succeeds', () => {
    const brief = synthesizeBriefFromGoal('objective');
    // A large optional section that fits comfortably WITHOUT a skill prefix.
    brief.context = `CTX ${'c'.repeat(BRIEF_SECTION_MAX)}`;

    // Baseline (no skills): the context section is kept.
    const noSkill = assembleFirstTurnPrompt({ ...baseInput(), brief });
    expect(noSkill.ok).toBe(true);
    if (!noSkill.ok) return;
    expect(noSkill.prompt).toContain('# Context');

    // A large (SKILL_NAME_RE-valid) skill: prefix + context would blow the budget,
    // so the packing must DROP the context section — but still succeed (not fail).
    const skillName = 'a'.repeat(41_000);
    brief.skills = [skillName];
    const withSkill = assembleFirstTurnPrompt({
      ...baseInput(),
      brief,
      advertisedCommands: new Set([skillName]),
    });
    expect(withSkill.ok).toBe(true);
    if (!withSkill.ok) return;
    expect(withSkill.prompt.startsWith(`/${skillName}\n\n`)).toBe(true);
    expect(withSkill.prompt).not.toContain('# Context');
    expect(withSkill.prompt.length).toBeLessThanOrEqual(COMPILED_PROMPT_MAX);
  });
});
