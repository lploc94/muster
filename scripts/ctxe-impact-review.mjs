/**
 * CtxE-backed impact review for a completed slice or milestone.
 *
 * Answers one question that `git diff` cannot: for every symbol whose
 * definition changed, which transitive dependents exist, and were any of them
 * left untouched by the same change set? Untouched dependents are the
 * candidates for a missed call-site update.
 *
 * Pipeline:
 *   git diff --name-only <base>..<head>   -> changed source files
 *   git diff -U0                          -> exported symbols on changed lines
 *   ctxe index_workspace (incremental)    -> defeat index staleness
 *   ctxe get_status                       -> refuse to report on a stale index
 *   ctxe find_definitions(symbols)        -> symbol -> chunk ids
 *   ctxe get_impact(chunk_id)             -> transitive dependent chunk ids
 *   ctxe fetch_chunks(ids)                -> chunk ids -> file paths
 *
 * The index is NOT auto-watched (see .gsd/KNOWLEDGE.md K004), so indexing is
 * mandatory rather than optional. Reporting on a stale index is worse than not
 * reporting at all, so a non-Ready index is a hard failure.
 *
 * Usage:
 *   node scripts/ctxe-impact-review.mjs [--base <ref>] [--head <ref>]
 *                                       [--json <path>] [--max-hops <n>]
 *                                       [--skip-index] [--quiet]
 *
 * Exit codes: 0 clean, 1 untouched dependents found, 2 tooling/index failure.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CTXE_BIN = process.env.CTXE_BIN ?? 'ctxe';
const WORKSPACE = resolve(process.env.CTXE_WORKSPACE ?? process.cwd());
const RPC_TIMEOUT_MS = Number(process.env.CTXE_RPC_TIMEOUT_MS ?? 300_000);

/** ctxe 0.4.3 caps find_definitions at 20 symbols per request. */
const SYMBOL_BATCH = 20;

/** Observed server-side get_impact result cap; at or above this, results are truncated. */
const IMPACT_CAP = 50;

/**
 * Chunk symbol_type values that represent an actual declaration. `import` and
 * mention-only chunks share the symbol name but define nothing, so their
 * dependents belong to the mentioning file, not to the symbol.
 */
const DEFINITION_SYMBOL_TYPES = new Set([
  'constant', 'function', 'class', 'interface', 'type', 'enum', 'method', 'variable', 'struct',
]);

/** Source extensions worth graph analysis. Docs/JSON carry no call edges. */
const SOURCE_RE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|svelte)$/;

/** Test and script files are dependents we do not require to change. */
const NON_PRODUCTION_RE = /(\.test\.|\.spec\.|^e2e\/|^scripts\/)/;

function parseArgs(argv) {
  const out = {
    base: 'origin/main',
    head: 'HEAD',
    json: null,
    maxHops: 3,
    skipIndex: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--head') out.head = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--max-hops') out.maxHops = Number(argv[++i]);
    else if (a === '--skip-index') out.skipIndex = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.maxHops) || out.maxHops < 2) {
    throw new Error('--max-hops must be an integer >= 2 (ctxe clamps below 2)');
  }
  return out;
}

const USAGE = `ctxe-impact-review — transitive-dependent review for changed symbols

  node scripts/ctxe-impact-review.mjs [options]

  --base <ref>     diff base (default: origin/main)
  --head <ref>     diff head (default: HEAD)
  --json <path>    write machine-readable report to path
  --max-hops <n>   get_impact hop budget, >= 2 (default: 3)
  --skip-index     trust the existing index (fails if not Ready)
  --quiet          suppress progress output

  env: CTXE_BIN, CTXE_WORKSPACE, CTXE_RPC_TIMEOUT_MS

  exit 0 clean | 1 untouched dependents | 2 tooling/index failure
`;

/** Minimal JSON-RPC client over `ctxe mcp` stdio. */
class CtxeMcp {
  #proc;
  #nextId = 1;
  #pending = new Map();
  #buf = '';
  #exited = null;

  async start() {
    this.#proc = spawn(CTXE_BIN, ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (d) => this.#onData(d));
    this.#proc.stderr.resume();

    this.#proc.on('exit', (code) => {
      this.#exited = code;
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error(`ctxe mcp exited (code ${code}) with a request in flight`));
      }
      this.#pending.clear();
    });

    const spawned = await Promise.race([
      once(this.#proc, 'spawn').then(() => 'ok'),
      once(this.#proc, 'error').then(([e]) => e),
    ]);
    if (spawned !== 'ok') {
      throw new Error(`cannot spawn "${CTXE_BIN} mcp": ${spawned.message}`);
    }

    await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ctxe-impact-review', version: '1.0.0' },
    });
    this.#notify('notifications/initialized', {});
  }

  #onData(chunk) {
    this.#buf += chunk;
    let nl;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON log line on stdout
      }
      const entry = this.#pending.get(msg.id);
      if (!entry) continue;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  #notify(method, params) {
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  #request(method, params) {
    if (this.#exited !== null) {
      return Promise.reject(new Error(`ctxe mcp already exited (code ${this.#exited})`));
    }
    const id = this.#nextId++;
    return new Promise((resolve_, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolve_, reject, timer });
      this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Call a ctxe tool and parse its JSON text payload. */
  async call(name, args) {
    const res = await this.#request('tools/call', { name, arguments: args });
    const text = (res?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    if (res?.isError) throw new Error(`${name} returned an error: ${text.slice(0, 400)}`);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: text };
    }
  }

  async stop() {
    if (!this.#proc || this.#exited !== null) return;
    this.#proc.stdin.end();
    const closed = await Promise.race([
      once(this.#proc, 'exit').then(() => true),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!closed) this.#proc.kill();
  }
}

function git(args) {
  return execFileSync('git', args, {
    cwd: WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveRef(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref]).trim();
  } catch {
    return null;
  }
}

function changedFiles(base, head) {
  const out = git(['diff', '--name-only', '--diff-filter=ACMR', `${base}..${head}`]);
  return out.split('\n').map((l) => l.trim()).filter((l) => l && SOURCE_RE.test(l));
}

/**
 * Extract candidate symbol names from added/removed lines of the diff.
 *
 * Only `export`-ed declarations are considered. An earlier version also matched
 * bare `const`/`let` and method-shaped lines, which produced local names like
 * `pending`, `current`, `index` and `base`. Those resolve against unrelated
 * definitions all over the repo and saturated every impact query, so the whole
 * report became noise. Exported names are the only ones whose dependents are
 * meaningful across module boundaries.
 */
function changedSymbols(base, head, files) {
  if (files.length === 0) return [];
  const diff = git(['diff', '-U0', `${base}..${head}`, '--', ...files]);
  const symbols = new Set();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  ];
  for (const raw of diff.split('\n')) {
    if (!/^[+-]/.test(raw) || /^(\+\+\+|---)/.test(raw)) continue;
    const line = raw.slice(1).trim();
    for (const re of patterns) {
      const m = line.match(re);
      if (m?.[1] && m[1].length > 2 && !RESERVED.has(m[1])) {
        symbols.add(m[1]);
        break;
      }
    }
  }
  return [...symbols].sort();
}

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'new', 'typeof',
  'this', 'super', 'import', 'export', 'default', 'from', 'else', 'try',
  'constructor', 'function', 'const', 'let', 'var', 'case', 'break', 'continue',
  'throw', 'delete', 'void', 'null', 'true', 'false', 'undefined',
]);

function log(opts, msg) {
  if (!opts.quiet) process.stderr.write(`${msg}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const baseSha = resolveRef(opts.base);
  const headSha = resolveRef(opts.head);
  if (!baseSha) throw new Error(`cannot resolve --base "${opts.base}"`);
  if (!headSha) throw new Error(`cannot resolve --head "${opts.head}"`);

  const files = changedFiles(opts.base, opts.head);
  log(opts, `changed source files: ${files.length}`);
  if (files.length === 0) {
    const report = emptyReport(opts, baseSha, headSha, 'no changed source files');
    finish(opts, report);
    return 0;
  }

  const symbols = changedSymbols(opts.base, opts.head, files);
  log(opts, `candidate changed symbols: ${symbols.length}`);
  if (symbols.length === 0) {
    const report = emptyReport(opts, baseSha, headSha, 'no named symbols in diff');
    finish(opts, report);
    return 0;
  }

  const mcp = new CtxeMcp();
  await mcp.start();
  try {
    if (!opts.skipIndex) {
      log(opts, 'indexing workspace (incremental)…');
      await mcp.call('index_workspace', { workspace: WORKSPACE, force: false });
    }

    const status = await mcp.call('get_status', { workspace: WORKSPACE });
    const base = status.base ?? {};
    if (!base.indexed || base.state !== 'Ready' || (base.pending_chunks ?? 0) > 0) {
      throw new Error(
        `index not usable: state=${base.state} indexed=${base.indexed} ` +
          `pending_chunks=${base.pending_chunks}. Refusing to report on a stale index.`,
      );
    }
    log(opts, `index Ready — ${base.indexed_files} files, schema v${base.schema_version}`);

    // find_definitions accepts 1-20 symbols per call (ctxe 0.4.3), so the
    // candidate list is batched rather than sent whole.
    const definitions = [];
    const notFound = [];
    for (let i = 0; i < symbols.length; i += SYMBOL_BATCH) {
      const batch = symbols.slice(i, i + SYMBOL_BATCH);
      const part = await mcp.call('find_definitions', {
        workspace: WORKSPACE,
        symbols: batch,
        include_content: false,
      });
      definitions.push(...(part.definitions ?? []));
      notFound.push(...(part.not_found ?? []));
    }
    const defs = { definitions, not_found: notFound };
    log(opts, `resolved ${definitions.length} definition group(s), ${notFound.length} unresolved`);

    const changedSet = new Set(files);
    const findings = [];
    const allDependentIds = new Set();
    const notResolvedAsDefinition = [];

    // ctxe returns a chunk per site that mentions the name, including `import`
    // lines and same-named interface fields in unrelated scripts. Those are not
    // definitions: their dependents describe the mentioning file's own coupling
    // and produced badly misleading hop-1 results. Only declaration-shaped
    // chunks in non-script files are treated as authoritative.
    for (const def of defs.definitions ?? []) {
      const candidates = (def.chunks ?? []).filter(
        (c) =>
          DEFINITION_SYMBOL_TYPES.has(c.symbol_type) &&
          !NON_PRODUCTION_RE.test(normalizePath(c.file_path) ?? ''),
      );
      const chosen = candidates.length > 0 ? candidates : (def.chunks ?? []).filter((c) => DEFINITION_SYMBOL_TYPES.has(c.symbol_type));
      if (chosen.length === 0) {
        notResolvedAsDefinition.push(def.symbol);
        continue;
      }
      for (const chunk of chosen) {
        const impact = await mcp.call('get_impact', {
          workspace: WORKSPACE,
          chunk_id: chunk.chunk_id,
          max_hops: opts.maxHops,
        });
        const items = impact.items ?? [];
        if (items.length === 0) continue;
        for (const it of items) allDependentIds.add(it.chunk_id);
        findings.push({
          symbol: def.symbol,
          chunkId: chunk.chunk_id,
          definitionPath: normalizePath(chunk.file_path),
          items,
        });
      }
    }

    // get_impact returns ids only (K004); one batched fetch maps them to paths.
    const idToPath = new Map();
    const ids = [...allDependentIds];
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const fetched = await mcp.call('fetch_chunks', {
        workspace: WORKSPACE,
        chunk_ids: batch,
        include_content: false,
      });
      for (const c of fetched.chunks ?? []) {
        if (c.chunk_id != null && c.file_path) idToPath.set(c.chunk_id, c.file_path);
      }
    }

    const symbolReports = [];
    for (const f of findings) {
      const dependents = [];
      for (const it of f.items) {
        const path = normalizePath(idToPath.get(it.chunk_id));
        if (!path) continue;
        dependents.push({
          chunkId: it.chunk_id,
          path,
          hop: it.hop,
          score: it.score,
          changed: changedSet.has(path),
          production: !NON_PRODUCTION_RE.test(path),
        });
      }
      const untouched = dependents.filter((d) => !d.changed && d.production);
      const uniqueUntouched = [...new Map(untouched.map((d) => [d.path, d])).values()]
        .sort((a, b) => a.hop - b.hop || a.path.localeCompare(b.path));
      // get_impact truncates at a server-side cap. A saturated result means the
      // true dependent set is larger and unranked, so the untouched list is a
      // sample rather than an enumeration and must not be reported as complete.
      const saturated = f.items.length >= IMPACT_CAP;
      symbolReports.push({
        symbol: f.symbol,
        definitionChunkId: f.chunkId,
        dependentCount: dependents.length,
        impactSaturated: saturated,
        untouchedProductionDependents: uniqueUntouched,
      });
    }

    symbolReports.sort(
      (a, b) =>
        b.untouchedProductionDependents.length - a.untouchedProductionDependents.length ||
        a.symbol.localeCompare(b.symbol),
    );

    const flagged = symbolReports.filter((s) => s.untouchedProductionDependents.length > 0);
    const report = {
      ok: flagged.length === 0,
      kind: 'ctxe-impact-review',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      workspace: WORKSPACE,
      ctxe: { indexSchemaVersion: base.schema_version, indexedFiles: base.indexed_files },
      diff: { base: opts.base, baseSha, head: opts.head, headSha, maxHops: opts.maxHops },
      counts: {
        changedFiles: files.length,
        candidateSymbols: symbols.length,
        resolvedSymbols: symbolReports.length,
        unresolvedSymbols: (defs.not_found ?? []).length,
        flaggedSymbols: flagged.length,
        saturatedSymbols: symbolReports.filter((s) => s.impactSaturated).length,
      },
      unresolvedSymbols: defs.not_found ?? [],
      mentionOnlySymbols: notResolvedAsDefinition,
      symbols: symbolReports,
    };

    finish(opts, report);
    return flagged.length === 0 ? 0 : 1;
  } finally {
    await mcp.stop();
  }
}

function normalizePath(p) {
  if (!p) return null;
  return p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/^.*?\/_Dev\/muster\//, '');
}

function emptyReport(opts, baseSha, headSha, reason) {
  return {
    ok: true,
    kind: 'ctxe-impact-review',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspace: WORKSPACE,
    diff: { base: opts.base, baseSha, head: opts.head, headSha, maxHops: opts.maxHops },
    counts: { changedFiles: 0, candidateSymbols: 0, resolvedSymbols: 0, flaggedSymbols: 0 },
    skippedReason: reason,
    symbols: [],
  };
}

function finish(opts, report) {
  if (opts.json) {
    const target = resolve(opts.json);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(opts, `report written: ${target}`);
  }
  if (opts.quiet) return;
  process.stdout.write(renderText(report));
}

function renderText(report) {
  const out = [];
  out.push('');
  out.push('CtxE impact review');
  out.push('='.repeat(60));
  if (report.skippedReason) {
    out.push(`nothing to review: ${report.skippedReason}`);
    out.push('');
    return out.join('\n');
  }
  const c = report.counts;
  out.push(
    `${report.diff.base}..${report.diff.head}  ` +
      `${c.changedFiles} files, ${c.resolvedSymbols}/${c.candidateSymbols} symbols resolved`,
  );
  out.push('');
  const flagged = report.symbols.filter((s) => s.untouchedProductionDependents.length > 0);
  if (flagged.length === 0) {
    out.push('No untouched production dependents. Every dependent of every changed');
    out.push('symbol was either modified in this change set, or is test/script code.');
    out.push('');
    return out.join('\n');
  }
  out.push(`${flagged.length} symbol(s) with untouched production dependents:`);
  out.push('');
  for (const s of flagged) {
    const mark = s.impactSaturated ? ' [truncated at cap — sample only]' : '';
    out.push(`  ${s.symbol}  (${s.dependentCount} dependents)${mark}`);
    for (const d of s.untouchedProductionDependents.slice(0, 8)) {
      out.push(`      hop ${d.hop}  ${d.path}`);
    }
    const extra = s.untouchedProductionDependents.length - 8;
    if (extra > 0) out.push(`      … ${extra} more`);
    out.push('');
  }
  out.push('These are candidates for a missed update, not confirmed defects.');
  out.push('A dependent can legitimately need no change.');
  out.push('');
  return out.join('\n');
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`\nctxe-impact-review failed: ${err.message}\n`);
    process.exit(2);
  });
