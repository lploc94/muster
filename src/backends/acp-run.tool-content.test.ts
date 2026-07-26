// M020/S01/T01 — ACP tool content union parsing (diff evidence).
//
// Proves extractToolOutput / mapSessionUpdate keep content-only and rawOutput
// behavior byte-identical while capturing structured `diff` blocks as
// `fileChanges` on toolUpdated / toolCompleted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RunOptions, ToolFileChange } from '../types';
import { makeFakeAcpClient, runTurn, type FakeAcpHarness } from './acp-test-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { ClaudeBackend } from './claude';

function options(over: Partial<RunOptions> = {}): RunOptions {
  return { prompt: 'hello', ...over };
}

function toolCompleted(events: NormalizedEvent[]) {
  return events.find((e) => e.type === 'toolCompleted') as Extract<
    NormalizedEvent,
    { type: 'toolCompleted' }
  >;
}

function toolUpdated(events: NormalizedEvent[]) {
  return events.find((e) => e.type === 'toolUpdated') as Extract<
    NormalizedEvent,
    { type: 'toolUpdated' }
  >;
}

let fake: FakeAcpHarness;

beforeEach(() => {
  fake = makeFakeAcpClient();
  H.current = fake;
});

afterEach(() => {
  H.current = null;
});

describe('ACP tool content union — content-only regression', () => {
  it('keeps content-only completed output as plain text with no fileChanges field', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'abc',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
      ],
    });
    expect(events).toContainEqual({
      type: 'toolCompleted',
      toolCallId: 'claude:abc',
      outcome: 'success',
      output: 'done',
      meta: undefined,
    });
    const done = toolCompleted(events);
    expect(done).not.toHaveProperty('fileChanges');
  });

  it('falls back to structured rawOutput when content is not an array', async () => {
    const rawOutput = { result: { ok: true }, error: null };
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'abc',
          status: 'completed',
          rawOutput,
          // non-array content must not be treated as tool-call blocks
          content: { unexpected: true },
        },
      ],
    });
    expect(events).toContainEqual({
      type: 'toolCompleted',
      toolCallId: 'claude:abc',
      outcome: 'success',
      output: rawOutput,
      meta: undefined,
    });
    expect(toolCompleted(events)).not.toHaveProperty('fileChanges');
  });

  it('falls back to rawOutput when content array has no content/diff text block', async () => {
    const rawOutput = { exitCode: 0 };
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'abc',
          status: 'completed',
          rawOutput,
          content: [{ type: 'terminal', terminalId: 'term-1' }],
        },
      ],
    });
    expect(toolCompleted(events)).toMatchObject({
      type: 'toolCompleted',
      toolCallId: 'claude:abc',
      outcome: 'success',
      output: rawOutput,
    });
    expect(toolCompleted(events)).not.toHaveProperty('fileChanges');
  });
});

describe('ACP tool content union — diff evidence', () => {
  it('captures a single diff block on completed tool_call_update as fileChanges', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-1',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: 'src/hello.ts',
              oldText: 'const x = 1;\n',
              newText: 'const x = 2;\n',
            },
          ],
        },
      ],
    });
    const done = toolCompleted(events);
    expect(done.outcome).toBe('success');
    expect(done.fileChanges).toEqual([
      {
        path: 'src/hello.ts',
        oldText: 'const x = 1;\n',
        newText: 'const x = 2;\n',
      } satisfies ToolFileChange,
    ]);
  });

  it('captures multiple diff blocks and preserves content text output', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-2',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'edited 2 files' } },
            {
              type: 'diff',
              path: 'a.ts',
              oldText: 'a',
              newText: 'A',
            },
            {
              type: 'diff',
              path: 'b.ts',
              oldText: null,
              newText: 'new file\n',
            },
          ],
        },
      ],
    });
    const done = toolCompleted(events);
    expect(done.output).toBe('edited 2 files');
    expect(done.fileChanges).toEqual([
      { path: 'a.ts', oldText: 'a', newText: 'A' },
      { path: 'b.ts', oldText: null, newText: 'new file\n' },
    ]);
  });

  it('emits fileChanges on in-progress toolUpdated (permission-time evidence)', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-3',
          status: 'in_progress',
          rawInput: { path: 'src/hello.ts' },
          content: [
            {
              type: 'diff',
              path: 'src/hello.ts',
              oldText: 'old',
              newText: 'new',
            },
          ],
        },
      ],
    });
    const updated = toolUpdated(events);
    expect(updated).toMatchObject({
      type: 'toolUpdated',
      toolCallId: 'claude:edit-3',
      input: { path: 'src/hello.ts' },
    });
    expect(updated.fileChanges).toEqual([
      { path: 'src/hello.ts', oldText: 'old', newText: 'new' },
    ]);
  });

  it('carries fileChanges on failed toolCompleted without changing error text', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-4',
          status: 'failed',
          content: [
            { type: 'content', content: { type: 'text', text: 'write failed' } },
            {
              type: 'diff',
              path: 'x.ts',
              oldText: '1',
              newText: '2',
            },
          ],
        },
      ],
    });
    const done = toolCompleted(events);
    expect(done.outcome).toBe('error');
    expect(done.error).toBe('write failed');
    expect(done.fileChanges).toEqual([{ path: 'x.ts', oldText: '1', newText: '2' }]);
  });
});

describe('ACP tool content union — malformed / unknown blocks', () => {
  it('skips malformed diff blocks and keeps valid ones', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-5',
          status: 'completed',
          content: [
            { type: 'diff', path: 123, oldText: 'a', newText: 'b' }, // bad path
            { type: 'diff', path: 'ok.ts', oldText: 'a' }, // missing newText
            { type: 'diff', path: 'good.ts', oldText: 'x', newText: 'y' },
            { type: 'mystery', payload: true },
            null,
            'not-an-object',
          ],
        },
      ],
    });
    const done = toolCompleted(events);
    expect(done.fileChanges).toEqual([{ path: 'good.ts', oldText: 'x', newText: 'y' }]);
  });

  it('omits fileChanges when every diff block is malformed', async () => {
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-6',
          status: 'completed',
          rawOutput: 'fallback',
          content: [
            { type: 'diff', path: 'x.ts' }, // missing newText
            { type: 'unknown' },
          ],
        },
      ],
    });
    const done = toolCompleted(events);
    expect(done.output).toBe('fallback');
    expect(done).not.toHaveProperty('fileChanges');
  });

  it('treats non-string oldText as null when newText and path are valid', async () => {
    // ACP allows nullish oldText (create). Non-string non-null is treated as null
    // only when oldText is null/undefined; other non-strings are skipped as malformed.
    const events = await runTurn(new ClaudeBackend(), options(), fake, {
      updates: [
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-7',
          status: 'completed',
          content: [
            { type: 'diff', path: 'create.ts', oldText: undefined, newText: 'fresh\n' },
            { type: 'diff', path: 'bad.ts', oldText: { nested: true }, newText: 'x' },
          ],
        },
      ],
    });
    const done = toolCompleted(events);
    expect(done.fileChanges).toEqual([
      { path: 'create.ts', oldText: null, newText: 'fresh\n' },
    ]);
  });
});
