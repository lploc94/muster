import { describe, expect, it, vi } from 'vitest';
import { quiesceForMaintenance } from './sqlite-maintenance-coordinator';

describe('quiesceForMaintenance (P5-W5)', () => {
  it('clears host refs first then shuts down engine and closes client', async () => {
    const order: string[] = [];
    const engine = {
      shutdown: vi.fn(async () => {
        order.push('shutdown');
      }),
    };
    const client = {
      close: vi.fn(async () => {
        order.push('close');
      }),
    };
    const provider = {
      disposeRevisionPoller: vi.fn(() => {
        order.push('poller');
      }),
    };
    await quiesceForMaintenance({
      productionProvider: provider,
      engine,
      client,
      stopWriters: async () => {
        order.push('writers');
      },
      clearHostRefs: () => {
        order.push('clear');
      },
    });
    expect(order[0]).toBe('poller');
    expect(order).toContain('clear');
    expect(order.indexOf('clear')).toBeLessThan(order.indexOf('shutdown'));
    expect(order.indexOf('clear')).toBeLessThan(order.indexOf('close'));
    expect(engine.shutdown).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it('propagates engine shutdown failure so reset aborts', async () => {
    await expect(
      quiesceForMaintenance({
        engine: {
          shutdown: async () => {
            throw new Error('flush failed');
          },
        },
        client: { close: async () => undefined },
        clearHostRefs: () => undefined,
      }),
    ).rejects.toThrow(/flush failed/);
  });

  it('propagates client close failure', async () => {
    await expect(
      quiesceForMaintenance({
        engine: { shutdown: async () => undefined },
        client: {
          close: async () => {
            throw new Error('close failed');
          },
        },
        clearHostRefs: () => undefined,
      }),
    ).rejects.toThrow(/close failed/);
  });
});
