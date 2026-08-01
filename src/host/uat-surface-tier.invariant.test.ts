/**
 * Release-surface invariant: a Production VSIX must never expose the mutable
 * live-UAT command surface.
 *
 * MUSTER_UAT_MODE=1 is a necessary opt-in but not a sufficient one. The M022/S05
 * real-install gate needs redacted bridge health/closure observations from a
 * CLI-installed (Production ExtensionMode) copy, so the env flag alone cannot be
 * the whole gate — a marketplace user who sets it would otherwise get commands
 * that create/delete messages, write the send outbox, mutate presentations, and
 * call deactivate().
 *
 * This test exists because the tiering is otherwise unguarded: reverting
 * resolveUatSurface to a bare env check keeps every other test green (K002).
 * Source-scan style follows src/host/backend-readiness.invariant.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PACKAGING_UAT_COMMAND_IDS,
  UAT_COMMANDS,
  isUatCommandAllowed,
  isUatModeEnabled,
  resolveUatSurface,
  type UatCommandId,
} from './uat-commands';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/**
 * The only commands a Production host may expose. Each is a pure redacted
 * observation or a teardown of this extension instance — none reaches the store.
 */
const EXPECTED_PACKAGING_IDS: readonly UatCommandId[] = [
  UAT_COMMANDS.bridgeHealth,
  UAT_COMMANDS.runDeactivate,
  UAT_COMMANDS.deactivateTrace,
];

/** Commands that read or mutate durable state, host state, or the task store. */
const MUTABLE_OR_STATEFUL_IDS: readonly UatCommandId[] = [
  UAT_COMMANDS.createTaskWithMessage,
  UAT_COMMANDS.appendMessage,
  UAT_COMMANDS.enqueueFollowUp,
  UAT_COMMANDS.promoteFollowUp,
  UAT_COMMANDS.deleteMessage,
  UAT_COMMANDS.putSendOutbox,
  UAT_COMMANDS.markSendOutboxRejected,
  UAT_COMMANDS.putPresentation,
  UAT_COMMANDS.readDurableSurfaces,
  UAT_COMMANDS.identity,
  UAT_COMMANDS.hostState,
  UAT_COMMANDS.forcePollingActive,
  UAT_COMMANDS.loadOlderTranscript,
  UAT_COMMANDS.focusTask,
  UAT_COMMANDS.ping,
  UAT_COMMANDS.refreshReadiness,
  UAT_COMMANDS.probeBackend,
  UAT_COMMANDS.runDoctor,
  UAT_COMMANDS.acceptFirstTask,
  UAT_COMMANDS.nativeFirstRunCleanup,
  // M023: storage lifecycle harness. seedStorageWorkload writes tasks/turns,
  // runRetentionPass mutates payloads, reclaimOrphanedFiles deletes files, and
  // renderProbe returns a path-bearing DOM observation (D079).
  UAT_COMMANDS.seedStorageWorkload,
  UAT_COMMANDS.storageLifecycleState,
  UAT_COMMANDS.runRetentionPass,
  UAT_COMMANDS.seedOrphanLifecycleFixtures,
  UAT_COMMANDS.reclaimOrphanedFiles,
  UAT_COMMANDS.renderProbe,
];

describe('UAT surface tiering (release-surface invariant)', () => {
  it('caps a Production extension at the redacted packaging tier', () => {
    expect(resolveUatSurface(true, { MUSTER_UAT_MODE: '1' })).toBe('packaging');
    expect(resolveUatSurface(false, { MUSTER_UAT_MODE: '1' })).toBe('full');
  });

  it('registers nothing at all without the explicit env opt-in', () => {
    for (const isProduction of [true, false]) {
      expect(resolveUatSurface(isProduction, {})).toBe('none');
      expect(resolveUatSurface(isProduction, { MUSTER_UAT_MODE: '0' })).toBe('none');
      expect(resolveUatSurface(isProduction, { MUSTER_UAT_MODE: 'true' })).toBe('none');
      expect(isUatModeEnabled(isProduction, {})).toBe(false);
    }
  });

  it('allows only the three redacted bridge observers in the packaging tier', () => {
    expect([...PACKAGING_UAT_COMMAND_IDS].sort()).toEqual([...EXPECTED_PACKAGING_IDS].sort());
    for (const id of EXPECTED_PACKAGING_IDS) {
      expect(isUatCommandAllowed('packaging', id)).toBe(true);
    }
  });

  it('denies every store-mutating and host-state command in the packaging tier', () => {
    for (const id of MUTABLE_OR_STATEFUL_IDS) {
      expect(isUatCommandAllowed('packaging', id)).toBe(false);
      // Still reachable for the non-production harness that actually needs them.
      expect(isUatCommandAllowed('full', id)).toBe(true);
    }
  });

  it('covers every declared UAT command in exactly one bucket', () => {
    // A newly added command must be classified deliberately, not inherit access.
    const declared = Object.values(UAT_COMMANDS).sort();
    const classified = [...EXPECTED_PACKAGING_IDS, ...MUTABLE_OR_STATEFUL_IDS].sort();
    expect(classified).toEqual(declared);
  });

  it('registers nothing in the none tier', () => {
    for (const id of Object.values(UAT_COMMANDS)) {
      expect(isUatCommandAllowed('none', id)).toBe(false);
    }
  });
});

describe('activate() honours the resolved tier (production source scan)', () => {
  const extensionSource = readRepoFile('src/extension.ts');

  it('resolves a tier instead of a bare boolean env check', () => {
    expect(extensionSource).toMatch(/resolveUatSurface\s*\(/);
    // The resolved tier must reach the registrar, so its allowlist and early
    // return decide access. M023 appends storage args after it.
    expect(extensionSource).toMatch(/registerLiveUatCommands\(\s*context,\s*uatSurface\s*[,)]/);
    // A bare isUatModeEnabled gate in activate() would re-open the surface.
    expect(extensionSource).not.toMatch(/const\s+liveUatEnabled\s*=\s*isUatModeEnabled\s*\(/);
  });

  it('keeps the M023 path-bearing probe and retention override Development-only', () => {
    // liveUatEnabled is true for a Production VSIX at the packaging tier, so
    // these two affordances must key off the strictly stronger 'full' check.
    expect(extensionSource).toMatch(/const\s+fullUatSurface\s*=\s*uatSurface\s*===\s*'full'/);
    expect(extensionSource).toMatch(/new MusterChatProvider\([^)]*fullUatSurface/);
    expect(extensionSource).toMatch(
      /resolveRetentionScheduleIntervalMs\(\s*fullUatSurface\s*\)/,
    );
    expect(extensionSource).not.toMatch(
      /resolveRetentionScheduleIntervalMs\(\s*liveUatEnabled\s*\)/,
    );
  });

  it('guards the store-mutating registrations behind a tier check', () => {
    const start = extensionSource.indexOf('function registerLiveUatCommands');
    expect(start).toBeGreaterThan(-1);

    const body = extensionSource.slice(start);
    const guardIndex = body.search(/if\s*\(\s*tier\s*!==\s*'full'\s*\)\s*\{\s*return;/);
    expect(guardIndex).toBeGreaterThan(-1);

    // Every mutating handler must sit after the early return, so a packaging
    // host cannot reach it even if a future edit forgets the allowlist.
    for (const command of [
      'UAT_COMMANDS.createTaskWithMessage',
      'UAT_COMMANDS.deleteMessage',
      'UAT_COMMANDS.putSendOutbox',
      'UAT_COMMANDS.putPresentation',
      'UAT_COMMANDS.hostState',
      // M023 storage-lifecycle handlers carry the same requirement.
      'UAT_COMMANDS.seedStorageWorkload',
      'UAT_COMMANDS.runRetentionPass',
      'UAT_COMMANDS.reclaimOrphanedFiles',
      'UAT_COMMANDS.renderProbe',
    ]) {
      const at = body.indexOf(command);
      expect(at, `${command} must be registered in registerLiveUatCommands`).toBeGreaterThan(-1);
      expect(at, `${command} must be registered after the tier !== 'full' guard`).toBeGreaterThan(
        guardIndex,
      );
    }
  });
});
