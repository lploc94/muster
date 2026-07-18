#!/usr/bin/env node

/**
 * Phase 3 source-boundary audit.
 *
 * This is deliberately a small source scan rather than a runtime test: the
 * contract is about dependency direction. Runtime code may use only named
 * repository queries/commands; no filesystem store or full-envelope escape hatch exists.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_STORE_IMPORT = [
  'src/task/engine.ts',
  'src/task/engine-graph.ts',
  'src/host/snapshot.ts',
];
const NAMED_GRAPH_COMMANDS = [
  'createChildTask', 'delegateChildTask', 'createChildTaskBatch', 'delegateChildTaskBatch',
  'releaseChildTasks', 'continueChildTask', 'cancelChildTasks', 'interruptChildTask',
  'cancelChildTask', 'setChildTaskLifecycle', 'waitForChildTasks', 'completeGraphTask',
  'failGraphTask', 'askParent', 'answerChildQuestion', 'consumeCancelRequest',
];

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
  }
  return files;
}

export async function runRepositoryBoundarySmoke(rootDir = ROOT) {
  const failures = [];
  const sourceRoot = path.join(rootDir, 'src');
  let files;
  try {
    files = await walk(sourceRoot);
  } catch (error) {
    return { ok: false, failures: [`Cannot scan ${sourceRoot}: ${error.message}`] };
  }

  const texts = new Map();
  for (const file of files) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    if (rel.endsWith('.test.ts') || rel.endsWith('.testkit.ts')) continue;
    texts.set(rel, await readFile(file, 'utf8'));
  }

  for (const rel of NO_STORE_IMPORT) {
    const text = texts.get(rel);
    if (text === undefined) {
      failures.push(`Missing boundary source file: ${rel}`);
      continue;
    }
    const importsLegacyStore = /(?:from\s*|import\s*\(\s*)['"][^'"]*(?:^|\/)store['"]/.test(text);
    if (importsLegacyStore) {
      failures.push(`${rel} imports the legacy JSON store; use TaskReadPort/TaskRepository instead.`);
    }
  }

  for (const [rel, raw] of texts) {
    const text = stripComments(raw);
    if (/\.commit\s*\(/.test(text)) {
      const line = text.split('\n').findIndex((entry) => entry.includes('.commit(')) + 1;
      failures.push(`${rel}:${line} calls .commit(); use a named repository command.`);
    }
    if (text.includes('readEnvelopeForMigration')) {
      failures.push(`${rel} references the removed full-envelope migration API.`);
    }
    if (text.includes('applyGraphMutation')) {
      failures.push(`${rel} still exposes the forbidden generic applyGraphMutation boundary; use a named graph command.`);
    }
  }

  const repository = texts.get('src/task/repository.ts') ?? '';
  for (const command of NAMED_GRAPH_COMMANDS) {
    if (!repository.includes(`'${command}'`)) {
      failures.push(`src/task/repository.ts is missing named graph command: ${command}`);
    }
  }

  const snapshot = texts.get('src/host/repository-snapshot.ts');
  if (snapshot?.includes('readEnvelopeForMigration')) {
    failures.push('src/host/repository-snapshot.ts must use bounded repository queries, not the migration envelope.');
  }

  // P4-W4: activation/bootstrap surfaces must stay on bounded helpers — never full
  // listMessages/listToolCalls/listReasoning/listTurns hydration.
  const BANNED_FULL_HYDRATION = [
    'listMessages(',
    'listToolCalls(',
    'listReasoning(',
    'listTurns(',
    'listTurnsForTasks(',
  ];
  for (const rel of [
    'src/host/repository-snapshot.ts',
    'src/task/repository-projection.ts',
    'src/host/transcript-page-route.ts',
    'src/host/workspace-patch.ts',
  ]) {
    const raw = texts.get(rel);
    if (raw === undefined) {
      failures.push(`Missing bounded bootstrap source file: ${rel}`);
      continue;
    }
    const code = stripComments(raw);
    for (const banned of BANNED_FULL_HYDRATION) {
      if (code.includes(banned)) {
        failures.push(`${rel} reintroduced full hydration call ${banned}; use bounded activity/page queries.`);
      }
    }
    if (rel === 'src/host/repository-snapshot.ts') {
      if (!code.includes('getTranscriptPage')) {
        failures.push(`${rel} must call getTranscriptPage for the focused bootstrap transcript.`);
      }
      if (!code.includes('BOOTSTRAP_TRANSCRIPT_LIMIT')) {
        failures.push(`${rel} must keep BOOTSTRAP_TRANSCRIPT_LIMIT as the focused page bound.`);
      }
    }
    if (rel === 'src/task/repository-projection.ts') {
      if (!code.includes('listTurnActivityForTasks')) {
        failures.push(`${rel} must load turns via listTurnActivityForTasks.`);
      }
      if (!code.includes('listActiveTurnInputMessages')) {
        failures.push(`${rel} must load active inputs via listActiveTurnInputMessages.`);
      }
    }
    // P4-W5: older-page host route must stay on getTranscriptPage with fixed limit 100.
    if (rel === 'src/host/transcript-page-route.ts') {
      if (!code.includes('getTranscriptPage')) {
        failures.push(`${rel} must call getTranscriptPage for older transcript pages.`);
      }
      if (!code.includes('TRANSCRIPT_PAGE_LIMIT') && !code.includes('BOOTSTRAP_TRANSCRIPT_LIMIT')) {
        failures.push(`${rel} must keep a fixed page limit constant (100).`);
      }
      if (code.includes('loadHistory') || code.includes('historyChunk')) {
        failures.push(`${rel} must not introduce loadHistory/historyChunk compatibility aliases.`);
      }
    }
    // P4-W7: local patch projection must not rehydrate full transcripts.
    if (rel === 'src/host/workspace-patch.ts') {
      if (code.includes('getTranscriptPage')) {
        failures.push(`${rel} must not call getTranscriptPage on the mutation path.`);
      }
      if (!code.includes('projectWorkspacePatches')) {
        failures.push(`${rel} must export projectWorkspacePatches.`);
      }
    }
  }

  // P4-W7: production host must not post legacy one-off messages.
  const extension = texts.get('src/extension.ts') ?? '';
  const extensionCode = stripComments(extension);
  if (/type:\s*['"]taskUpdated['"]/.test(extensionCode)) {
    failures.push(`src/extension.ts still posts production taskUpdated; use workspacePatchBatch.`);
  }
  if (/type:\s*['"]transcriptAppend['"]/.test(extensionCode)) {
    failures.push(`src/extension.ts still posts production transcriptAppend; use workspacePatchBatch.`);
  }
  if (!extensionCode.includes('workspacePatchBatch') && !extensionCode.includes('buildWorkspacePatchBatch')) {
    failures.push(`src/extension.ts must publish workspacePatchBatch after durable commits.`);
  }

  try {
    const matrix = await readFile(path.join(rootDir, 'docs/plans/sqlite-entity-matrix.vi.md'), 'utf8');
    for (const term of [
      'TaskStoreFile.schemaVersion', 'workspace_revisions', 'SQLite-only',
      'runtime_claims', 'expires_at', 'stale', 'taskPayload', 'wait',
      'turn_inputs', 'reasoning_segments', 'change_log', 'change_feed_watermarks',
      'send_outbox', 'presentations', 'presentation_operations',
    ]) {
      if (!matrix.includes(term)) failures.push(`sqlite-entity-matrix.vi.md is missing required parity marker: ${term}`);
    }

  // P4-W9: change feed / data_version stay behind named repository APIs.
  const repoText = texts.get('src/task/repository.ts') ?? '';
  if (!repoText.includes('getWorkspaceChangesSince') || !repoText.includes('getStorageDataVersion')) {
    failures.push('src/task/repository.ts must expose getWorkspaceChangesSince and getStorageDataVersion.');
  }
  for (const [rel, raw] of texts) {
    if (rel === 'src/task/repository.ts' || rel.startsWith('src/task/sqlite/')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.testkit.ts')) continue;
    const code = stripComments(raw);
    if (/\bchange_log\b/.test(code) || /PRAGMA\s+data_version/i.test(code) || /\.pragma\(\s*['"]data_version['"]/.test(code)) {
      failures.push(`${rel} must not query change_log or data_version directly; use TaskRepository feed APIs.`);
    }
  }

  // P5-W1: safe error contract + fault seam stay inside the DB boundary.
  const errorsText = texts.get('src/task/sqlite/errors.ts') ?? '';
  if (!errorsText.includes('MusterSqliteError') || !errorsText.includes('serializeMusterError')) {
    failures.push('src/task/sqlite/errors.ts must define MusterSqliteError and serializeMusterError.');
  }
  if (!errorsText.includes('MusterDomainError') || !errorsText.includes('MusterInvariantError')) {
    failures.push('src/task/sqlite/errors.ts must distinguish domain and invariant error classes.');
  }
  const protocolText = texts.get('src/task/sqlite/protocol.ts') ?? '';
  if (!protocolText.includes('validateRpcErrorPayload') || !protocolText.includes('parseWireErrorResponse')) {
    failures.push('src/task/sqlite/protocol.ts must define strict wire validators.');
  }
  if (!protocolText.includes('exactKeys') && !protocolText.includes('parseWireSuccessResponse')) {
    failures.push('src/task/sqlite/protocol.ts must validate exact success response shapes.');
  }
  const faultText = texts.get('src/task/sqlite/fault-inject.ts') ?? '';
  if (!faultText.includes('maybeInjectFault') || !faultText.includes('bootstrapFaultCapability')) {
    failures.push('src/task/sqlite/fault-inject.ts must export maybeInjectFault and bootstrapFaultCapability.');
  }
  // Ambient env must not arm faults without explicit capability.
  if (/parseFaultPlanFromEnv|MUSTER_SQLITE_FAULT_INJECT/.test(faultText) && !faultText.includes('faultCapability')) {
    failures.push('src/task/sqlite/fault-inject.ts must not arm faults from ambient env alone.');
  }
  if (faultText.includes('parseFaultPlanFromEnv(process.env)') || /process\.env\[.*MUSTER_SQLITE_FAULT/.test(faultText)) {
    failures.push('src/task/sqlite/fault-inject.ts must not read ambient MUSTER_SQLITE_FAULT_* env.');
  }
  const workerText = texts.get('src/task/sqlite/worker.ts') ?? '';
  if (!workerText.includes('maybeInjectFault') || !workerText.includes('serializeError')) {
    failures.push('src/task/sqlite/worker.ts must use maybeInjectFault and serializeError.');
  }
  if (!workerText.includes('bootstrapFaultCapability')) {
    failures.push('src/task/sqlite/worker.ts must bootstrap fault capability from workerData only.');
  }
  // Commit-boundary fault: statements before maybeInjectFault(transaction).
  const txnBlock = workerText.match(/case 'transaction':[\s\S]*?case '/);
  if (txnBlock && /maybeInjectFault\('transaction'\)[\s\S]*for \(const stmt/.test(txnBlock[0])) {
    failures.push('src/task/sqlite/worker.ts must inject transaction faults after statements, before COMMIT.');
  }
  const clientText = texts.get('src/task/sqlite/client.ts') ?? '';
  if (!clientText.includes('faultCapability') || !clientText.includes('workerData')) {
    failures.push('src/task/sqlite/client.ts must pass explicit faultCapability via workerData.');
  }
  if (!clientText.includes('onTerminalStorageError') || !clientText.includes('isTerminalStorageCode')) {
    failures.push('src/task/sqlite/client.ts must latch terminal corrupt/not_a_database faults.');
  }
  if (!clientText.includes('intentionalTerminate') && !clientText.includes('first fatal')) {
    // Accept either intentional-terminate guard or first-fatal-wins comment/logic.
    if (!clientText.includes('fatalError')) {
      failures.push('src/task/sqlite/client.ts must keep a first-fatal-wins latch.');
    }
  }
  const connectionText = texts.get('src/task/sqlite/connection.ts') ?? '';
  if (!connectionText.includes('findSchemaFingerprintFailure') && !connectionText.includes('schema-fingerprint')) {
    failures.push('src/task/sqlite/connection.ts must validate schema fingerprint beyond object names.');
  }
  const extensionTextForTerminal = texts.get('src/extension.ts') ?? '';
  if (!extensionTextForTerminal.includes('onTerminalStorageError')) {
    failures.push('src/extension.ts must wire onTerminalStorageError for production DbClient.');
  }
  // Production terminal quiesce must stop the real production provider, not only UAT alias.
  if (!extensionTextForTerminal.includes('applyTerminalStorageQuiesce')) {
    failures.push('src/extension.ts must call applyTerminalStorageQuiesce on terminal storage.');
  }
  if (
    extensionTextForTerminal.includes('uatChatProvider?.disposeRevisionPoller') &&
    !extensionTextForTerminal.includes('chatProvider') &&
    !extensionTextForTerminal.includes('productionProvider')
  ) {
    failures.push(
      'src/extension.ts terminal handler must dispose production chatProvider, not only uatChatProvider.',
    );
  }
  if (
    /taskEngine\?\.shutdown\s*\(/.test(extensionTextForTerminal) &&
    !extensionTextForTerminal.includes('quiesceForTerminalStorage')
  ) {
    // Only fail if a terminal path uses graceful shutdown without hard quiesce.
    const terminalSlice =
      extensionTextForTerminal.match(
        /onTerminalStorageError[\s\S]{0,3500}?const candidate = new DbClient/,
      )?.[0] ?? '';
    if (/taskEngine\?\.shutdown\s*\(/.test(terminalSlice) && !terminalSlice.includes('quiesceForTerminalStorage')) {
      failures.push(
        'src/extension.ts terminal handler must hard-quiesce via quiesceForTerminalStorage, not graceful shutdown.',
      );
    }
  }
  // P5-W3: durable host-send coordinator must be the production handleSend path.
  const durableCoord = texts.get('src/host/durable-send-coordinator.ts') ?? '';
  if (durableCoord.includes('export async function runDurableHostSend')) {
    if (!extensionTextForTerminal.includes('runDurableHostSend')) {
      failures.push(
        'src/extension.ts must import/call runDurableHostSend when the coordinator exports it.',
      );
    }
    let durableCallers = 0;
    for (const [rel, raw] of texts) {
      if (rel === 'src/host/durable-send-coordinator.ts') continue;
      if (rel.endsWith('.test.ts') || rel.endsWith('.testkit.ts')) continue;
      if (stripComments(raw).includes('runDurableHostSend')) durableCallers += 1;
    }
    if (durableCallers === 0) {
      failures.push(
        'runDurableHostSend must have a production caller; test-only helpers fail the gate.',
      );
    }
  }
  // Schema fingerprint must validate structure beyond object/column names.
  const fingerprintText = texts.get('src/task/sqlite/schema-fingerprint.ts') ?? '';
  if (fingerprintText) {
    if (
      fingerprintText.includes('REQUIRED_TABLE_COLUMNS') &&
      !fingerprintText.includes('foreign_key_list') &&
      !fingerprintText.includes('expectedSchemaManifest')
    ) {
      failures.push(
        'src/task/sqlite/schema-fingerprint.ts must validate full schema structure, not only column names.',
      );
    }
    if (
      fingerprintText.includes('findSchemaFingerprintFailure') &&
      (!fingerprintText.includes('foreign_key_list') ||
        !fingerprintText.includes('index_info') ||
        !fingerprintText.includes('normalizeSchemaSql'))
    ) {
      failures.push(
        'src/task/sqlite/schema-fingerprint.ts must check FK, index columns, and normalized SQL.',
      );
    }
  }
  // Protocol must not use dummy exactKeys without real validation.
  if (
    protocolText.includes('function exactKeys') &&
    !protocolText.includes('parseWireErrorResponse')
  ) {
    failures.push('src/task/sqlite/protocol.ts exactKeys must back real wire validation.');
  }
  if (
    protocolText.includes('parseWireSuccessResponse') &&
    !protocolText.includes('exactKeys') &&
    !/Object\.keys/.test(protocolText)
  ) {
    failures.push('src/task/sqlite/protocol.ts must validate exact success response shapes.');
  }
  // Client must rejectAll on fatal latch (no hanging concurrent requests).
  if (clientText.includes('latchFatal') && !clientText.includes('rejectAll')) {
    failures.push('src/task/sqlite/client.ts must rejectAll pending requests on fatal latch.');
  }
  // Raw SQLite error.message must not be the wire/serialized message without the fixed table.
  if (
    errorsText.includes('mapToMusterSqliteError') &&
    !errorsText.includes('safeMessageForCode') &&
    /error\.message/.test(errorsText)
  ) {
    failures.push('src/task/sqlite/errors.ts must not forward raw SQLite error.message to the wire.');
  }
  if (
    errorsText.includes('serializeBoundaryError') &&
    /return\s*\{\s*[\s\S]*message:\s*error\.message/.test(errorsText) &&
    !errorsText.includes('safeMessageForCode')
  ) {
    failures.push('src/task/sqlite/errors.ts must not forward raw SQLite error.message to the wire.');
  }
  // claimRuntimeTurn must not swallow all storage errors into false.
  const engineText = texts.get('src/task/engine.ts') ?? '';
  const claimFn = engineText.match(/claimRuntimeTurn[\s\S]*?heartbeatRuntimeTurn/);
  if (claimFn && /catch\s*\{\s*return false;\s*\}/.test(claimFn[0])) {
    failures.push('src/task/engine.ts claimRuntimeTurn must not swallow storage errors into false.');
  }
  // Production host/engine/repository must not import the fault seam or invent
  // raw SQLITE_* error plumbing outside the sqlite package.
  for (const [rel, raw] of texts) {
    if (rel.startsWith('src/task/sqlite/')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.testkit.ts')) continue;
    const code = stripComments(raw);
    if (code.includes('fault-inject') || code.includes('setFaultPlanForTests') || code.includes('MUSTER_SQLITE_FAULT_')) {
      failures.push(`${rel} must not import or control the SQLite fault-injection seam.`);
    }
    if (/\bSQLITE_FULL\b|\bSQLITE_BUSY\b|\bSQLITE_IOERR\b|\bSQLITE_READONLY\b|\bSQLITE_CORRUPT\b/.test(code)) {
      failures.push(`${rel} must not reference raw SQLITE_* codes; use the Muster error taxonomy.`);
    }
    // Negative: do not forward raw error.message/stack into logs without diagnostics.
    if (rel === 'src/extension.ts') {
      if (/debugMuster\([^)]*error\.message/.test(code) && !code.includes('redactedDiagnosticLogFields')) {
        failures.push(`${rel} must not log raw error.message for SQLite open failures.`);
      }
      if (!code.includes('revealFileInOS') && !code.includes('Reveal Storage')) {
        failures.push(`${rel} must offer a recovery action for fail-closed SQLite open.`);
      }
    }
  }
  // package.json must not contribute fault-control commands/settings.
  try {
    const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
    const commands = (pkg.contributes?.commands ?? []).map((c) => String(c.command ?? ''));
    const configKeys = Object.keys(pkg.contributes?.configuration?.properties ?? {});
    if (commands.some((c) => /fault|inject/i.test(c))) {
      failures.push('package.json must not contribute fault-injection commands.');
    }
    if (configKeys.some((k) => /fault|inject/i.test(k))) {
      failures.push('package.json must not contribute fault-injection settings.');
    }
  } catch (error) {
    failures.push(`Cannot read package.json for fault-control audit: ${error.message}`);
  }
  } catch (error) {
    failures.push(`Missing entity matrix: docs/plans/sqlite-entity-matrix.vi.md (${error.message})`);
  }

  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRepositoryBoundarySmoke();
  if (result.ok) {
    console.log('repository-boundary-smoke: passed');
  } else {
    console.error('repository-boundary-smoke: failed');
    for (const [index, failure] of result.failures.entries()) console.error(`${index + 1}. ${failure}`);
    process.exitCode = 1;
  }
}
