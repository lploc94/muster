#!/usr/bin/env node
/**
 * Muster bridge MCP — ask_user blocks until the coordinator writes answers/<id>.json
 * Env: MUSTER_RUNTIME_DIR (required)
 *
 * DEV-ONLY SPIKE: this stdio MCP server is an unwired development spike. Nothing
 * in `src/` imports or spawns it, and it is excluded from the published .vsix
 * (see `.vscodeignore` — `mcp/**`). It is kept for local experimentation only.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const POLL_MS = 200;

// The ask `id` is agent-controlled and is interpolated directly into on-disk
// paths for BOTH the pending write (`pending/<id>.json`) and the answer read
// (`answers/<id>.json`, whose contents are returned to the agent). Without
// validation an id like `../../../home/user/.ssh/foo` yields arbitrary-file
// write and arbitrary-file read (info disclosure). Restrict to a strict
// allowlist and additionally reject the `.`/`..` traversal names, which the
// character class alone would otherwise permit.
const ASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Validate an agent-supplied ask id, returning it unchanged when safe.
 * @param {unknown} id
 * @returns {string}
 * @throws {Error} when the id could escape the pending/answers directories.
 */
export function sanitizeAskId(id) {
  if (typeof id !== 'string' || !ASK_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error(`Invalid ask id: ${JSON.stringify(id)}`);
  }
  return id;
}

function waitForAnswer(answersDir, id, timeoutMs) {
  const answerPath = path.join(answersDir, `${id}.json`);
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(answerPath)) {
        try {
          resolve(JSON.parse(fs.readFileSync(answerPath, 'utf8')));
          return;
        } catch (err) {
          reject(err);
          return;
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timeout waiting for answer: ${id}`));
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

async function main() {
  const runtimeDir = process.env.MUSTER_RUNTIME_DIR;
  if (!runtimeDir) {
    console.error('MUSTER_RUNTIME_DIR is required');
    process.exit(1);
  }

  const pendingDir = path.join(runtimeDir, 'pending');
  const answersDir = path.join(runtimeDir, 'answers');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(answersDir, { recursive: true });

  const timeoutMs = Number(process.env.MUSTER_ASK_TIMEOUT_MS ?? 120_000);

  const server = new Server(
    { name: 'muster_bridge', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ask_user',
        description:
          'Ask the human user one or more questions and wait for their answers. Use when you need a decision or clarification.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Optional ask id (letters, digits, dot, dash, underscore; max 128 chars)',
              pattern: ASK_ID_PATTERN.source,
              maxLength: 128,
            },
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  prompt: { type: 'string' },
                  options: { type: 'array', items: { type: 'string' } },
                  allowFreeText: { type: 'boolean' },
                },
                required: ['prompt'],
              },
            },
          },
          required: ['questions'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'ask_user') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    const input = request.params.arguments ?? {};
    const questions = input.questions ?? [];

    let id;
    try {
      // Sanitise before the value ever touches the filesystem; this guards both
      // the pending write below and the answer read inside waitForAnswer.
      id = sanitizeAskId(input.id ?? `ask-${Date.now()}`);
    } catch (err) {
      return {
        content: [{ type: 'text', text: String(err?.message ?? err) }],
        isError: true,
      };
    }

    const pendingPath = path.join(pendingDir, `${id}.json`);
    fs.writeFileSync(
      pendingPath,
      JSON.stringify({ id, questions, createdAt: new Date().toISOString() }, null, 2),
    );

    try {
      const answers = await waitForAnswer(answersDir, id, timeoutMs);
      return {
        content: [{ type: 'text', text: JSON.stringify({ id, answers }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: String(err?.message ?? err) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only bootstrap the stdio server when executed directly as the CLI entrypoint.
// Importing this module (e.g. a unit test exercising sanitizeAskId) must not
// spawn the transport, exit the process, or touch the filesystem.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
