/**
 * M022/S01 packaging-gate Extension Host smoke.
 *
 * Loaded via @vscode/test-electron as extensionTestsPath against a freshly
 * extracted VSIX (extensionDevelopmentPath). Proves:
 * - tlelabs.muster activates from archive contents
 * - packaged SQLite worker spawns and answers
 * - packaged mcp-stdio-proxy require graph loads without MODULE_NOT_FOUND
 * - production MusterBridgeServer listen is observable via muster.uat.bridgeHealth
 *   and loopback /health returns status ok with port > 0
 *
 * Writes a closed host result to MUSTER_PACKAGING_HOST_RESULT_OUT for the runner.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const HOST_SMOKE_KIND = 'm022-s01-packaging-host-smoke' as const;

type EntrypointPhase = 'ok' | 'missing-archive-entry' | 'require-failed' | 'spawn-failed';

type EntrypointResult = {
  path: string;
  present: boolean;
  resolved: boolean;
  phase: EntrypointPhase;
  detail?: string;
};

type BridgeHealth = {
  port: number;
  status: 'ok' | 'stopping' | 'unavailable';
  generation: number;
};

type HostSmokeResult = {
  kind: typeof HOST_SMOKE_KIND;
  ok: boolean;
  activation: 'ok' | 'failed';
  bridge: BridgeHealth | null;
  bridgePhase: 'ok' | 'activation' | 'uat-command-unavailable' | 'health-unreachable';
  entrypoints: EntrypointResult[];
  detail?: string;
};

const REQUIRED = {
  extension: 'extension/dist/src/extension.js',
  worker: 'extension/dist/src/task/sqlite/worker.js',
  stdioProxy: 'extension/dist/src/bridge/mcp-stdio-proxy.js',
} as const;

interface PackagedDbClient {
  open(dbPath: string, busyTimeoutMs?: number): Promise<void>;
  pragma(name: string): Promise<number>;
  close(): Promise<void>;
}

interface PackagedClientModule {
  DbClient: new (options: { workerPath: string }) => PackagedDbClient;
  resolveWorkerPath(dir?: string): string;
}

function writeResult(result: HostSmokeResult): void {
  const outPath = process.env.MUSTER_PACKAGING_HOST_RESULT_OUT;
  if (!outPath) return;
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(tmp, outPath);
}

function archivePathFor(extensionPath: string, archiveRelative: string): string {
  const relative = archiveRelative.replace(/^extension\//, '');
  return path.join(extensionPath, relative);
}

function presentResult(
  archiveRelative: string,
  extensionPath: string,
): EntrypointResult {
  const full = archivePathFor(extensionPath, archiveRelative);
  if (!fs.existsSync(full)) {
    return {
      path: archiveRelative,
      present: false,
      resolved: false,
      phase: 'missing-archive-entry',
      detail: `missing on disk: ${archiveRelative}`,
    };
  }
  return {
    path: archiveRelative,
    present: true,
    resolved: true,
    phase: 'ok',
  };
}

function failEntrypoint(
  archiveRelative: string,
  phase: EntrypointPhase,
  detail: string,
  present = true,
): EntrypointResult {
  return {
    path: archiveRelative,
    present,
    resolved: false,
    phase,
    detail,
  };
}

async function fetchBridgeHealth(port: number): Promise<BridgeHealth> {
  const body = await new Promise<string>((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        timeout: 5_000,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`/health HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('/health request timed out'));
    });
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('/health returned non-JSON body');
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const healthPort =
    typeof obj.port === 'number' && Number.isFinite(obj.port) ? obj.port : port;
  const generation =
    typeof obj.generation === 'number' && Number.isFinite(obj.generation)
      ? obj.generation
      : 0;
  const status =
    obj.status === 'ok' || obj.status === 'stopping' || obj.status === 'unavailable'
      ? obj.status
      : healthPort > 0
        ? 'ok'
        : 'unavailable';
  return { port: healthPort, status, generation };
}

/**
 * Extension Host entry — invoked by @vscode/test-electron.
 */
export async function run(): Promise<void> {
  const entrypoints: EntrypointResult[] = [
    {
      path: REQUIRED.extension,
      present: false,
      resolved: false,
      phase: 'missing-archive-entry',
    },
    {
      path: REQUIRED.worker,
      present: false,
      resolved: false,
      phase: 'missing-archive-entry',
    },
    {
      path: REQUIRED.stdioProxy,
      present: false,
      resolved: false,
      phase: 'missing-archive-entry',
    },
  ];

  const fail = (
    partial: Partial<HostSmokeResult> & Pick<HostSmokeResult, 'bridgePhase' | 'activation'>,
  ): never => {
    const result: HostSmokeResult = {
      kind: HOST_SMOKE_KIND,
      ok: false,
      activation: partial.activation,
      bridge: partial.bridge ?? null,
      bridgePhase: partial.bridgePhase,
      entrypoints: partial.entrypoints ?? entrypoints,
      ...(partial.detail ? { detail: partial.detail } : {}),
    };
    writeResult(result);
    throw new Error(partial.detail ?? `packaging host smoke failed (${partial.bridgePhase})`);
  };

  if (process.env.MUSTER_UAT_MODE !== '1') {
    fail({
      activation: 'failed',
      bridgePhase: 'uat-command-unavailable',
      detail: 'MUSTER_UAT_MODE=1 is required for packaging-gate host smoke',
    });
  }

  const extension = vscode.extensions.getExtension('tlelabs.muster');
  if (!extension) {
    fail({
      activation: 'failed',
      bridgePhase: 'activation',
      detail: 'packaged tlelabs.muster was not discovered',
    });
    return; // unreachable; keeps control-flow narrowing for tsc
  }

  const extensionPath = extension.extensionPath;
  entrypoints[0] = presentResult(REQUIRED.extension, extensionPath);
  entrypoints[1] = presentResult(REQUIRED.worker, extensionPath);
  entrypoints[2] = presentResult(REQUIRED.stdioProxy, extensionPath);

  // 1) stdio proxy require graph from archive (before activation is fine — pure module load).
  const stdioProxyPath = archivePathFor(extensionPath, REQUIRED.stdioProxy);
  if (entrypoints[2].present) {
    try {
      // Clear any prior resolution so we load from the extracted archive path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(stdioProxyPath) as {
        loadProxyEnvConfig?: unknown;
        MusterStdioMcpProxy?: unknown;
      };
      if (typeof mod.loadProxyEnvConfig !== 'function' && typeof mod.MusterStdioMcpProxy !== 'function') {
        entrypoints[2] = failEntrypoint(
          REQUIRED.stdioProxy,
          'require-failed',
          'stdio proxy module loaded but expected exports missing',
        );
      } else {
        entrypoints[2] = {
          path: REQUIRED.stdioProxy,
          present: true,
          resolved: true,
          phase: 'ok',
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entrypoints[2] = failEntrypoint(
        REQUIRED.stdioProxy,
        'require-failed',
        message.slice(0, 400),
      );
    }
  }

  // 2) Activate packaged extension (production listen() path for the MCP bridge).
  try {
    await extension.activate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entrypoints[0] = failEntrypoint(REQUIRED.extension, 'require-failed', message.slice(0, 400));
    fail({
      activation: 'failed',
      bridgePhase: 'activation',
      entrypoints,
      detail: `activation failed: ${message.slice(0, 400)}`,
    });
  }

  if (!extension.isActive) {
    entrypoints[0] = failEntrypoint(
      REQUIRED.extension,
      'require-failed',
      'extension.isActive !== true after activate()',
    );
    fail({
      activation: 'failed',
      bridgePhase: 'activation',
      entrypoints,
      detail: 'packaged extension did not activate',
    });
  }

  entrypoints[0] = {
    path: REQUIRED.extension,
    present: true,
    resolved: true,
    phase: 'ok',
  };

  // 3) Packaged SQLite worker spawn + answer.
  const sqliteDir = path.join(extensionPath, 'dist', 'src', 'task', 'sqlite');
  const clientPath = path.join(sqliteDir, 'client.js');
  const workerPath = path.join(sqliteDir, 'worker.js');
  if (!fs.existsSync(clientPath) || !fs.existsSync(workerPath)) {
    entrypoints[1] = failEntrypoint(
      REQUIRED.worker,
      'missing-archive-entry',
      'packaged SQLite client/worker missing',
      false,
    );
    fail({
      activation: 'ok',
      bridgePhase: 'health-unreachable',
      entrypoints,
      detail: 'packaged SQLite client/worker missing',
    });
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-packaging-host-sqlite-'));
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const packaged = require(clientPath) as PackagedClientModule;
    assert.equal(packaged.resolveWorkerPath(sqliteDir), workerPath);
    const client = new packaged.DbClient({ workerPath });
    const dbPath = path.join(tempDir, 'muster.sqlite3');
    await client.open(dbPath);
    assert.equal(await client.pragma('application_id'), 0x4d555354);
    await client.close();
    entrypoints[1] = {
      path: REQUIRED.worker,
      present: true,
      resolved: true,
      phase: 'ok',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    entrypoints[1] = failEntrypoint(
      REQUIRED.worker,
      'spawn-failed',
      message.slice(0, 400),
    );
    fail({
      activation: 'ok',
      bridgePhase: 'health-unreachable',
      entrypoints,
      detail: `sqlite worker spawn failed: ${message.slice(0, 400)}`,
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // 4) Redacted bridge health via UAT command + loopback /health confirmation.
  let uatHealthRaw: unknown;
  try {
    uatHealthRaw = await vscode.commands.executeCommand('muster.uat.bridgeHealth');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail({
      activation: 'ok',
      bridge: null,
      bridgePhase: 'uat-command-unavailable',
      entrypoints,
      detail: `muster.uat.bridgeHealth unavailable: ${message.slice(0, 400)}`,
    });
    return;
  }

  const uatHealthObj = (uatHealthRaw ?? {}) as Partial<BridgeHealth>;
  const uatPort =
    typeof uatHealthObj.port === 'number' && Number.isFinite(uatHealthObj.port)
      ? uatHealthObj.port
      : 0;
  const uatGeneration =
    typeof uatHealthObj.generation === 'number' && Number.isFinite(uatHealthObj.generation)
      ? uatHealthObj.generation
      : 0;
  const uatStatus: BridgeHealth['status'] =
    uatHealthObj.status === 'ok' ||
    uatHealthObj.status === 'stopping' ||
    uatHealthObj.status === 'unavailable'
      ? uatHealthObj.status
      : uatPort > 0
        ? 'ok'
        : 'unavailable';
  const uatHealth: BridgeHealth = {
    port: uatPort,
    status: uatStatus,
    generation: uatGeneration,
  };

  if (uatHealth.port <= 0 || uatHealth.status !== 'ok') {
    fail({
      activation: 'ok',
      bridge: uatHealth,
      bridgePhase: 'health-unreachable',
      entrypoints,
      detail: 'bridgeHealth did not report a listening port with status ok',
    });
    return;
  }

  let httpHealth: BridgeHealth;
  try {
    httpHealth = await fetchBridgeHealth(uatHealth.port);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail({
      activation: 'ok',
      bridge: {
        port: uatHealth.port,
        status: 'unavailable',
        generation: uatHealth.generation,
      },
      bridgePhase: 'health-unreachable',
      entrypoints,
      detail: `/health unreachable: ${message.slice(0, 400)}`,
    });
    return;
  }

  if (httpHealth.status !== 'ok' || httpHealth.port <= 0) {
    fail({
      activation: 'ok',
      bridge: httpHealth,
      bridgePhase: 'health-unreachable',
      entrypoints,
      detail: '/health did not return status ok with port > 0',
    });
    return;
  }

  // Prefer UAT redacted payload fields (port/status/generation only).
  const bridge: BridgeHealth = {
    port: uatHealth.port,
    status: 'ok',
    generation: uatHealth.generation || httpHealth.generation,
  };

  if (entrypoints.some((r) => !r.present || !r.resolved || r.phase !== 'ok')) {
    fail({
      activation: 'ok',
      bridge,
      bridgePhase: 'ok',
      entrypoints,
      detail: 'one or more entrypoints failed require/spawn checks',
    });
  }

  const result: HostSmokeResult = {
    kind: HOST_SMOKE_KIND,
    ok: true,
    activation: 'ok',
    bridge,
    bridgePhase: 'ok',
    entrypoints,
  };
  writeResult(result);
}
