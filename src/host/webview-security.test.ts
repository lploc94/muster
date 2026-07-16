import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPresentationWebviewHtml,
  parseAllowedPresentationLink,
} from './webview-security';
import { routeDeleteQueuedTurn, routeEditQueuedTurn } from './queued-turn-mutations';

describe('presentation webview security', () => {
  it('defines the canonical assembled presentation integration gate', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      activationEvents?: string[];
    };

    expect(packageJson.scripts?.['test:presentation-integration']).toBe(
      'vitest run src/task/presentation-tool-auth.test.ts src/host/presentation-tool-router.test.ts src/host/presentation-manager.test.ts src/host/presentation-panel-adapter.test.ts src/host/presentation-chat-link.test.ts src/host/presentation-revision-loop.test.ts src/host/webview-security.test.ts && npm run compile && npm run test:webview -- e2e/muster-presentation.spec.ts',
    );
    expect(packageJson.activationEvents).toContain('onWebviewPanel:muster.presentation');
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

describe('host interrupt-and-send routing contract', () => {
  it('wires sendLiveInput as interruptAndSend (reserve-then-interrupt), not concurrent inject', () => {
    const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(extensionSource).toContain("case 'sendLiveInput'");
    const liveCase = extensionSource.match(
      /case 'sendLiveInput':[\s\S]*?case 'editQueuedTurn':/,
    )?.[0];
    expect(liveCase).toBeDefined();
    expect(liveCase).toContain('interruptAndSend');
    expect(liveCase).toContain('postSnapshot');
    // Must not use concurrent inject path for composer direct messages.
    expect(liveCase).not.toContain('routeSendLiveInput');
    expect(liveCase).not.toContain('engine.sendLiveInput');
    expect(liveCase).not.toContain("type: 'liveInputResult'");
    expect(liveCase).not.toContain("delivery: 'live_inject'");
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


describe('permission settings host routing contract', () => {
  const extensionSource = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8');
  const protocolSource = readFileSync(resolve(process.cwd(), 'webview/src/lib/protocol.ts'), 'utf8');
  const appSource = readFileSync(resolve(process.cwd(), 'webview/src/App.svelte'), 'utf8');

  it('wires requestPermissionSettings and updatePermissionSettings through the T01 helper with Workspace target', () => {
    expect(extensionSource).toContain("from './host/permission-settings'");
    expect(extensionSource).toContain('buildPermissionSettingsSnapshot');
    expect(extensionSource).toContain('handlePermissionSettingsUpdateAction');
    expect(extensionSource).toContain("case 'requestPermissionSettings'");
    expect(extensionSource).toContain("case 'updatePermissionSettings'");
    expect(extensionSource).toContain('postPermissionSettingsSnapshot');
    expect(extensionSource).toContain('handleUpdatePermissionSettings');
    expect(extensionSource).toContain("getConfiguration('muster.permissions')");
    expect(extensionSource).toContain('vscode.ConfigurationTarget.Workspace');

    const requestCase = extensionSource.match(
      /case 'requestPermissionSettings':[\s\S]*?case 'updatePermissionSettings':/,
    )?.[0];
    expect(requestCase).toBeDefined();
    expect(requestCase).toContain('postPermissionSettingsSnapshot');

    const updateCase = extensionSource.match(
      /case 'updatePermissionSettings':[\s\S]*?case 'listBackends':/,
    )?.[0];
    expect(updateCase).toBeDefined();
    expect(updateCase).toContain('handleUpdatePermissionSettings');

    const updateMethod = extensionSource.match(
      /private async handleUpdatePermissionSettings\([\s\S]*?\n  \}/,
    )?.[0];
    expect(updateMethod).toBeDefined();
    expect(updateMethod).toContain('handlePermissionSettingsUpdateAction');
    expect(updateMethod).toContain('vscode.ConfigurationTarget.Workspace');
    // Never Global or WorkspaceFolder from the custom Permissions Settings path.
    expect(updateMethod).not.toContain('ConfigurationTarget.Global');
    expect(updateMethod).not.toContain('ConfigurationTarget.WorkspaceFolder');
  });

  it('opens Settings requesting the permission snapshot alongside Task Types and Retention', () => {
    const openSettings = appSource.match(/function openSettings\(\)[\s\S]*?\n  \}/)?.[0];
    expect(openSettings).toBeDefined();
    expect(openSettings).toContain("type: 'requestSettings'");
    expect(openSettings).toContain("type: 'requestTaskTypesSettings'");
    expect(openSettings).toContain("type: 'requestPermissionSettings'");

    const requestSettingsCase = extensionSource.match(
      /case 'requestSettings':[\s\S]*?case 'updateSetting':/,
    )?.[0];
    expect(requestSettingsCase).toBeDefined();
    expect(requestSettingsCase).toContain('postSettingsSnapshot');
    expect(requestSettingsCase).toContain('postTaskTypesSettingsSnapshot');
    expect(requestSettingsCase).toContain('postPermissionSettingsSnapshot');
  });

  it('keeps runtime permission prompt routes distinct from configuration messages', () => {
    expect(extensionSource).toContain("case 'submitPermission'");
    expect(extensionSource).toContain("case 'cancelPermission'");
    expect(protocolSource).toContain("type: 'permissionPending'");
    expect(protocolSource).toContain("type: 'permissionCleared'");
    expect(protocolSource).toContain("type: 'permissionSettingsSnapshot'");
    expect(protocolSource).toContain("type: 'permissionSettingsUpdateResult'");
    expect(protocolSource).toContain("type: 'requestPermissionSettings'");
    expect(protocolSource).toContain("type: 'updatePermissionSettings'");

    // Runtime option submission remains separate from settings mode updates.
    const submitCase = extensionSource.match(
      /case 'submitPermission':[\s\S]*?case 'cancelPermission':/,
    )?.[0];
    expect(submitCase).toBeDefined();
    expect(submitCase).not.toContain('handleUpdatePermissionSettings');
    expect(submitCase).not.toContain('handlePermissionSettingsUpdateAction');
  });

  it('proves malformed updates never reach configuration.update and raw errors never cross the webview boundary', async () => {
    const {
      handlePermissionSettingsUpdateAction,
    } = await import('./permission-settings');

    const update = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn(() => 'ask');
    const configuration = { get, update };

    const malformed = await handlePermissionSettingsUpdateAction(
      configuration,
      { mode: 'prompt', extra: true },
      Symbol('workspace-target'),
    );
    expect(update).not.toHaveBeenCalled();
    expect(malformed).toEqual([
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'invalidPayload',
          message: 'Unsupported permission mode update.',
        },
      },
    ]);

    update.mockRejectedValueOnce(new Error('ENOENT /secret/path token=abc123\n    at update (extension.ts:1:1)'));
    const failed = await handlePermissionSettingsUpdateAction(
      configuration,
      { mode: 'allow' },
      Symbol('workspace-target'),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(failed).toEqual([
      {
        type: 'permissionSettingsUpdateResult',
        result: {
          ok: false,
          code: 'updateFailed',
          message: 'Unable to update permission mode.',
        },
      },
    ]);
    expect(JSON.stringify(failed)).not.toMatch(/ENOENT|\/secret\/|token=|extension\.ts/);
  });
});
