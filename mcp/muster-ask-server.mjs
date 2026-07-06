#!/usr/bin/env node
/**
 * Muster bridge MCP — ask_user blocks until the coordinator writes answers/<id>.json
 * Env: MUSTER_RUNTIME_DIR (required)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

const runtimeDir = process.env.MUSTER_RUNTIME_DIR;
if (!runtimeDir) {
  console.error('MUSTER_RUNTIME_DIR is required');
  process.exit(1);
}

const pendingDir = path.join(runtimeDir, 'pending');
const answersDir = path.join(runtimeDir, 'answers');
fs.mkdirSync(pendingDir, { recursive: true });
fs.mkdirSync(answersDir, { recursive: true });

const POLL_MS = 200;
const TIMEOUT_MS = Number(process.env.MUSTER_ASK_TIMEOUT_MS ?? 120_000);

function waitForAnswer(id) {
  const answerPath = path.join(answersDir, `${id}.json`);
  const deadline = Date.now() + TIMEOUT_MS;

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
          id: { type: 'string', description: 'Optional ask id' },
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
  const id = input.id ?? `ask-${Date.now()}`;
  const questions = input.questions ?? [];

  const pendingPath = path.join(pendingDir, `${id}.json`);
  fs.writeFileSync(
    pendingPath,
    JSON.stringify({ id, questions, createdAt: new Date().toISOString() }, null, 2),
  );

  try {
    const answers = await waitForAnswer(id);
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