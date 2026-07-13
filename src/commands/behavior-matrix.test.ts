import { describe, expect, it } from 'vitest';
import { NATIVE_COMMAND_SPECS } from '../workflow/contracts';
import { COMMAND_BEHAVIOR, behaviorForCommand } from './behavior-matrix';
import { resolveCommandId } from './registry';

describe('command behavior matrix', () => {
  it('covers every canonical registry command exactly once', () => {
    expect(COMMAND_BEHAVIOR.map((entry) => entry.id).sort())
      .toEqual(NATIVE_COMMAND_SPECS.map((entry) => entry.id).sort());
    expect(new Set(COMMAND_BEHAVIOR.map((entry) => entry.id)).size).toBe(COMMAND_BEHAVIOR.length);
  });

  it('keeps aliases and task requirements in parity with the registry', () => {
    for (const spec of NATIVE_COMMAND_SPECS) {
      const behavior = behaviorForCommand(spec.id);
      expect(behavior.aliases).toEqual(spec.aliases);
      expect(behavior.requiresTask).toBe(spec.requiresTask);
      expect(behavior.effectClass).toBe(spec.effectClass);
      expect(behavior.requiredPhases).toEqual(spec.requiredPhases);
      expect(behavior.presenter).toMatch(/.+/);
      expect(behavior.successMessage).toMatch(/.+/);
      expect(behavior.rejectionMessage).toMatch(/.+/);
      for (const alias of spec.aliases) expect(resolveCommandId(alias)).toBe(spec.id);
    }
  });

  it('gives every disabled command an explicit user-facing reason', () => {
    for (const behavior of COMMAND_BEHAVIOR.filter((entry) => entry.availability === 'disabled')) {
      expect(behavior.disabledReason).toMatch(/.+/);
    }
  });
});
