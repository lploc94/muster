import { describe, expect, it } from 'vitest';
import {
  BRIEF_SECTION_MAX,
  COMPILED_PROMPT_MAX,
  clampSection,
  compileTaskPrompt,
  synthesizeBriefFromGoal,
} from './brief';

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
