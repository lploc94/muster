/**
 * probe-acp-models.mjs — investigate which ACP backends actually expose a model
 * list (and modes) over the wire on THIS machine.
 *
 * It reuses the real per-backend spawn configs from the compiled adapters
 * (dist/src/backends/*.js), performs the minimal ACP handshake
 * (initialize -> optional authenticate -> session/new), and dumps every field
 * whose key looks model/mode/config-related from the initialize result, the
 * session/new result, and any session/update notifications.
 *
 * Usage:
 *   npm run compile           # produce dist/ (required)
 *   node scripts/probe-acp-models.mjs
 *
 * Run it with the real CLIs installed + authenticated (same shell/PATH VS Code
 * inherits). A backend that is not installed surfaces as spawn ENOENT.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirror src/backends/acp-client.ts DEFAULT_CLIENT_CAPABILITIES.
const DEFAULT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

const KEY_RX = /model|mode|config.?option/i;

function loadBackends() {
  const specs = [
    ['claude', 'dist/src/backends/claude.js', (m) => m.claudeAgentConfig()],
    ['grok', 'dist/src/backends/grok.js', (m) => m.GROK_AGENT_CONFIG],
    ['kiro', 'dist/src/backends/kiro.js', (m) => m.KIRO_AGENT_CONFIG],
    ['codex', 'dist/src/backends/codex.js', (m) => m.codexAgentConfig()],
    ['opencode', 'dist/src/backends/opencode.js', (m) => m.OPENCODE_AGENT_CONFIG],
  ];
  const out = [];
  for (const [id, rel, pick] of specs) {
    try {
      const mod = require(path.join(ROOT, rel));
      out.push({ id, config: pick(mod) });
    } catch (e) {
      out.push({ id, loadError: String(e && e.message ? e.message : e) });
    }
  }
  return out;
}

/** Recursively collect values under keys matching KEY_RX. */
function findKeys(obj, hits = [], trail = '') {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = trail ? `${trail}.${k}` : k;
      if (KEY_RX.test(k)) hits.push({ path: p, value: v });
      findKeys(v, hits, p);
    }
  }
  return hits;
}

/** Pull a compact model option list out of an ACP configOptions array. */
function extractModelOptions(sources) {
  for (const src of sources) {
    const opts = src && (src.configOptions || src.config_options);
    if (Array.isArray(opts)) {
      const model = opts.find(
        (o) => o && (o.category === 'model' || /^models?$/i.test(String(o.id || o.name || ''))),
      );
      if (model && Array.isArray(model.options)) {
        return {
          via: 'configOptions',
          current: model.currentValue ?? model.current_value ?? null,
          options: model.options.map((o) => ({ value: o.value ?? o.id, name: o.name })),
        };
      }
    }
    // Some agents expose a bare availableModels array.
    if (Array.isArray(src && src.availableModels)) {
      return { via: 'availableModels', current: src.currentModelId ?? null, options: src.availableModels };
    }
  }
  return null;
}

function extractModes(sources) {
  for (const src of sources) {
    const modes = src && (src.modes || src.sessionModes);
    if (modes && Array.isArray(modes.availableModes)) {
      return { current: modes.currentModeId ?? null, available: modes.availableModes.map((m) => m.id ?? m.name) };
    }
  }
  return null;
}

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout after ${ms}ms (${label})`)), ms))]);

async function probe({ id, config, loadError }) {
  const r = { id, label: config?.label ?? id, command: null, installed: null, error: null, stderr: [], initialize: null, session: null, updates: [] };
  if (loadError) {
    r.error = `could not load config from dist (run npm run compile): ${loadError}`;
    return r;
  }
  r.command = `${config.command} ${config.args.join(' ')}`;
  const env = { ...process.env, ...(config.env || {}) };

  const proc = spawn(config.command, config.args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  let nextId = 1;
  const pending = new Map();
  const write = (obj) => {
    try {
      proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* EPIPE after exit */
    }
  };
  const send = (method, params) => {
    const rid = nextId++;
    write({ jsonrpc: '2.0', id: rid, method, params });
    return new Promise((resolve, reject) => pending.set(rid, { resolve, reject }));
  };

  const spawnFailed = new Promise((_, reject) => proc.on('error', (e) => reject(e)));
  proc.stdin.on('error', () => {});
  proc.stderr.on('data', (b) => {
    for (const l of b.toString().split('\n')) if (l.trim()) r.stderr.push(l.trim());
  });

  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const isResponse = msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined);
    if (isResponse) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      if (String(msg.method).includes('session/update')) r.updates.push(msg.params);
      // Best-effort reply to any incoming request so the agent doesn't stall.
      if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });

  try {
    const init = await withTimeout(
      Promise.race([
        send('initialize', {
          protocolVersion: 1,
          clientCapabilities: config.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
        }),
        spawnFailed,
      ]),
      15000,
      'initialize',
    );
    r.installed = true;
    r.initialize = init;

    if (config.resolveAuth) {
      try {
        const choice = config.resolveAuth(init, env);
        if (choice) {
          await withTimeout(send('authenticate', { methodId: choice.methodId, _meta: choice.meta ?? {} }), 15000, 'authenticate');
        }
      } catch (e) {
        r.authError = String(e && e.message ? e.message : e);
      }
    }

    const session = await withTimeout(send('session/new', { cwd: process.cwd(), mcpServers: [] }), 30000, 'session/new');
    r.session = session;
    // Give the agent a moment to push mode/config updates as notifications.
    await new Promise((res) => setTimeout(res, 1500));
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    if (/ENOENT/.test(m)) r.installed = false;
    else if (r.installed === null) r.installed = 'unknown';
    r.error = m;
  } finally {
    rl.close();
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 400);
  }

  const sources = [r.initialize, r.session, ...r.updates].filter(Boolean);
  r.models = extractModelOptions(sources);
  r.modeState = extractModes(sources);
  r.relatedFields = findKeys({ initialize: r.initialize, session: r.session, updates: r.updates }).slice(0, 40);
  return r;
}

function line(s = '') {
  process.stdout.write(s + '\n');
}

async function main() {
  const backends = loadBackends();
  const results = [];
  for (const b of backends) {
    line('\n' + '='.repeat(70));
    line(`BACKEND: ${b.id}`);
    line('='.repeat(70));
    const r = await probe(b);
    results.push(r);
    line(`command   : ${r.command ?? '(n/a)'}`);
    line(`installed : ${r.installed}`);
    if (r.error) line(`error     : ${r.error}`);
    if (r.authError) line(`authError : ${r.authError}`);
    if (r.models) {
      line(`MODELS (${r.models.via}, current=${r.models.current ?? '?'}):`);
      for (const o of r.models.options) line(`   - ${typeof o === 'string' ? o : `${o.value}  =>  ${o.name}`}`);
    } else {
      line('MODELS    : none exposed on initialize/session/new');
    }
    if (r.modeState) line(`MODES     : current=${r.modeState.current} available=[${r.modeState.available.join(', ')}]`);
    if (r.relatedFields.length) {
      line('related model/mode/config keys seen:');
      for (const f of r.relatedFields) {
        const val = JSON.stringify(f.value);
        line(`   ${f.path} = ${val.length > 160 ? val.slice(0, 160) + '…' : val}`);
      }
    }
    if (r.stderr.length && (!r.session || r.error)) {
      line('stderr (tail):');
      for (const l of r.stderr.slice(-6)) line(`   ${l}`);
    }
  }

  // Summary table.
  line('\n' + '='.repeat(70));
  line('SUMMARY');
  line('='.repeat(70));
  line('backend    installed   exposes-models   #models   exposes-modes');
  for (const r of results) {
    const inst = String(r.installed).padEnd(9);
    const em = r.models ? 'YES' : 'no ';
    const cnt = r.models ? String(r.models.options.length) : '0';
    const md = r.modeState ? 'YES' : 'no';
    line(`${r.id.padEnd(10)} ${inst}   ${em.padEnd(14)}   ${cnt.padEnd(7)}   ${md}`);
  }

  const dump = path.join(os.tmpdir(), 'muster-acp-probe.json');
  fs.writeFileSync(dump, JSON.stringify(results, null, 2));
  line(`\nRaw dump written to: ${dump}`);
  process.exit(0);
}

main().catch((e) => {
  line('probe failed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
