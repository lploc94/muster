import { describe, expect, it, vi } from 'vitest';
import { applyTerminalStorageQuiesce } from './terminal-storage-coordinator';

describe('applyTerminalStorageQuiesce', () => {
  it('disposes production poller without requiring UAT alias', () => {
    const production = { disposeRevisionPoller: vi.fn() };
    const engine = { quiesceForTerminalStorage: vi.fn() };
    const clearHostRefs = vi.fn();
    applyTerminalStorageQuiesce({
      productionProvider: production,
      engine,
      clearHostRefs,
    });
    expect(production.disposeRevisionPoller).toHaveBeenCalledTimes(1);
    expect(engine.quiesceForTerminalStorage).toHaveBeenCalledTimes(1);
    expect(clearHostRefs).toHaveBeenCalledTimes(1);
  });

  it('still clears host when provider/engine throw', () => {
    const clearHostRefs = vi.fn();
    applyTerminalStorageQuiesce({
      productionProvider: {
        disposeRevisionPoller: () => {
          throw new Error('poller');
        },
      },
      engine: {
        quiesceForTerminalStorage: () => {
          throw new Error('engine');
        },
      },
      clearHostRefs,
    });
    expect(clearHostRefs).toHaveBeenCalledTimes(1);
  });
});
