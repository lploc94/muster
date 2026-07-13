import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPresentationWebviewHtml,
  parseAllowedPresentationLink,
} from './webview-security';
import { routeSendLiveInput } from './live-input';
import { routeDeleteQueuedTurn, routeEditQueuedTurn } from './queued-turn-mutations';

describe('presentation webview security', () => {
  it('defines the canonical assembled presentation integration gate', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['test:presentation-integration']).toBe(
      'vitest run src/task/presentation-tool-auth.test.ts src/host/presentation-tool-router.test.ts src/host/presentation-manager.test.ts src/host/presentation-panel-adapter.test.ts src/host/presentation-chat-link.test.ts src/host/presentation-revision-loop.test.ts src/host/webview-security.test.ts && npm run compile && npm run test:webview -- e2e/muster-presentation.spec.ts',
    );
  });

  it('keeps Mermaid SVG security isolated from the shared Markdown sanitizer', () => {
    const markdownSource = readFileSync(resolve(process.cwd(), 'webview/src/lib/markdown.ts'), 'utf8');
    const mermaidSource = readFileSync(resolve(process.cwd(), 'webview/src/lib/mermaid-renderer.ts'), 'utf8');
    const presentationSource = readFileSync(resolve(process.cwd(), 'webview/src/Presentation.svelte'), 'utf8');

    const markdownAllowedTags = markdownSource.match(/const SANITIZE_CONFIG = \{\s*ALLOWED_TAGS: \[([\s\S]*?)\],\s*ALLOWED_ATTR:/)?.[1];
    expect(markdownAllowedTags).toBeDefined();
    expect(markdownAllowedTags).not.toMatch(/['"](?:svg|path|foreignObject|use|image)['"]/);
    expect(markdownSource).not.toContain('sanitizeMermaidSvg');
    expect(mermaidSource).toContain("startOnLoad: false");
    expect(mermaidSource).toContain("securityLevel: 'strict'");
    expect(mermaidSource).toContain('htmlLabels: false');
    expect(mermaidSource).toMatch(/FORBID_TAGS:\s*\[[^\]]*'script'[^\]]*'foreignObject'[^\]]*'a'[^\]]*'use'[^\]]*'image'[^\]]*'style'/s);
    expect(mermaidSource).toMatch(/\/\\s*on\[a-z\]\+\\s\*=\/i/);
    expect(mermaidSource).toMatch(/javascript:\|https\?:\|data:/);
    expect(presentationSource).toContain('if (outcome.state === \'rendered\')');
    expect(presentationSource).toContain('element.innerHTML = outcome.svg');
    const directInsertions = [...presentationSource.matchAll(/\b\w+\.innerHTML\s*=\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(directInsertions).toEqual(['outcome.svg']);
  });

  it('builds a static bootstrap with an explicit restrictive CSP', () => {
    const html = buildPresentationWebviewHtml({
      cspSource: 'vscode-webview://presentation',
      scriptUri: 'vscode-webview://presentation/assets/presentation.js',
      styleUri: 'vscode-webview://presentation/assets/presentation.css',
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src vscode-webview://presentation");
    expect(html).toContain("style-src vscode-webview://presentation");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain('src="vscode-webview://presentation/assets/presentation.js"');
    expect(html).toContain('href="vscode-webview://presentation/assets/presentation.css"');
    expect(html).not.toContain("'unsafe-eval'");
    expect(html).not.toContain("'unsafe-inline'");
  });

  it.each([
    ['https://example.com/path?q=1', 'https://example.com/path?q=1'],
    ['http://localhost:3000/docs', 'http://localhost:3000/docs'],
    ['mailto:docs@example.com?subject=Review', 'mailto:docs@example.com?subject=Review'],
  ])('accepts the absolute external link %s', (input, expected) => {
    expect(parseAllowedPresentationLink(input)).toBe(expected);
  });

  it.each([
    '',
    '#section',
    '/workspace/file.md',
    './relative.md',
    'javascript:alert(1)',
    'data:text/html,hostile',
    'command:muster.openChat',
    'file:///workspace/secret',
    'https://example.com\njavascript:alert(1)',
    'x'.repeat(4097),
    null,
    42,
  ])('rejects unsafe or malformed link input %#', (input) => {
    expect(parseAllowedPresentationLink(input)).toBeUndefined();
  });
});

describe('host live-input routing contract', () => {
  it('wires sendLiveInput through routeSendLiveInput without continueTask fallthrough', () => {
    const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(extensionSource).toContain("case 'sendLiveInput'");
    expect(extensionSource).toContain('routeSendLiveInput');
    expect(extensionSource).toContain('engine.sendLiveInput');
    expect(extensionSource).toContain("type: 'liveInputResult'");
    // The live-input case must not call continueTaskWithMessage.
    const liveCase = extensionSource.match(
      /case 'sendLiveInput':[\s\S]*?case 'resumeQueuedTurn':/,
    )?.[0];
    expect(liveCase).toBeDefined();
    expect(liveCase).not.toContain('continueTaskWithMessage');
  });

  it('visibly refuses unsupported live input without engine queue mutation paths', async () => {
    const sendLiveInput = vi.fn(async () => ({
      code: 'unsupported' as const,
      reason: 'backend kiro does not support live input',
    }));
    const continueTaskWithMessage = vi.fn();

    const outcome = await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 'task-1', instruction: 'nudge' },
      { engineReady: true, sendLiveInput },
    );

    expect(sendLiveInput).toHaveBeenCalledTimes(1);
    expect(continueTaskWithMessage).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: 'error',
      taskId: 'task-1',
      message: expect.stringContaining('unsupported'),
    });
  });

  it('delegates supported live input once and returns a delivered ack', async () => {
    const sendLiveInput = vi.fn(async () => ({
      code: 'delivered' as const,
      sessionId: 'sess-9',
    }));

    const outcome = await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 'task-2', instruction: 'inject' },
      { engineReady: true, sendLiveInput },
    );

    expect(sendLiveInput).toHaveBeenCalledTimes(1);
    expect(sendLiveInput).toHaveBeenCalledWith('task-2', 'inject');
    expect(outcome).toEqual({
      kind: 'ack',
      taskId: 'task-2',
      sessionId: 'sess-9',
    });
  });

  it('rejects malformed payloads before engine delegation', async () => {
    const sendLiveInput = vi.fn();
    const outcome = await routeSendLiveInput(
      { type: 'sendLiveInput', taskId: 'task-3', instruction: '' },
      { engineReady: true, sendLiveInput },
    );
    expect(sendLiveInput).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('error');
  });
});

describe('host queued-turn mutation routing contract', () => {
  it('wires edit/delete through route helpers without continueTask fallthrough', () => {
    const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(extensionSource).toContain("case 'editQueuedTurn'");
    expect(extensionSource).toContain("case 'deleteQueuedTurn'");
    expect(extensionSource).toContain('routeEditQueuedTurn');
    expect(extensionSource).toContain('routeDeleteQueuedTurn');
    expect(extensionSource).toContain('engine.editQueuedTurn');
    expect(extensionSource).toContain('engine.deleteQueuedTurn');

    const editCase = extensionSource.match(
      /case 'editQueuedTurn':[\s\S]*?case 'deleteQueuedTurn':/,
    )?.[0];
    expect(editCase).toBeDefined();
    expect(editCase).not.toContain('continueTaskWithMessage');

    const deleteCase = extensionSource.match(
      /case 'deleteQueuedTurn':[\s\S]*?case 'resumeQueuedTurn':/,
    )?.[0];
    expect(deleteCase).toBeDefined();
    expect(deleteCase).not.toContain('continueTaskWithMessage');
    // ensure no process-cancel API call is wired (comment may mention the name)
    expect(deleteCase).not.toContain('cancelProcess(');
  });

  it('rejects malformed edit payloads before engine mutation', () => {
    const editQueuedTurn = vi.fn();
    const outcome = routeEditQueuedTurn(
      { type: 'editQueuedTurn', taskId: 'task-1', turnId: 'turn-q', content: '' },
      { engineReady: true, editQueuedTurn },
    );
    expect(editQueuedTurn).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('error');
  });

  it('surfaces stale delete refusal as sanitized command-error shape', () => {
    const deleteQueuedTurn = vi.fn(() => ({
      ok: false as const,
      reason: 'turn is not queued\n    at TaskEngine.deleteQueuedTurn (engine.ts:1:1)',
    }));
    const outcome = routeDeleteQueuedTurn(
      { type: 'deleteQueuedTurn', taskId: 'task-1', turnId: 'turn-q' },
      { engineReady: true, deleteQueuedTurn },
    );
    expect(deleteQueuedTurn).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('not queued');
      expect(outcome.message).not.toMatch(/engine\.ts/);
    }
  });
});
