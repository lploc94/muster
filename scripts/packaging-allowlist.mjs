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
  mode: 'current-tree',
  allowedNodeModulesPrefixes: [],
  sdkClosureRootPackages: ['@modelcontextprotocol/sdk'],
};

/** Archive paths that must exist for the three spawned host entry points. */
export const REQUIRED_ARCHIVE_ENTRYPOINTS = [
  'extension/dist/src/extension.js',
  'extension/dist/src/task/sqlite/worker.js',
  'extension/dist/src/bridge/mcp-stdio-proxy.js',
];
