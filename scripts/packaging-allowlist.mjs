/**
 * Packaging archive node_modules allowlist contract (data only).
 *
 * mode: 'current-tree'
 *   S01 baseline. Every staged node_modules package is recorded by the census
 *   but not restricted — evaluateAllowlist always returns ok with no violations.
 *
 * mode: 'sdk-closure-only' (S02)
 *   Flip mode and fill allowedNodeModulesPrefixes with the runtime closure of
 *   the MCP SDK so only those packages may appear under extension/node_modules/.
 *
 * D067: @modelcontextprotocol/sdk (and its transitive runtime closure) must
 * remain staged. src/bridge/server.ts resolves the SDK CJS build and express
 * dynamically at runtime; removing the SDK from the archive breaks the MCP
 * bridge listen path. Do not drop sdkClosureRootPackages when tightening.
 *
 * allowedNodeModulesPrefixes is the production dependency closure walked from
 * package-lock.json root packages[''].dependencies (currently 91
 * packages). scripts/packaging-allowlist-closure.test.mjs fails if this literal
 * array drifts from the real lockfile walk.
 */

/** @typedef {'current-tree' | 'sdk-closure-only'} PackagingAllowlistMode */

/**
 * @typedef {object} PackagingAllowlist
 * @property {PackagingAllowlistMode} mode
 * @property {string[]} allowedNodeModulesPrefixes
 * @property {string[]} sdkClosureRootPackages
 */

/** @type {PackagingAllowlist} */
export const PACKAGING_ALLOWLIST = {
  mode: 'sdk-closure-only',
  /**
   * Production dependency closure of @modelcontextprotocol/sdk (lockfile walk).
   * Keep sorted; drift test compares against walkProductionClosureFromLockfile.
   */
  allowedNodeModulesPrefixes: [
    '@hono/node-server',
    '@modelcontextprotocol/sdk',
    'accepts',
    'ajv',
    'ajv-formats',
    'body-parser',
    'bytes',
    'call-bind-apply-helpers',
    'call-bound',
    'content-disposition',
    'content-type',
    'cookie',
    'cookie-signature',
    'cors',
    'cross-spawn',
    'debug',
    'depd',
    'dunder-proto',
    'ee-first',
    'encodeurl',
    'es-define-property',
    'es-errors',
    'es-object-atoms',
    'escape-html',
    'etag',
    'eventsource',
    'eventsource-parser',
    'express',
    'express-rate-limit',
    'fast-deep-equal',
    'fast-uri',
    'finalhandler',
    'forwarded',
    'fresh',
    'function-bind',
    'get-intrinsic',
    'get-proto',
    'gopd',
    'has-symbols',
    'hasown',
    'hono',
    'http-errors',
    'iconv-lite',
    'inherits',
    'ip-address',
    'ipaddr.js',
    'is-promise',
    'isexe',
    'jose',
    'json-schema-traverse',
    'json-schema-typed',
    'math-intrinsics',
    'media-typer',
    'merge-descriptors',
    'mime-db',
    'mime-types',
    'ms',
    'negotiator',
    'object-assign',
    'object-inspect',
    'on-finished',
    'once',
    'parseurl',
    'path-key',
    'path-to-regexp',
    'pkce-challenge',
    'proxy-addr',
    'qs',
    'range-parser',
    'raw-body',
    'require-from-string',
    'router',
    'safer-buffer',
    'send',
    'serve-static',
    'setprototypeof',
    'shebang-command',
    'shebang-regex',
    'side-channel',
    'side-channel-list',
    'side-channel-map',
    'side-channel-weakmap',
    'statuses',
    'toidentifier',
    'type-is',
    'unpipe',
    'vary',
    'which',
    'wrappy',
    'zod',
    'zod-to-json-schema',
  ],
  sdkClosureRootPackages: ['@modelcontextprotocol/sdk'],
};

/** Archive paths that must exist for the three spawned host entry points. */
export const REQUIRED_ARCHIVE_ENTRYPOINTS = [
  'extension/dist/src/extension.js',
  'extension/dist/src/task/sqlite/worker.js',
  'extension/dist/src/bridge/mcp-stdio-proxy.js',
];

/**
 * Marketplace metadata that must ship in the VSIX (M022/S03).
 * Paths are matched case-insensitively against archive entry names so
 * vsce's changelog casing does not break the gate.
 */
export const REQUIRED_MARKETPLACE_ARCHIVE_ENTRIES = [
  'extension/resources/icon.png',
  'extension/changelog.md',
];
