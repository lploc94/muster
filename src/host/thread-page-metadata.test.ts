import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * TaskThread lives in a webview .svelte.ts module that evaluates `$state` at
 * import time. Node vitest cannot load it without the Svelte compiler plugin,
 * and the webview tsconfig has no Node types — so this Node-side suite under
 * src/ is the source-contract regression for the W4 page-metadata lifecycle.
 */
const threadSource = fs.readFileSync(
  path.join(process.cwd(), 'webview/src/lib/thread.svelte.ts'),
  'utf8',
);

describe('TaskThread page metadata source contract (P4-W4/W5)', () => {
  it('declares the three page-state fields', () => {
    expect(threadSource).toContain('beforeCursor = $state');
    expect(threadSource).toContain('hasMoreBefore = $state');
    expect(threadSource).toContain('transcriptWorkspaceRevision = $state');
  });

  it('hydrate replaces page metadata from transcriptPage options', () => {
    expect(threadSource).toContain('this.beforeCursor = opts?.transcriptPage?.beforeCursor');
    expect(threadSource).toContain(
      'this.hasMoreBefore = opts?.transcriptPage?.hasMoreBefore ?? false',
    );
    expect(threadSource).toContain(
      'this.transcriptWorkspaceRevision = opts?.transcriptPage?.workspaceRevision',
    );
  });

  it('reset clears page metadata so focus change cannot retain a stale cursor', () => {
    // Isolate the reset() method body.
    const resetMatch = threadSource.match(/reset\(\):\s*void\s*\{([\s\S]*?)\n  \}/);
    expect(resetMatch, 'reset() method must exist').toBeTruthy();
    const body = resetMatch![1]!;
    expect(body).toContain('this.beforeCursor = undefined');
    expect(body).toContain('this.hasMoreBefore = false');
    expect(body).toContain('this.transcriptWorkspaceRevision = undefined');
  });

  it('wires older-page request/result helpers for W5', () => {
    expect(threadSource).toContain('beginLoadOlder');
    expect(threadSource).toContain('applyTranscriptPageResult');
    expect(threadSource).toContain('onTranscriptPageResult');
    expect(threadSource).toContain('olderPageLoading = $state');
    expect(threadSource).toContain('loadedTranscriptIds');
  });

  it('seeds loadedTranscriptIds on live assistant/tool paths', () => {
    expect(threadSource).toContain('this.loadedTranscriptIds.add(id)');
    expect(threadSource).toContain('this.loadedTranscriptIds.add(ev.messageId)');
  });

  it('owns activeTurnId on reasoningDelta (not backend messageId)', () => {
    const reasoningCase = threadSource.match(
      /case 'reasoningDelta':\s*\{?([\s\S]*?)break;/,
    )?.[1];
    expect(reasoningCase, 'reasoningDelta case must exist').toBeTruthy();
    expect(reasoningCase).toContain('this.loadedTranscriptIds.add(this.activeTurnId)');
    expect(reasoningCase).not.toContain('ev.messageId');
  });
});

const chatThreadSource = fs.readFileSync(
  path.join(process.cwd(), 'webview/src/components/ChatThread.svelte'),
  'utf8',
);

describe('ChatThread load-older UX source contract (P4-W5)', () => {
  it('uses stable data-transcript-id rows and loadTranscriptPage post', () => {
    expect(chatThreadSource).toContain('data-transcript-id');
    expect(chatThreadSource).toContain("type: 'loadTranscriptPage'");
    expect(chatThreadSource).toContain('restorePrependScrollTop');
    expect(chatThreadSource).toContain('capturePrependAnchor');
    expect(chatThreadSource).toContain('Load earlier messages');
  });

  it('invalidates local prepend anchor when pending request is cleared without apply', () => {
    expect(chatThreadSource).toContain('clearPrependRestore');
    expect(chatThreadSource).toContain('thread.pendingRequestId === expectedId');
    expect(chatThreadSource).toContain('thread.lastAppliedRequestId === expectedId');
  });

  it('uses cancel-safe restore gating with taskId+requestId and epoch', () => {
    expect(chatThreadSource).toContain('decidePrependRestore');
    expect(chatThreadSource).toContain('pendingRestoreTaskId');
    expect(chatThreadSource).toContain('restoreEpoch');
    expect(chatThreadSource).toContain('wait_unlock');
  });
});

const extensionSource = fs.readFileSync(
  path.join(process.cwd(), 'src/extension.ts'),
  'utf8',
);
const protocolSource = fs.readFileSync(
  path.join(process.cwd(), 'webview/src/lib/protocol.ts'),
  'utf8',
);

describe('protocol v7 host+webview version contract', () => {
  it('keeps exact version 7 in both host and webview constants', () => {
    expect(protocolSource).toMatch(/export const PROTOCOL_VERSION = 9;/);
    expect(extensionSource).toMatch(/const PROTOCOL_VERSION = 9;/);
  });

  it('maps missing repository via getTask throw to unavailable', () => {
    expect(extensionSource).toContain("throw new Error('task repository not ready')");
    // Must not use getTask: async () => undefined for the not-ready path.
    const handler = extensionSource.match(
      /handleLoadTranscriptPage[\s\S]*?private async handleExportTask/,
    )?.[0];
    expect(handler, 'handleLoadTranscriptPage must exist').toBeTruthy();
    expect(handler).not.toMatch(/getTask:\s*async\s*\(\)\s*=>\s*undefined/);
  });
});
