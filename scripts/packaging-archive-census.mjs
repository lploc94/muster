/**
 * Pure archive-entry census and allowlist evaluation for the packaging gate.
 * Operates on entry-name strings only — no zip or filesystem I/O — so S02 can
 * prove allowlist tightening with fixtures instead of a multi-minute package run.
 */

/**
 * @typedef {object} ArchiveCensus
 * @property {number} totalEntries
 * @property {number} nodeModulesEntries
 * @property {number} nonNodeModulesEntries
 * @property {Record<string, number>} topLevelCounts
 * @property {string[]} nodeModulesPackages
 * @property {Record<string, number>} nodeModulesPackageCounts
 */

/**
 * @typedef {object} AllowlistResult
 * @property {string} mode
 * @property {boolean} ok
 * @property {string[]} violations
 */

/**
 * @param {string} entryName
 * @returns {string}
 */
function normalizeEntryName(entryName) {
  return String(entryName ?? '').replaceAll('\\', '/');
}

/**
 * Top-level package prefix under extension/node_modules/ (scoped or unscoped).
 * Nested node_modules inside a package do not create additional prefixes.
 *
 * @param {string} normalized
 * @returns {string | null}
 */
function packagePrefixFromEntry(normalized) {
  const marker = 'extension/node_modules/';
  if (!normalized.startsWith(marker)) {
    return null;
  }
  const rest = normalized.slice(marker.length);
  if (!rest) {
    return null;
  }
  const segments = rest.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  if (segments[0].startsWith('@')) {
    if (segments.length < 2) {
      return null;
    }
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

/**
 * First path segment under extension/ (e.g. dist, node_modules, resources).
 *
 * @param {string} normalized
 * @returns {string | null}
 */
function topLevelUnderExtension(normalized) {
  if (!normalized.startsWith('extension/')) {
    return null;
  }
  const rest = normalized.slice('extension/'.length);
  if (!rest) {
    return null;
  }
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

/**
 * @param {string[]} entryNames
 * @returns {ArchiveCensus}
 */
export function buildArchiveCensus(entryNames) {
  const names = Array.isArray(entryNames) ? entryNames : [];
  /** @type {Record<string, number>} */
  const topLevelCounts = Object.create(null);
  /** @type {Record<string, number>} */
  const nodeModulesPackageCounts = Object.create(null);
  let nodeModulesEntries = 0;

  for (const raw of names) {
    const normalized = normalizeEntryName(raw);
    const top = topLevelUnderExtension(normalized);
    if (top) {
      topLevelCounts[top] = (topLevelCounts[top] ?? 0) + 1;
    }

    if (normalized.startsWith('extension/node_modules/') || normalized === 'extension/node_modules') {
      nodeModulesEntries += 1;
      const pkg = packagePrefixFromEntry(normalized);
      if (pkg) {
        nodeModulesPackageCounts[pkg] = (nodeModulesPackageCounts[pkg] ?? 0) + 1;
      }
    }
  }

  const totalEntries = names.length;
  const nodeModulesPackages = Object.keys(nodeModulesPackageCounts).sort((a, b) =>
    a.localeCompare(b),
  );

  return {
    totalEntries,
    nodeModulesEntries,
    nonNodeModulesEntries: totalEntries - nodeModulesEntries,
    topLevelCounts,
    nodeModulesPackages,
    nodeModulesPackageCounts,
  };
}

/**
 * @param {ArchiveCensus} census
 * @param {{ mode?: string, allowedNodeModulesPrefixes?: string[] }} allowlist
 * @returns {AllowlistResult}
 */
export function evaluateAllowlist(census, allowlist) {
  const mode = allowlist?.mode ?? 'current-tree';
  if (mode === 'current-tree') {
    return { mode, ok: true, violations: [] };
  }

  const allowed = new Set(allowlist?.allowedNodeModulesPrefixes ?? []);
  const packages = census?.nodeModulesPackages ?? [];
  const violations = packages.filter((pkg) => !allowed.has(pkg)).sort((a, b) => a.localeCompare(b));
  return {
    mode,
    ok: violations.length === 0,
    violations,
  };
}

/**
 * @param {string[]} entryNames
 * @param {string[]} requiredEntrypoints
 * @returns {string[]}
 */
export function findMissingEntrypoints(entryNames, requiredEntrypoints) {
  const present = new Set(
    (Array.isArray(entryNames) ? entryNames : []).map((name) => normalizeEntryName(name)),
  );
  const required = Array.isArray(requiredEntrypoints) ? requiredEntrypoints : [];
  return required.filter((req) => !present.has(normalizeEntryName(req)));
}

/**
 * @param {ArchiveCensus} census
 * @param {AllowlistResult} allowlistResult
 * @param {string[]} missingEntrypoints
 * @returns {string}
 */
export function formatCensusReport(census, allowlistResult, missingEntrypoints) {
  const lines = [];
  lines.push('Packaging archive census');
  lines.push(`totalEntries: ${census.totalEntries}`);
  lines.push(`nodeModulesEntries: ${census.nodeModulesEntries}`);
  lines.push(`nonNodeModulesEntries: ${census.nonNodeModulesEntries}`);

  const topLevels = Object.entries(census.topLevelCounts ?? {}).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  if (topLevels.length > 0) {
    lines.push('topLevelCounts:');
    for (const [name, count] of topLevels) {
      lines.push(`  ${name}: ${count}`);
    }
  }

  const counts = census.nodeModulesPackageCounts ?? {};
  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15);
  lines.push(`nodeModulesPackages: ${census.nodeModulesPackages?.length ?? 0}`);
  lines.push('top 15 node_modules packages by entry count:');
  if (ranked.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [name, count] of ranked) {
      lines.push(`  ${name}: ${count}`);
    }
  }

  lines.push(`allowlist.mode: ${allowlistResult?.mode ?? 'unknown'}`);
  lines.push(`allowlist.ok: ${allowlistResult?.ok === true ? 'true' : 'false'}`);
  const violations = allowlistResult?.violations ?? [];
  if (violations.length > 0) {
    lines.push(`allowlist.violations (${violations.length}):`);
    for (const v of violations) {
      lines.push(`  - ${v}`);
    }
  } else {
    lines.push('allowlist.violations: (none)');
  }

  const missing = Array.isArray(missingEntrypoints) ? missingEntrypoints : [];
  if (missing.length > 0) {
    lines.push(`missingEntrypoints (${missing.length}):`);
    for (const m of missing) {
      lines.push(`  - ${m}`);
    }
  } else {
    lines.push('missingEntrypoints: (none)');
  }

  return lines.join('\n');
}
