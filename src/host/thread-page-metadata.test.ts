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

describe('TaskThread page metadata source contract (P4-W4)', () => {
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
});
