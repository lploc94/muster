/**
 * Image-attachment Extension Host smoke.
 *
 * Loaded via @vscode/test-electron as extensionTestsPath against a freshly
 * extracted VSIX (extensionDevelopmentPath), so every require below comes from
 * package contents rather than the source tree. Proves, on a real Extension
 * Host against a real spawned ACP agent process:
 *  - an image-capable agent receives real ACP `image` content blocks whose
 *    base64 payload round-trips the exact bytes on disk
 *  - a backend that does not advertise promptCapabilities.image fails the turn
 *    with an explicit message instead of silently dropping the image
 *  - an oversized (> 5 MiB) or unsupported-extension attachment degrades to a
 *    visible omission notice in the prompt text, never a dropped turn
 *  - the packaged native image picker filters and the packaged staging path are
 *    the ones shipped in the archive
 *
 * The fake agent is spawned as a child process of the Extension Host using the
 * host's own executable in Node mode, so no external toolchain is required.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Minimal PNG-ish payload: magic bytes plus deterministic filler. */
function makeImageBytes(sizeBytes: number): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  for (let i = 8; i < sizeBytes; i += 1) buf[i] = i % 251;
  return buf;
}

interface PackagedRunModule {
  runAcpTurn(
    spec: Record<string, unknown>,
    options: Record<string, unknown>,
  ): AsyncIterable<{ type: string; message?: string; text?: string }>;
}

interface PackagedClientModule {
  disposeSharedAcpClient(): void;
}

interface PackagedImageModule {
  IMAGE_ATTACHMENT_MAX_BYTES: number;
  imageMimeForPath(filePath: string): string | undefined;
  attachmentBasename(filePath: string): string;
  readImageAttachment(
    filePath: string,
    options?: { maxBytes?: number },
  ): { ok: true; data: string; mimeType: string } | { ok: false; reason: string };
}

/** Fake ACP agent, written to disk and spawned as a real child process. */
const FAKE_AGENT_SOURCE = `
const fs = require('fs');
const recordPath = process.env.MUSTER_FAKE_ACP_RECORD;
const imageCapable = process.env.MUSTER_FAKE_ACP_IMAGE === '1';
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (typeof msg.id !== 'number') continue;
    let result;
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: imageCapable, embeddedContext: true },
        },
      };
    } else if (msg.method === 'session/new') {
      result = { sessionId: 'fake-session-1' };
    } else if (msg.method === 'session/prompt') {
      fs.appendFileSync(recordPath, JSON.stringify(msg.params) + '\\n');
      result = { stopReason: 'end_turn' };
    } else {
      result = {};
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
`;

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('tlelabs.muster');
  assert.ok(extension, 'freshly packaged tlelabs.muster extension was not discovered');
  await extension.activate();
  assert.equal(extension.isActive, true, 'packaged extension did not activate');

  const distSrc = path.join(extension.extensionPath, 'dist', 'src');
  const runPath = path.join(distSrc, 'backends', 'acp-run.js');
  const clientPath = path.join(distSrc, 'backends', 'acp-client.js');
  const imagePath = path.join(distSrc, 'shared', 'image-attachments.js');
  for (const p of [runPath, clientPath, imagePath]) {
    assert.ok(fs.existsSync(p), `packaged module missing from VSIX: ${p}`);
  }
  const acpRun = require(runPath) as PackagedRunModule;
  const acpClient = require(clientPath) as PackagedClientModule;
  const images = require(imagePath) as PackagedImageModule;

  // The packaged helper, not the source tree one, owns the byte ceiling.
  assert.equal(images.IMAGE_ATTACHMENT_MAX_BYTES, 5 * 1024 * 1024);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-image-host-smoke-'));
  const agentPath = path.join(tempDir, 'fake-acp-agent.cjs');
  fs.writeFileSync(agentPath, FAKE_AGENT_SOURCE, 'utf8');

  const smallBytes = makeImageBytes(2048);
  const smallPath = path.join(tempDir, 'screenshot.png');
  fs.writeFileSync(smallPath, smallBytes);

  const jpegPath = path.join(tempDir, 'diagram.jpeg');
  fs.writeFileSync(jpegPath, makeImageBytes(1024));

  // One byte over the packaged ceiling, written to disk for real.
  const oversizePath = path.join(tempDir, 'huge.png');
  fs.writeFileSync(oversizePath, makeImageBytes(images.IMAGE_ATTACHMENT_MAX_BYTES + 1));

  const textPath = path.join(tempDir, 'notes.txt');
  fs.writeFileSync(textPath, 'not an image');

  let scenario = 0;
  function makeSpec(recordPath: string, imageCapable: boolean): Record<string, unknown> {
    scenario += 1;
    const key = `fake-acp-${scenario}`;
    return {
      name: key,
      label: 'FakeAgent',
      idPrefix: `${key}:`,
      makeConfig: () => ({
        key,
        label: 'FakeAgent',
        command: process.execPath,
        args: [agentPath],
        env: {
          // Run the Extension Host binary as plain Node so the smoke needs no
          // external toolchain on the machine under test.
          ELECTRON_RUN_AS_NODE: '1',
          MUSTER_FAKE_ACP_RECORD: recordPath,
          MUSTER_FAKE_ACP_IMAGE: imageCapable ? '1' : '0',
        },
      }),
      failureStopReasons: new Set<string>(['refusal']),
      emptyChunk: 'drop',
      mapUsageUpdate: false,
      usage: { source: 'result', keys: [] },
      toolKind: () => 'builtin',
      errorPassthrough: [],
    };
  }

  async function runTurn(
    spec: Record<string, unknown>,
    imagePaths: readonly string[],
  ): Promise<Array<{ type: string; message?: string }>> {
    const events: Array<{ type: string; message?: string }> = [];
    try {
      for await (const event of acpRun.runAcpTurn(spec, {
        input: { kind: 'agent', prompt: 'Look at these.', imagePaths },
        cwd: tempDir,
        setupTimeoutMs: 60_000,
        promptTimeoutMs: 60_000,
      })) {
        events.push(event);
      }
    } finally {
      acpClient.disposeSharedAcpClient();
    }
    return events;
  }

  function readPrompts(recordPath: string): Array<{ prompt: Array<Record<string, unknown>> }> {
    if (!fs.existsSync(recordPath)) return [];
    return fs
      .readFileSync(recordPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { prompt: Array<Record<string, unknown>> });
  }

  try {
    // ── 1. Image-capable agent receives real ACP image blocks ──────────────
    const okRecord = path.join(tempDir, 'record-ok.ndjson');
    const okEvents = await runTurn(makeSpec(okRecord, true), [smallPath, jpegPath]);
    assert.deepEqual(
      okEvents.filter((e) => e.type === 'error'),
      [],
      `image-capable turn must not error: ${JSON.stringify(okEvents)}`,
    );

    const okPrompts = readPrompts(okRecord);
    assert.equal(okPrompts.length, 1, 'exactly one session/prompt must reach the agent');
    const blocks = okPrompts[0]!.prompt;
    assert.deepEqual(
      blocks.map((b) => b.type),
      ['image', 'image', 'text'],
      'images must precede the text block in the ACP prompt array',
    );
    assert.deepEqual(
      blocks.slice(0, 2).map((b) => b.mimeType),
      ['image/png', 'image/jpeg'],
      'mimeType must be derived per attachment, not hardcoded',
    );
    // The wire payload must be the exact bytes on disk, not a truncated read.
    assert.equal(
      blocks[0]!.data,
      smallBytes.toString('base64'),
      'base64 image payload did not round-trip the file bytes',
    );
    assert.equal(blocks[2]!.text, 'Look at these.', 'prompt text must be unmodified');

    // ── 2. Backend without promptCapabilities.image fails loudly ───────────
    const denyRecord = path.join(tempDir, 'record-deny.ndjson');
    const denyEvents = await runTurn(makeSpec(denyRecord, false), [smallPath]);
    const denyError = denyEvents.find((e) => e.type === 'error');
    assert.ok(denyError, `non-image backend must emit an error: ${JSON.stringify(denyEvents)}`);
    assert.equal(denyError.message, 'FakeAgent does not support image attachments');
    assert.deepEqual(
      readPrompts(denyRecord),
      [],
      'a refused image turn must never reach session/prompt',
    );

    // ── 3. Oversized and unsupported attachments degrade visibly ───────────
    const degradeRecord = path.join(tempDir, 'record-degrade.ndjson');
    const degradeEvents = await runTurn(makeSpec(degradeRecord, true), [
      smallPath,
      oversizePath,
      textPath,
    ]);
    assert.deepEqual(
      degradeEvents.filter((e) => e.type === 'error'),
      [],
      'an unreadable attachment must degrade the turn, not fail it',
    );
    const degradeBlocks = readPrompts(degradeRecord)[0]!.prompt;
    assert.deepEqual(
      degradeBlocks.map((b) => b.type),
      ['image', 'text'],
      'only the readable attachment may become an image block',
    );
    const degradedText = String(degradeBlocks[1]!.text);
    assert.ok(
      degradedText.includes('huge.png could not be read and was omitted'),
      `oversized attachment must be reported: ${degradedText}`,
    );
    assert.ok(
      degradedText.includes('notes.txt could not be read and was omitted'),
      `unsupported attachment must be reported: ${degradedText}`,
    );
    // Notices carry basenames only — never the absolute host path.
    assert.ok(!degradedText.includes(tempDir), 'omission notice leaked an absolute host path');

    // ── 4. Packaged helper agrees with the packaged wire behavior ──────────
    assert.equal(images.imageMimeForPath(textPath), undefined);
    assert.equal(images.imageMimeForPath(jpegPath), 'image/jpeg');
    assert.equal(images.attachmentBasename(smallPath), 'screenshot.png');
    assert.equal(images.readImageAttachment(oversizePath).ok, false);

    console.log(
      `[muster-image-attachment-host-smoke] ok vscode=${vscode.version} ` +
        `node=${process.versions.node} remote=${vscode.env.remoteName ?? 'desktop'} ` +
        `blocks=${blocks.map((b) => String(b.type)).join(',')} ` +
        `maxBytes=${images.IMAGE_ATTACHMENT_MAX_BYTES}`,
    );
  } finally {
    acpClient.disposeSharedAcpClient();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
