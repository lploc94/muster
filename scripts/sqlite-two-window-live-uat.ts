/**
 * Live two-window UAT entrypoint. Each role runs in a separate real VS Code
 * Extension Host against the packaged extension contents and one shared SQLite
 * file. Role A orchestrates; role B serves a content-safe command mailbox.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { UAT_COMMANDS, type UatHostState } from '../src/host/uat-commands';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type PeerRequest = {
  id: number;
  command: string;
  args?: Json;
};

type PeerResponse = {
  id: number;
  ok: boolean;
  result?: Json;
  error?: string;
};

type PeerReady = {
  role: 'B';
  generation: number;
  vscodeVersion: string;
  nodeVersion: string;
  sessionId: string;
};

type ScenarioResult = {
  id: string;
  verdict: 'PASS' | 'FAIL';
  detail: string;
};

type DbIdentity = {
  dbFileToken: string;
  workspaceId: string;
  workspaceIdentityKey: string;
  applicationId: number;
  userVersion: number;
  pageCount: number;
  byteSize: number;
  journalMode: string;
  dataVersion: number;
};

type DurableSurfaces = {
  sendOutbox: Array<{ clientRequestId: string; status: string }>;
  presentation?: { presentationId: string; revision: number; markdownLength: number };
};

const ROLE = process.env.MUSTER_UAT_ROLE ?? '';
const CONTROL_DIR = process.env.MUSTER_UAT_CONTROL_DIR ?? '';
const PEER_GENERATION = Number.parseInt(process.env.MUSTER_UAT_PEER_GENERATION ?? '1', 10);
const POLL_MS = 75;
const DEFAULT_TIMEOUT_MS = 90_000;

function controlPath(...parts: string[]): string {
  return path.join(CONTROL_DIR, ...parts);
}

function writeJson(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson<T>(
  filePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = readJson<T>(filePath);
    if (value && predicate(value)) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${path.basename(filePath)}`);
    }
    await sleep(POLL_MS);
  }
}

async function cmd<T = Json>(command: string, args?: Json): Promise<T> {
  return (await vscode.commands.executeCommand(command, args)) as T;
}

async function waitForLocalHostState(
  label: string,
  predicate: (state: UatHostState) => boolean,
  timeoutMs = 30_000,
): Promise<UatHostState> {
  const start = Date.now();
  for (;;) {
    const state = await cmd<UatHostState>(UAT_COMMANDS.hostState);
    if (predicate(state)) return state;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for local ${label}`);
    await sleep(POLL_MS);
  }
}

async function activateMuster(): Promise<{ sessionId: string }> {
  const extension = vscode.extensions.getExtension('tlelabs.muster');
  assert.ok(extension, 'packaged tlelabs.muster was not discovered');
  await extension.activate();
  assert.equal(extension.isActive, true, 'extension failed to activate');
  const ping = await cmd<{ ok: boolean; sessionId: string }>(UAT_COMMANDS.ping);
  assert.equal(ping.ok, true, 'UAT surface is unavailable');

  // Resolve the real WebviewView. Its production visibility callback owns
  // hydration, polling start/stop, and hide/reveal recovery.
  await vscode.commands.executeCommand('muster.openChat');
  await waitForLocalHostState(
    'webview hydration',
    (state) => state.viewResolved && state.viewVisible && state.pollingReady,
  );
  const active = await cmd<UatHostState>(UAT_COMMANDS.forcePollingActive);
  assert.equal(active.focusGateOverridden, true);
  assert.equal(active.viewVisible, true);
  return { sessionId: ping.sessionId };
}

function nextPeerRequestId(): number {
  let max = 0;
  for (const name of fs.readdirSync(CONTROL_DIR)) {
    const match = /^peer-request-(\d+)\.json$/.exec(name);
    if (match) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max + 1;
}

async function peerExecute(request: PeerRequest): Promise<PeerResponse> {
  const requestPath = controlPath(`peer-request-${request.id}.json`);
  const responsePath = controlPath(`peer-response-${request.id}.json`);
  writeJson(requestPath, request);
  const response = await waitForJson<PeerResponse>(
    responsePath,
    (value) => value.id === request.id,
  );
  if (!response.ok) throw new Error(`peer command failed: ${response.error ?? 'unknown'}`);
  return response;
}

async function servePeerB(): Promise<void> {
  const ping = await activateMuster();
  // Compute before publishing ready so A cannot create the next request between
  // the restart scan and the peer loop cursor.
  let nextId = nextPeerRequestId();
  writeJson(controlPath('ready-b.json'), {
    role: 'B',
    generation: PEER_GENERATION,
    vscodeVersion: vscode.version,
    nodeVersion: process.versions.node,
    sessionId: ping.sessionId,
  } satisfies PeerReady);

  const allowedCommands = new Set<string>([
    ...Object.values(UAT_COMMANDS),
    'muster.openChat',
    'workbench.action.closeSidebar',
  ]);
  const start = Date.now();
  for (;;) {
    if (fs.existsSync(controlPath('done.json'))) return;
    if (PEER_GENERATION === 1 && fs.existsSync(controlPath('restart-b.json'))) return;
    if (Date.now() - start > 240_000) throw new Error('peer B timed out waiting for work');

    const requestPath = controlPath(`peer-request-${nextId}.json`);
    if (!fs.existsSync(requestPath)) {
      await sleep(POLL_MS);
      continue;
    }
    const request = readJson<PeerRequest>(requestPath);
    if (!request || request.id !== nextId) {
      await sleep(POLL_MS);
      continue;
    }
    try {
      if (!allowedCommands.has(request.command)) throw new Error('peer command is not allowlisted');
      const result = (await vscode.commands.executeCommand(request.command, request.args)) as Json;
      writeJson(controlPath(`peer-response-${nextId}.json`), {
        id: nextId,
        ok: true,
        result,
      } satisfies PeerResponse);
    } catch (error) {
      writeJson(controlPath(`peer-response-${nextId}.json`), {
        id: nextId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PeerResponse);
    }
    nextId += 1;
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function progress(step: string, detail?: Json): void {
  writeJson(controlPath('progress-a.json'), {
    step,
    detail: detail ?? null,
    at: new Date().toISOString(),
  });
  console.log(`[uat-a] ${step}`);
}

async function runOrchestratorA(): Promise<void> {
  progress('activate');
  const pingA = await activateMuster();
  writeJson(controlPath('ready-a.json'), {
    role: 'A',
    vscodeVersion: vscode.version,
    nodeVersion: process.versions.node,
    sessionId: pingA.sessionId,
  });
  const readyB1 = await waitForJson<PeerReady>(
    controlPath('ready-b.json'),
    (value) => value.generation === 1,
  );

  let peerId = nextPeerRequestId();
  const peer = async <T = Json>(command: string, args?: Json): Promise<T> => {
    const response = await peerExecute({ id: peerId, command, args });
    peerId += 1;
    return (response.result ?? null) as T;
  };
  const waitForPeerHostState = async (
    label: string,
    predicate: (state: UatHostState) => boolean,
    timeoutMs = 30_000,
  ): Promise<UatHostState> => {
    const start = Date.now();
    for (;;) {
      const state = await peer<UatHostState>(UAT_COMMANDS.hostState);
      if (predicate(state)) return state;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for peer ${label}`);
      await sleep(POLL_MS);
    }
  };

  progress('identity');
  const identityA = await cmd<DbIdentity>(UAT_COMMANDS.identity);
  const identityB = await peer<DbIdentity>(UAT_COMMANDS.identity);
  assert.equal(identityA.dbFileToken, identityB.dbFileToken, 'hosts opened different DB files');
  assert.equal(identityA.workspaceId, identityB.workspaceId, 'workspace ids diverged');
  assert.notEqual(pingA.sessionId, readyB1.sessionId, 'expected distinct Extension Hosts');
  assert.equal(identityA.userVersion, 7, 'schema version drifted');
  assert.equal(identityB.userVersion, 7, 'peer schema version drifted');
  assert.equal(identityA.applicationId, 0x4d555354);
  assert.equal(identityA.journalMode, 'wal');

  const scenarios: ScenarioResult[] = [];
  const record = (id: string, pass: boolean, detail: string): void => {
    scenarios.push({ id, verdict: pass ? 'PASS' : 'FAIL', detail });
    if (!pass) throw new Error(`${id} FAIL: ${detail}`);
  };

  // A — peer convergence is observed from B's real engine projection/poller.
  progress('scenario-A');
  const created = await cmd<{
    taskId: string;
    messageId: string;
    workspaceRevision: number;
  }>(UAT_COMMANDS.createTaskWithMessage, {
    taskId: 'uat-task-a',
    messageId: 'uat-msg-a1',
    turnId: 'uat-turn-a1',
    goal: 'uat-a',
    content: 'from-window-a',
  });
  const bAfterCreate = await waitForPeerHostState(
    'automatic create convergence',
    (state) =>
      state.appliedWorkspaceRevision >= created.workspaceRevision &&
      state.projectionRevision >= created.workspaceRevision &&
      state.taskIds.includes(created.taskId),
  );
  await Promise.all([
    cmd(UAT_COMMANDS.focusTask, { taskId: created.taskId }),
    peer(UAT_COMMANDS.focusTask, { taskId: created.taskId }),
  ]);
  const bFocused = await waitForPeerHostState(
    'focused transcript hydrate',
    (state) => state.knownTranscriptIds.includes(created.messageId),
  );
  record(
    'A',
    bFocused.pollCount > 0,
    `automatic peer poll converged rev=${bFocused.appliedWorkspaceRevision} polls=${bFocused.pollCount}`,
  );

  // B — B writes; A receives the focused transcript patch without manual reconcile.
  progress('scenario-B');
  const appended = await peer<{ workspaceRevision: number }>(UAT_COMMANDS.appendMessage, {
    taskId: created.taskId,
    messageId: 'uat-msg-b1',
    content: 'from-window-b',
  });
  const aAfterAppend = await waitForLocalHostState(
    'automatic follow-up convergence',
    (state) =>
      state.appliedWorkspaceRevision >= appended.workspaceRevision &&
      state.knownTranscriptIds.includes('uat-msg-b1'),
  );
  record(
    'B',
    aAfterAppend.pollCount > 0,
    `automatic local poll converged rev=${aAfterAppend.appliedWorkspaceRevision} polls=${aAfterAppend.pollCount}`,
  );

  // C — interleaved writers retain contiguous revisions and both projections converge.
  progress('scenario-C');
  const c1 = await cmd<{ workspaceRevision: number }>(UAT_COMMANDS.createTaskWithMessage, {
    taskId: 'uat-task-c1', messageId: 'uat-msg-c1', turnId: 'uat-turn-c1', goal: 'c1',
  });
  const c2 = await peer<{ workspaceRevision: number }>(UAT_COMMANDS.createTaskWithMessage, {
    taskId: 'uat-task-c2', messageId: 'uat-msg-c2', turnId: 'uat-turn-c2', goal: 'c2',
  });
  const c3 = await cmd<{ workspaceRevision: number }>(UAT_COMMANDS.createTaskWithMessage, {
    taskId: 'uat-task-c3', messageId: 'uat-msg-c3', turnId: 'uat-turn-c3', goal: 'c3',
  });
  const expectedTasks = ['uat-task-a', 'uat-task-c1', 'uat-task-c2', 'uat-task-c3'].sort();
  const [aAfterC, bAfterC] = await Promise.all([
    waitForLocalHostState(
      'interleaved convergence',
      (state) => state.appliedWorkspaceRevision >= c3.workspaceRevision &&
        expectedTasks.every((id) => state.taskIds.includes(id)),
    ),
    waitForPeerHostState(
      'interleaved convergence',
      (state) => state.appliedWorkspaceRevision >= c3.workspaceRevision &&
        expectedTasks.every((id) => state.taskIds.includes(id)),
    ),
  ]);
  record(
    'C',
    c2.workspaceRevision === c1.workspaceRevision + 1 &&
      c3.workspaceRevision === c2.workspaceRevision + 1 &&
      arraysEqual([...aAfterC.taskIds].sort(), [...bAfterC.taskIds].sort()),
    `contiguous revisions=${c1.workspaceRevision},${c2.workspaceRevision},${c3.workspaceRevision}`,
  );

  // D — the atomic queued follow-up is absent from chat until promotion.
  progress('scenario-D');
  const queued = await cmd<{ workspaceRevision: number }>(UAT_COMMANDS.enqueueFollowUp, {
    taskId: created.taskId,
    turnId: 'uat-turn-queue',
    messageId: 'uat-msg-queue',
    sequence: 10,
    content: 'queued-follow-up',
  });
  const bQueued = await waitForPeerHostState(
    'queued follow-up',
    (state) =>
      state.appliedWorkspaceRevision >= queued.workspaceRevision &&
      (state.queuedTurnIdsByTask[created.taskId] ?? []).includes('uat-turn-queue'),
  );
  const queuedHidden = !bQueued.knownTranscriptIds.includes('uat-msg-queue');
  const promoted = await cmd<{ workspaceRevision: number }>(UAT_COMMANDS.promoteFollowUp, {
    turnId: 'uat-turn-queue',
  });
  const bPromoted = await waitForPeerHostState(
    'promoted follow-up',
    (state) =>
      state.appliedWorkspaceRevision >= promoted.workspaceRevision &&
      state.knownTranscriptIds.includes('uat-msg-queue'),
  );
  record(
    'D',
    queuedHidden && bPromoted.knownTranscriptIds.filter((id) => id === 'uat-msg-queue').length === 1,
    `queuedHidden=${queuedHidden} promotedVisible=true rev=${bPromoted.appliedWorkspaceRevision}`,
  );

  // E — use the real sidebar visibility event, not a simulated provider method.
  progress('scenario-E');
  await peer('workbench.action.closeSidebar');
  const bHidden = await waitForPeerHostState(
    'real hidden view',
    (state) => !state.viewVisible && !state.pollingReady,
  );
  const hiddenWrite = await cmd<{ workspaceRevision: number }>(UAT_COMMANDS.appendMessage, {
    taskId: created.taskId,
    messageId: 'uat-msg-hidden',
    content: 'while-b-hidden',
  });
  await sleep(600);
  const bStillHidden = await peer<UatHostState>(UAT_COMMANDS.hostState);
  assert.equal(bStillHidden.appliedWorkspaceRevision, bHidden.appliedWorkspaceRevision);
  await peer('muster.openChat');
  await peer(UAT_COMMANDS.forcePollingActive);
  const bRevealed = await waitForPeerHostState(
    'real reveal recovery',
    (state) =>
      state.viewVisible &&
      state.pollingReady &&
      state.appliedWorkspaceRevision >= hiddenWrite.workspaceRevision &&
      state.knownTranscriptIds.includes('uat-msg-hidden'),
  );
  record(
    'E',
    bRevealed.appliedWorkspaceRevision >= hiddenWrite.workspaceRevision,
    `real hide stopped at rev=${bHidden.appliedWorkspaceRevision}; reveal hydrated rev=${bRevealed.appliedWorkspaceRevision}`,
  );

  // F — drive the production loadTranscriptPage route in the packaged host.
  progress('scenario-F');
  let pageSeedRevision = hiddenWrite.workspaceRevision;
  for (let i = 0; i < 4; i += 1) {
    pageSeedRevision = (await cmd<{ workspaceRevision: number }>(UAT_COMMANDS.appendMessage, {
      taskId: created.taskId,
      messageId: `uat-msg-page-${i}`,
      content: `page-${i}`,
    })).workspaceRevision;
  }
  await waitForPeerHostState(
    'page seed convergence',
    (state) => state.appliedWorkspaceRevision >= pageSeedRevision,
  );
  const page = await peer<{
    latestIds: string[];
    olderIds: string[];
    hasMoreBeforeLatest: boolean;
  }>(UAT_COMMANDS.loadOlderTranscript, { taskId: created.taskId, limit: 2 });
  record(
    'F',
    page.latestIds.length === 2 &&
      page.olderIds.length > 0 &&
      page.hasMoreBeforeLatest &&
      page.latestIds.every((id) => !page.olderIds.includes(id)),
    `host route latest=${page.latestIds.length} older=${page.olderIds.length}`,
  );

  // G — a focused transcript delete must converge through the v9 remove patch,
  // without falling back to a snapshot in either host.
  progress('scenario-G');
  const beforeDelete = await peer<UatHostState>(UAT_COMMANDS.hostState);
  const deleted = await cmd<{ workspaceRevision: number }>(UAT_COMMANDS.deleteMessage, {
    messageId: 'uat-msg-b1',
  });
  const [aAfterDelete, bAfterDelete] = await Promise.all([
    waitForLocalHostState(
      'local remove patch',
      (state) =>
        state.appliedWorkspaceRevision >= deleted.workspaceRevision &&
        !state.knownTranscriptIds.includes('uat-msg-b1'),
    ),
    waitForPeerHostState(
      'peer remove patch',
      (state) =>
        state.appliedWorkspaceRevision >= deleted.workspaceRevision &&
        state.externalRecoveryCount === beforeDelete.externalRecoveryCount &&
        !state.knownTranscriptIds.includes('uat-msg-b1'),
    ),
  ]);
  record(
    'G',
    !aAfterDelete.knownTranscriptIds.includes('uat-msg-b1') &&
      bAfterDelete.externalRecoveryCount === beforeDelete.externalRecoveryCount,
    `remove patch converged without recovery at rev=${bAfterDelete.appliedWorkspaceRevision}`,
  );

  // H — persist durable surfaces, terminate B, then reopen a fresh B Extension Host.
  progress('scenario-H');
  const taskIdsBeforeRestart = (await cmd<UatHostState>(UAT_COMMANDS.hostState)).taskIds;
  await cmd(UAT_COMMANDS.putSendOutbox, {
    clientRequestId: 'uat-outbox-pending',
    status: 'pending',
    taskId: 'uat-missing-task',
    text: 'pending-draft',
  });
  await cmd(UAT_COMMANDS.putSendOutbox, {
    clientRequestId: 'uat-outbox-reject', status: 'pending', text: 'reject-draft',
  });
  await cmd(UAT_COMMANDS.markSendOutboxRejected, {
    clientRequestId: 'uat-outbox-reject',
  });
  await cmd(UAT_COMMANDS.putPresentation, {
    rootId: created.taskId,
    presentationId: 'uat-plan',
    ownerTaskId: created.taskId,
    revision: 1,
    title: 'uat-plan-title',
    markdown: '# plan',
  });
  fs.rmSync(controlPath('ready-b.json'), { force: true });
  writeJson(controlPath('restart-b.json'), { requestedGeneration: 2 });
  const readyB2 = await waitForJson<PeerReady>(
    controlPath('ready-b.json'),
    (value) => value.generation === 2 && value.sessionId !== readyB1.sessionId,
    120_000,
  );
  const identityB2 = await peer<DbIdentity>(UAT_COMMANDS.identity);
  let durableB: DurableSurfaces | undefined;
  const durableStart = Date.now();
  for (;;) {
    durableB = await peer<DurableSurfaces>(UAT_COMMANDS.readDurableSurfaces, {
      rootId: created.taskId, presentationId: 'uat-plan',
    });
    if (durableB.sendOutbox.some((entry) =>
      entry.clientRequestId === 'uat-outbox-pending' && entry.status === 'rejected')) {
      break;
    }
    if (Date.now() - durableStart > 30_000) {
      throw new Error('timeout waiting for durable pending-outbox replay');
    }
    await sleep(POLL_MS);
  }
  const [durableA, restartedState] = await Promise.all([
    cmd<DurableSurfaces>(UAT_COMMANDS.readDurableSurfaces, {
      rootId: created.taskId, presentationId: 'uat-plan',
    }),
    peer<UatHostState>(UAT_COMMANDS.hostState),
  ]);
  const durableOk = [durableA, durableB].every((value) =>
    value.sendOutbox.some((entry) =>
      entry.clientRequestId === 'uat-outbox-pending' && entry.status === 'rejected') &&
    value.sendOutbox.some((entry) =>
      entry.clientRequestId === 'uat-outbox-reject' && entry.status === 'rejected') &&
    value.presentation?.presentationId === 'uat-plan' &&
    value.presentation.revision === 1 &&
    value.presentation.markdownLength > 0,
  );
  record(
    'H',
    durableOk &&
      identityB2.dbFileToken === identityA.dbFileToken &&
      arraysEqual([...restartedState.taskIds].sort(), [...taskIdsBeforeRestart].sort()),
    `peer restarted generation=${readyB2.generation}; pending replay rejected safely; durable surfaces restored`,
  );

  // I — two SQLite writers start at the same time, then both projections converge.
  progress('scenario-I');
  const [iA, iB] = await Promise.all([
    cmd<{ workspaceRevision: number }>(UAT_COMMANDS.createTaskWithMessage, {
      taskId: 'uat-task-i1', messageId: 'uat-msg-i1', turnId: 'uat-turn-i1', goal: 'i1',
    }),
    peer<{ workspaceRevision: number }>(UAT_COMMANDS.createTaskWithMessage, {
      taskId: 'uat-task-i2', messageId: 'uat-msg-i2', turnId: 'uat-turn-i2', goal: 'i2',
    }),
  ]);
  const [iA2, iB2] = await Promise.all([
    cmd<{ workspaceRevision: number }>(UAT_COMMANDS.appendMessage, {
      taskId: 'uat-task-i1', messageId: 'uat-msg-i1b',
    }),
    peer<{ workspaceRevision: number }>(UAT_COMMANDS.appendMessage, {
      taskId: 'uat-task-i2', messageId: 'uat-msg-i2b',
    }),
  ]);
  const targetRevision = Math.max(
    iA.workspaceRevision,
    iB.workspaceRevision,
    iA2.workspaceRevision,
    iB2.workspaceRevision,
  );
  const [finalA, finalB] = await Promise.all([
    waitForLocalHostState(
      'simultaneous final convergence',
      (state) => state.appliedWorkspaceRevision >= targetRevision &&
        state.taskIds.includes('uat-task-i1') && state.taskIds.includes('uat-task-i2'),
    ),
    waitForPeerHostState(
      'simultaneous final convergence',
      (state) => state.appliedWorkspaceRevision >= targetRevision &&
        state.taskIds.includes('uat-task-i1') && state.taskIds.includes('uat-task-i2'),
    ),
  ]);
  const identityFinalA = await cmd<DbIdentity>(UAT_COMMANDS.identity);
  const identityFinalB = await peer<DbIdentity>(UAT_COMMANDS.identity);
  record(
    'I',
    finalA.appliedWorkspaceRevision === finalB.appliedWorkspaceRevision &&
      arraysEqual([...finalA.taskIds].sort(), [...finalB.taskIds].sort()) &&
      identityFinalA.dbFileToken === identityFinalB.dbFileToken,
    `simultaneous writers converged rev=${finalA.appliedWorkspaceRevision} tasks=${finalA.taskIds.length}`,
  );

  writeJson(controlPath('result.json'), {
    ok: scenarios.every((scenario) => scenario.verdict === 'PASS'),
    kind: 'live-two-window-extension-host',
    vscodeVersion: vscode.version,
    nodeVersion: process.versions.node,
    schemaVersion: identityA.userVersion,
    dbIdentity: {
      dbFileToken: identityA.dbFileToken,
      applicationId: identityA.applicationId,
      userVersion: identityA.userVersion,
      pageCount: identityFinalA.pageCount,
      byteSize: identityFinalA.byteSize,
      journalMode: identityA.journalMode,
      workspaceId: identityA.workspaceId,
      workspaceIdentityKind: identityA.workspaceIdentityKey.split(':')[0] ?? 'unknown',
    },
    extensionHostsDistinct: true,
    peerRestarted: true,
    polling: {
      aPollCount: finalA.pollCount,
      bPollCount: finalB.pollCount,
      focusGateOverridden: true,
    },
    finalRevision: finalA.appliedWorkspaceRevision,
    finalTaskCount: finalA.taskIds.length,
    scenarios,
  });
  writeJson(controlPath('done.json'), { stop: true });
}

export async function run(): Promise<void> {
  assert.ok(CONTROL_DIR, 'MUSTER_UAT_CONTROL_DIR is required');
  assert.ok(ROLE === 'A' || ROLE === 'B', 'MUSTER_UAT_ROLE must be A or B');
  assert.equal(process.env.MUSTER_UAT_MODE, '1', 'MUSTER_UAT_MODE=1 is required');
  assert.ok(Number.isSafeInteger(PEER_GENERATION) && PEER_GENERATION >= 1);

  if (ROLE === 'B') {
    await servePeerB();
    return;
  }
  try {
    await runOrchestratorA();
  } catch (error) {
    writeJson(controlPath('result.json'), {
      ok: false,
      kind: 'live-two-window-extension-host',
      error: error instanceof Error ? error.message : String(error),
      vscodeVersion: vscode.version,
      nodeVersion: process.versions.node,
    });
    writeJson(controlPath('done.json'), { stop: true });
    throw error;
  }
}
