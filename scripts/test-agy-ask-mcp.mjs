#!/usr/bin/env node
/**
 * Test agy headless + muster_bridge ask_user MCP (file IPC).
 *
 * Usage: node scripts/test-agy-ask-mcp.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const mcpServer = path.join(projectRoot, 'mcp/muster-ask-server.mjs');
const agyMcpConfig = path.join(os.homedir(), '.gemini/config/mcp_config.json');
const backupMcpConfig = `${agyMcpConfig}.muster-backup`;

const runId = `run-${Date.now()}`;
const runtimeDir = path.join(os.tmpdir(), 'muster', runId);
const pendingDir = path.join(runtimeDir, 'pending');
const answersDir = path.join(runtimeDir, 'answers');
fs.mkdirSync(pendingDir, { recursive: true });
fs.mkdirSync(answersDir, { recursive: true });

const mcpConfig = {
  mcpServers: {
    muster_bridge: {
      command: 'node',
      args: [mcpServer],
      env: {
        MUSTER_RUNTIME_DIR: runtimeDir,
        MUSTER_ASK_TIMEOUT_MS: '180000',
      },
    },
  },
};

function restoreMcpConfig() {
  if (fs.existsSync(backupMcpConfig)) {
    fs.copyFileSync(backupMcpConfig, agyMcpConfig);
    fs.unlinkSync(backupMcpConfig);
  }
}

function installMcpConfig() {
  if (fs.existsSync(agyMcpConfig)) {
    fs.copyFileSync(agyMcpConfig, backupMcpConfig);
  } else {
    fs.mkdirSync(path.dirname(agyMcpConfig), { recursive: true });
    fs.writeFileSync(backupMcpConfig, '');
  }
  fs.writeFileSync(agyMcpConfig, JSON.stringify(mcpConfig, null, 2));
}

function watchPendingAndAutoAnswer() {
  const seen = new Set();
  const interval = setInterval(() => {
    if (!fs.existsSync(pendingDir)) return;
    for (const file of fs.readdirSync(pendingDir)) {
      if (!file.endsWith('.json') || seen.has(file)) continue;
      seen.add(file);
      const pending = JSON.parse(fs.readFileSync(path.join(pendingDir, file), 'utf8'));
      console.log('\n[muster] pending ask detected:', JSON.stringify(pending, null, 2));

      const answer = {
        answers: Object.fromEntries(
          (pending.questions ?? []).map((q, i) => [
            String(i),
            {
              selected: q.options?.length ? [q.options[0]] : [],
              freeText: q.options?.length ? null : 'blue (auto test answer)',
            },
          ]),
        ),
        answeredAt: new Date().toISOString(),
        source: 'test-agy-ask-mcp auto-responder',
      };

      const answerPath = path.join(answersDir, file);
      fs.writeFileSync(answerPath, JSON.stringify(answer, null, 2));
      console.log('[muster] wrote answer:', answerPath);
    }
  }, 250);

  return () => clearInterval(interval);
}

async function runAgy(outputFormat) {
  const prompt =
    'You MUST call the coordinator MCP tool "ask_user" to ask the user what their favorite color is. ' +
    'Provide options: Red, Green, Blue. Do not answer yourself — wait for ask_user result, then summarize the user answer.';

  const args = [
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--print-timeout',
    '10m',
    '--add-dir',
    projectRoot,
  ];
  if (outputFormat) {
    args.push('--output-format', outputFormat);
  }

  console.log(`\n=== agy test (output-format=${outputFormat ?? 'plain'}) ===`);
  console.log('runtimeDir:', runtimeDir);
  console.log('cmd: agy', args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' '));

  const started = Date.now();
  const child = spawn('agy', args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    const chunk = c.toString();
    stdout += chunk;
    process.stdout.write(`[agy stdout +${((Date.now() - started) / 1000).toFixed(1)}s] ${chunk}`);
  });
  child.stderr.on('data', (c) => {
    const chunk = c.toString();
    stderr += chunk;
    process.stderr.write(`[agy stderr] ${chunk}`);
  });

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  console.log(`\n[agy] exit=${exitCode} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { exitCode, stdout, stderr, elapsedMs: Date.now() - started };
}

installMcpConfig();
const stopWatch = watchPendingAndAutoAnswer();

process.on('exit', () => {
  stopWatch();
  restoreMcpConfig();
});
process.on('SIGINT', () => process.exit(130));

try {
  const plain = await runAgy(null);
  const pendingFiles = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : [];
  const answerFiles = fs.existsSync(answersDir) ? fs.readdirSync(answersDir) : [];

  console.log('\n=== plain mode summary ===');
  console.log('pending files:', pendingFiles);
  console.log('answer files:', answerFiles);
  console.log('ask_user called:', pendingFiles.length > 0 ? 'YES' : 'NO');
  console.log('answered:', answerFiles.length > 0 ? 'YES' : 'NO');

  if (pendingFiles.length > 0) {
    const json = await runAgy('json');
    console.log('\n=== json mode stdout (first 2000 chars) ===');
    console.log(json.stdout.slice(0, 2000));
  }
} finally {
  stopWatch();
  restoreMcpConfig();
}