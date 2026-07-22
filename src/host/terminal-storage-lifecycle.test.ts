import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalStorageLifecycle,
  RESET_MUSTER_DATA_ACTION,
  REVEAL_STORAGE_FOLDER_ACTION,
} from './terminal-storage-lifecycle';

function makeLifecycle(overrides?: {
  recoveryAction?: string;
  message?: string;
  code?: string;
  guidance?: string;
  onQuiesce?: () => void;
  onCloseDoomed?: (doomed: unknown) => void;
  onReloadWindow?: () => void;
  onResetStorage?: () => void;
}) {
  const counts = {
    quiesce: 0,
    log: 0,
    close: 0,
    showError: 0,
    reveal: 0,
    reload: 0,
    reset: 0,
  };
  const logPayloads: Array<Record<string, unknown>> = [];
  const showChoices: Array<string | undefined> = [];
  let showReturn: string | undefined;

  const lifecycle = createTerminalStorageLifecycle({
    diagnose: (_error, operation) => ({
      code: overrides?.code ?? 'corrupt',
      message: overrides?.message ?? 'Muster storage is corrupt.',
      recoveryAction: overrides?.recoveryAction ?? 'reveal_storage',
      operation,
      kind: 'storage',
      failClosed: true,
      terminal: true,
    }),
    redactedLogFields: (d) => ({ code: d.code, message: d.message }),
    log: (_channel, fields) => {
      counts.log += 1;
      logPayloads.push(fields);
    },
    quiesce: () => {
      counts.quiesce += 1;
      overrides?.onQuiesce?.();
    },
    closeDoomed: async (doomed) => {
      counts.close += 1;
      overrides?.onCloseDoomed?.(doomed);
    },
    showError: async (message, ...actions) => {
      counts.showError += 1;
      showChoices.push(...actions);
      void message;
      return showReturn;
    },
    revealStorage: async () => {
      counts.reveal += 1;
    },
    reloadWindow: async () => {
      counts.reload += 1;
      overrides?.onReloadWindow?.();
    },
    resetStorage: async () => {
      counts.reset += 1;
      overrides?.onResetStorage?.();
    },
    guidanceFor: () =>
      overrides?.guidance ?? 'Recover by revealing the storage folder.',
  });

  return { lifecycle, counts, logPayloads, showChoices, setShowReturn: (v: string | undefined) => { showReturn = v; } };
}

describe('createTerminalStorageLifecycle exact-once', () => {
  it('activation callback + catch: quiesce/log/UI/close once', async () => {
    const { lifecycle, counts, logPayloads } = makeLifecycle();
    // Terminal during open: sync quiesce, store, no report yet.
    const signal = lifecycle.handleTerminalSignal(
      new Error('corrupt during open'),
      { id: 'not-yet-published-client' },
    );
    expect(signal).toBeUndefined();
    expect(counts.quiesce).toBe(1);
    expect(counts.log).toBe(0);

    const pending = lifecycle.takePendingActivationError();
    await lifecycle.reportOnce(pending ?? new Error('open failed'), {
      operation: 'open',
      doomed: {},
      showUi: true,
    });

    expect(counts.quiesce).toBe(1);
    expect(counts.log).toBe(1);
    expect(counts.close).toBe(1);
    expect(counts.showError).toBe(1);
    expect(logPayloads[0]).toMatchObject({ code: 'corrupt' });
    // No raw path/SQL in payload.
    expect(JSON.stringify(logPayloads[0])).not.toMatch(/\/Users\/|SELECT |INSERT /i);
  });

  it('concurrent runtime reports share one promise and exact-once counts', async () => {
    const doomed = { id: 'runtime-client' };
    const closed: unknown[] = [];
    let publishedClient: typeof doomed | undefined = doomed;
    const { lifecycle, counts } = makeLifecycle({
      recoveryAction: undefined,
      onQuiesce: () => {
        publishedClient = undefined;
      },
      onCloseDoomed: (value) => closed.push(value),
    });
    lifecycle.markActivationReady();

    // Function arguments capture the live client before handleTerminalSignal
    // synchronously quiesces and clears the published reference.
    const p1 = lifecycle.handleTerminalSignal(new Error('a'), publishedClient);
    expect(publishedClient).toBeUndefined();
    const p2 = lifecycle.handleTerminalSignal(new Error('b'), publishedClient);
    expect(p1).toBeDefined();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);

    expect(counts.quiesce).toBe(1);
    expect(counts.log).toBe(1);
    expect(counts.close).toBe(1);
    expect(counts.showError).toBe(1);
    expect(closed).toEqual([doomed]);
  });

  it('canceling Reveal Storage Folder performs no reveal/reset', async () => {
    const { lifecycle, counts, setShowReturn } = makeLifecycle({
      recoveryAction: 'reveal_storage',
    });
    setShowReturn(undefined); // user cancels
    lifecycle.markActivationReady();
    await lifecycle.reportOnce(new Error('corrupt'), {
      operation: 'unknown',
      doomed: {},
      showUi: true,
    });
    expect(counts.showError).toBe(1);
    expect(counts.reveal).toBe(0);
    expect(counts.reset).toBe(0);
  });

  it('incompatible schema offers coordinated reset and reveal, then runs reset on accept', async () => {
    const { lifecycle, counts, showChoices, setShowReturn } = makeLifecycle({
      code: 'incompatible_schema',
      recoveryAction: 'reveal_storage',
    });
    setShowReturn(RESET_MUSTER_DATA_ACTION);
    lifecycle.markActivationReady();

    await lifecycle.reportOnce(new Error('incompatible_schema'), {
      operation: 'open',
      doomed: {},
      showUi: true,
    });

    expect(showChoices).toEqual([
      RESET_MUSTER_DATA_ACTION,
      REVEAL_STORAGE_FOLDER_ACTION,
    ]);
    expect(counts.reset).toBe(1);
    expect(counts.reveal).toBe(0);
  });

  it('schema_changed offers Reload Window, reloads on accept, and never reveals storage', async () => {
    const { lifecycle, counts, showChoices, setShowReturn } = makeLifecycle({
      code: 'schema_changed',
      recoveryAction: 'reload_window',
      message: 'Muster storage schema was upgraded in another window.',
      guidance: 'Reload this window to continue with the upgraded schema.',
    });
    setShowReturn('Reload Window');
    lifecycle.markActivationReady();

    await lifecycle.reportOnce(new Error('schema_changed'), {
      operation: 'unknown',
      doomed: { id: 'stale-worker' },
      showUi: true,
    });

    expect(counts.quiesce).toBe(1);
    expect(counts.close).toBe(1);
    expect(counts.showError).toBe(1);
    expect(showChoices).toEqual(['Reload Window']);
    expect(counts.reload).toBe(1);
    expect(counts.reveal).toBe(0);
  });

  it('canceling Reload Window performs no reload or reset', async () => {
    const { lifecycle, counts, setShowReturn } = makeLifecycle({
      code: 'schema_changed',
      recoveryAction: 'reload_window',
      guidance: 'Reload this window to continue.',
    });
    setShowReturn(undefined);
    lifecycle.markActivationReady();
    await lifecycle.reportOnce(new Error('schema_changed'), {
      operation: 'unknown',
      doomed: {},
      showUi: true,
    });
    expect(counts.showError).toBe(1);
    expect(counts.reload).toBe(0);
    expect(counts.reveal).toBe(0);
  });
});
