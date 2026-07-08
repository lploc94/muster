import { describe, expect, it } from 'vitest';
import {
  classifyPermission,
  pickOption,
  resolvePolicy,
  type PermissionClass,
  type PermissionMode,
  type PermissionOption,
} from './permission-policy';

describe('classifyPermission', () => {
  it('maps read-only kinds to read', () => {
    for (const kind of ['read', 'search', 'fetch', 'think']) {
      expect(classifyPermission({ kind }, [])).toBe('read');
    }
  });

  it('maps destructive kinds to write', () => {
    for (const kind of ['edit', 'delete', 'move', 'execute']) {
      expect(classifyPermission({ kind }, [])).toBe('write');
    }
  });

  it('treats missing / other / unrecognized kinds as unknown', () => {
    expect(classifyPermission(undefined, [])).toBe('unknown');
    expect(classifyPermission({}, [])).toBe('unknown');
    expect(classifyPermission({ kind: 'other' }, [])).toBe('unknown');
    expect(classifyPermission({ kind: 'frobnicate' }, [])).toBe('unknown');
  });

  it('is case-insensitive and trims the kind', () => {
    expect(classifyPermission({ kind: '  READ ' }, [])).toBe('read');
    expect(classifyPermission({ kind: 'Execute' }, [])).toBe('write');
  });
});

describe('resolvePolicy matrix', () => {
  const classes: PermissionClass[] = ['read', 'write', 'unknown'];

  // Expected decision for every (mode, class, allowlisted) combination.
  const expected: Record<
    PermissionMode,
    Record<PermissionClass, { yes: string; no: string }>
  > = {
    allow: {
      read: { yes: 'allow', no: 'allow' },
      write: { yes: 'allow', no: 'allow' },
      unknown: { yes: 'allow', no: 'allow' },
    },
    readonly: {
      read: { yes: 'allow', no: 'allow' },
      write: { yes: 'deny', no: 'deny' },
      unknown: { yes: 'deny', no: 'deny' },
    },
    ask: {
      read: { yes: 'allow', no: 'allow' },
      write: { yes: 'allow', no: 'prompt' },
      unknown: { yes: 'allow', no: 'prompt' },
    },
  };

  for (const mode of Object.keys(expected) as PermissionMode[]) {
    for (const cls of classes) {
      it(`${mode} / ${cls} / allowlisted=true`, () => {
        expect(resolvePolicy(mode, cls, true).decision).toBe(expected[mode][cls].yes);
      });
      it(`${mode} / ${cls} / allowlisted=false`, () => {
        expect(resolvePolicy(mode, cls, false).decision).toBe(expected[mode][cls].no);
      });
    }
  }
});

describe('pickOption', () => {
  const opts: PermissionOption[] = [
    { optionId: 'allow_once', kind: 'allow_once' },
    { optionId: 'allow_always', kind: 'allow_always' },
    { optionId: 'reject_once', kind: 'reject_once' },
  ];

  it('prefers a one-shot allow option when allowing', () => {
    expect(pickOption(opts, true)).toBe('allow_once');
  });

  it('falls back to any allow option when no once variant exists', () => {
    const noOnce: PermissionOption[] = [
      { optionId: 'yes', kind: 'allow_always' },
      { optionId: 'no', kind: 'reject_always' },
    ];
    expect(pickOption(noOnce, true)).toBe('yes');
  });

  it('honors legacy allow_once optionId even when kind does not match', () => {
    const legacy: PermissionOption[] = [{ optionId: 'allow_once', kind: 'proceed' }];
    expect(pickOption(legacy, true)).toBe('allow_once');
  });

  it('picks a reject option when denying', () => {
    expect(pickOption(opts, false)).toBe('reject_once');
  });

  it('matches deny-kind options too', () => {
    const denyOpts: PermissionOption[] = [
      { optionId: 'ok', kind: 'allow_once' },
      { optionId: 'nope', kind: 'deny' },
    ];
    expect(pickOption(denyOpts, false)).toBe('nope');
  });

  it('returns null when no allow option is offered', () => {
    const rejectsOnly: PermissionOption[] = [{ optionId: 'no', kind: 'reject_once' }];
    expect(pickOption(rejectsOnly, true)).toBeNull();
  });

  it('returns null when no reject option is offered', () => {
    const allowsOnly: PermissionOption[] = [{ optionId: 'yes', kind: 'allow_once' }];
    expect(pickOption(allowsOnly, false)).toBeNull();
  });

  it('returns null for an empty option list', () => {
    expect(pickOption([], true)).toBeNull();
    expect(pickOption([], false)).toBeNull();
  });
});
