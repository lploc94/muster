/**
 * M023/S07 Extension Development Host entrypoint. It drives the existing
 * UAT-only production paths then captures the real webview DOM via the
 * correlated render probe; it never accesses the SQLite file directly.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { UAT_COMMANDS, type StorageLifecycleState, type UatHostState } from '../src/host/uat-commands';
import type { RenderProbeObservation } from '../src/host/webview-render-probe';

export type TruncatedRenderHostResult = {
  ok: true;
  kind: 'm023-s07-truncated-render-host-result';
  schemaVersion: 1;
  vscodeVersion: string;
  hostMode: 'extension-development-host';
  probeSource: 'live-extension-host-dom';
  observation: RenderProbeObservation;
};

const ACTIVE_TASK_ID = 'uat-storage-seed-active';
const POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function command<T>(id: string, args?: unknown): Promise<T> {
  return (await vscode.commands.executeCommand(id, args)) as T;
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  describeLast?: (value: T | undefined) => string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timeout waiting for ${label}${describeLast ? `; ${describeLast(last)}` : ''}`);
    }
    await sleep(POLL_MS);
  }
}

function describeRenderProbeObservation(observation: RenderProbeObservation | undefined): string {
  if (!observation) return 'last observation: unavailable';
  const retentionFiles = observation.files.filter((file) => file.retentionTruncated).length;
  const liveFilesWithDiff = observation.files.filter(
    (file) => !file.retentionTruncated && file.hasDiffBody,
  ).length;
  return `last observation: files=${observation.files.length}, groups=${observation.fileChangeGroups.length}, retentionFiles=${retentionFiles}, liveFilesWithDiff=${liveFilesWithDiff}`;
}

function writeResult(result: TruncatedRenderHostResult): void {
  const out = process.env.MUSTER_UAT_HOST_RESULT_OUT;
  if (!out) return;
  fs.writeFileSync(`${out}.tmp`, `${JSON.stringify(result)}\n`);
  fs.renameSync(`${out}.tmp`, out);
}

export async function run(): Promise<void> {
  assert.equal(process.env.MUSTER_UAT_MODE, '1', 'MUSTER_UAT_MODE=1 is required');
  const extension = vscode.extensions.getExtension('tlelabs.muster');
  assert.ok(extension, 'packaged tlelabs.muster extension was not discovered');
  await extension.activate();
  assert.equal(extension.isActive, true, 'packaged extension failed to activate');
  await command('muster.openChat');
  await waitFor<UatHostState>(
    'webview hydration',
    () => command(UAT_COMMANDS.hostState),
    (state) => state.viewResolved && state.viewVisible && state.pollingReady,
  );

  await command(UAT_COMMANDS.seedStorageWorkload);
  const seeded = await command<StorageLifecycleState>(UAT_COMMANDS.storageLifecycleState);
  await command(UAT_COMMANDS.runRetentionPass);
  await waitFor<StorageLifecycleState>(
    'retention truncation',
    () => command(UAT_COMMANDS.storageLifecycleState),
    (state) => state.retentionTruncatedEntries >= 4 && state.retention.failedPasses === seeded.retention.failedPasses,
  );
  // Force a production focus transition so snapshot hydration carries the
  // rewritten retained payloads into the real webview before DOM collection.
  await command(UAT_COMMANDS.focusTask, { taskId: null });
  await command(UAT_COMMANDS.focusTask, { taskId: ACTIVE_TASK_ID });

  const observation = await waitFor<RenderProbeObservation>(
    'rendered retention and live file changes',
    () => command(UAT_COMMANDS.renderProbe),
    (candidate) => candidate.files.some((file) => file.retentionTruncated) &&
      candidate.files.some((file) => !file.retentionTruncated && file.hasDiffBody),
    describeRenderProbeObservation,
  );
  const result: TruncatedRenderHostResult = {
    ok: true,
    kind: 'm023-s07-truncated-render-host-result',
    schemaVersion: 1,
    vscodeVersion: vscode.version,
    hostMode: 'extension-development-host',
    probeSource: 'live-extension-host-dom',
    observation,
  };
  writeResult(result);
  console.log(`[m023-s07-truncated-render-host] files=${observation.files.length} groups=${observation.fileChangeGroups.length}`);
}
