import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const appSource = readFileSync(resolve(root, 'webview/src/App.svelte'), 'utf8');
const extensionSource = readFileSync(resolve(root, 'src/extension.ts'), 'utf8');

describe('webview ready hydration wiring', () => {
  it('requests durable hydration only after the webview message listener mounts', () => {
    const listenerIndex = appSource.indexOf("window.addEventListener('message', onMessage)");
    const readyIndex = appSource.indexOf("post({ type: 'ready' })");
    expect(listenerIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(listenerIndex);
    expect(extensionSource).toContain("case 'ready':");
    expect(extensionSource).toContain('await this.postSendOutboxSnapshot()');
    expect(extensionSource).toContain('await this.hydrateSnapshotAndResumePolling(this.focusedTaskId)');
    expect(extensionSource).not.toContain('void (async () => {\n      await this.postSendOutboxSnapshot()');
  });

  it('does not show first-run onboarding before the task snapshot is authoritative', () => {
    expect(appSource).toContain('{#if taskSnapshotHydrated}');
    expect(appSource).toContain('taskSnapshotHydrated = true');
  });
});
