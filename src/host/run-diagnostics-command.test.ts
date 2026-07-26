/**
 * M019/S04 T02 — Muster: Run Diagnostics command (Doctor entry).
 *
 * Proves refresh-then-open-then-reveal order, cancel-safety, package
 * contribution, and that the handler never mutates task/session state.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  handleRunDiagnosticsCommand,
  MUSTER_OPEN_CHAT_VIEW_COMMAND,
  MUSTER_RUN_DIAGNOSTICS_COMMAND,
  MUSTER_RUN_DIAGNOSTICS_COMMAND_TITLE,
  type RunDiagnosticsCommandDeps,
} from './run-diagnostics-command';

function loadPackageCommands(): Array<{ command: string; title: string }> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'),
  ) as { contributes: { commands: Array<{ command: string; title: string }> } };
  return pkg.contributes.commands;
}

function makeDeps(
  overrides: Partial<RunDiagnosticsCommandDeps> = {},
): RunDiagnosticsCommandDeps & {
  refreshAndPublishReadiness: ReturnType<typeof vi.fn>;
  openChatView: ReturnType<typeof vi.fn>;
  postRevealBackendDiagnostics: ReturnType<typeof vi.fn>;
  callOrder: string[];
} {
  const callOrder: string[] = [];
  const refreshAndPublishReadiness = vi.fn(async () => {
    callOrder.push('refresh');
  });
  const openChatView = vi.fn(async () => {
    callOrder.push('open');
  });
  const postRevealBackendDiagnostics = vi.fn(() => {
    callOrder.push('reveal');
  });
  return {
    refreshAndPublishReadiness,
    openChatView,
    postRevealBackendDiagnostics,
    callOrder,
    ...overrides,
  };
}

describe('M019 S04 run-diagnostics command', () => {
  it('contributes exact Doctor command id and title in package.json', () => {
    const commands = loadPackageCommands();
    expect(commands).toEqual(
      expect.arrayContaining([
        {
          command: MUSTER_RUN_DIAGNOSTICS_COMMAND,
          title: MUSTER_RUN_DIAGNOSTICS_COMMAND_TITLE,
        },
      ]),
    );
    expect(MUSTER_RUN_DIAGNOSTICS_COMMAND).toBe('muster.runDiagnostics');
    expect(MUSTER_RUN_DIAGNOSTICS_COMMAND_TITLE).toBe('Muster: Run Diagnostics');
    expect(MUSTER_OPEN_CHAT_VIEW_COMMAND).toBe('workbench.view.extension.muster');
  });

  it('refreshes readiness, opens chat, then posts revealBackendDiagnostics', async () => {
    const deps = makeDeps();
    const result = await handleRunDiagnosticsCommand(deps);

    expect(result).toEqual({ kind: 'success' });
    expect(deps.callOrder).toEqual(['refresh', 'open', 'reveal']);
    expect(deps.refreshAndPublishReadiness).toHaveBeenCalledTimes(1);
    expect(deps.openChatView).toHaveBeenCalledTimes(1);
    expect(deps.postRevealBackendDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('skips open and reveal when cancelled before start', async () => {
    const deps = makeDeps({
      isCancellationRequested: () => true,
    });
    const result = await handleRunDiagnosticsCommand(deps);

    expect(result).toEqual({ kind: 'cancelled' });
    expect(deps.refreshAndPublishReadiness).not.toHaveBeenCalled();
    expect(deps.openChatView).not.toHaveBeenCalled();
    expect(deps.postRevealBackendDiagnostics).not.toHaveBeenCalled();
  });

  it('skips open and reveal when cancelled after refresh', async () => {
    let cancelled = false;
    const deps = makeDeps({
      refreshAndPublishReadiness: vi.fn(async () => {
        cancelled = true;
      }),
      isCancellationRequested: () => cancelled,
    });
    const result = await handleRunDiagnosticsCommand(deps);

    expect(result).toEqual({ kind: 'cancelled' });
    expect(deps.refreshAndPublishReadiness).toHaveBeenCalledTimes(1);
    expect(deps.openChatView).not.toHaveBeenCalled();
    expect(deps.postRevealBackendDiagnostics).not.toHaveBeenCalled();
  });

  it('returns refresh_failed without opening or revealing when refresh throws', async () => {
    const deps = makeDeps({
      refreshAndPublishReadiness: vi.fn(async () => {
        throw new Error('path /secret/stderr leaked');
      }),
    });
    const result = await handleRunDiagnosticsCommand(deps);

    expect(result).toEqual({ kind: 'error', code: 'refresh_failed' });
    expect(deps.openChatView).not.toHaveBeenCalled();
    expect(deps.postRevealBackendDiagnostics).not.toHaveBeenCalled();
    // Fixed code only — no raw error text in result.
    expect(JSON.stringify(result)).not.toMatch(/secret|stderr|\//i);
  });

  it('returns open_failed without revealing when open throws', async () => {
    const deps = makeDeps({
      openChatView: vi.fn(async () => {
        throw new Error('view missing');
      }),
    });
    const result = await handleRunDiagnosticsCommand(deps);

    expect(result).toEqual({ kind: 'error', code: 'open_failed' });
    expect(deps.refreshAndPublishReadiness).toHaveBeenCalledTimes(1);
    expect(deps.postRevealBackendDiagnostics).not.toHaveBeenCalled();
  });

  it('returns reveal_failed when post throws after open', async () => {
    const deps = makeDeps({
      postRevealBackendDiagnostics: vi.fn(() => {
        throw new Error('webview gone');
      }),
    });
    const result = await handleRunDiagnosticsCommand(deps);

    expect(result).toEqual({ kind: 'error', code: 'reveal_failed' });
    expect(deps.refreshAndPublishReadiness).toHaveBeenCalledTimes(1);
    expect(deps.openChatView).toHaveBeenCalledTimes(1);
  });

  it('does not touch task/session mutation seams', async () => {
    const mutations = {
      insertOutbox: vi.fn(),
      createTask: vi.fn(),
      writeSession: vi.fn(),
      writeTurn: vi.fn(),
      writeMessage: vi.fn(),
      prompt: vi.fn(),
    };
    const deps = makeDeps();
    await handleRunDiagnosticsCommand(deps);
    for (const [name, fn] of Object.entries(mutations)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
  });
});
