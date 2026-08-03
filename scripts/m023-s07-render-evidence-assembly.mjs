/**
 * Pure assembly of M023/S07 live Extension Development Host observations.
 * This module deliberately performs no filesystem or process I/O.
 */
import { validateTruncatedRenderEvidence } from './m023-s07-truncated-render-evidence-schema.mjs';

const HOST_KIND = 'm023-s07-truncated-render-host-result';
const MAX_BLOCKED_REASON_LENGTH = 500;

function boundedReason(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/[A-Za-z]:[\\/][^\s)]+/g, '<redacted-path>')
    .replace(/(?:\/Users\/|\/home\/|\/private\/tmp\/|\/var\/folders\/|\/tmp\/)[^\s)]+/g, '<redacted-path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BLOCKED_REASON_LENGTH);
}

/** @param {unknown} result @param {string} generatedAt @param {string} commitSha */
export function assembleTruncatedRenderEvidence(result, generatedAt = new Date().toISOString(), commitSha = '') {
  if (!result || typeof result !== 'object' || result.ok !== true || result.kind !== HOST_KIND) {
    throw new Error('live Extension Development Host DOM result is required for PASS evidence');
  }
  if (result.hostMode !== 'extension-development-host' || result.probeSource !== 'live-extension-host-dom') {
    throw new Error('live Extension Development Host DOM provenance is required for PASS evidence');
  }
  const evidence = {
    ok: true,
    kind: 'm023-s07-truncated-render-live-uat',
    schemaVersion: 1,
    verdict: 'PASS',
    provenance: {
      vscodeVersion: result.vscodeVersion,
      hostMode: result.hostMode,
      probeSource: result.probeSource,
    },
    observation: result.observation,
    contentSafety: {
      absolutePathsStoredInEvidence: false,
      messageBodiesStoredInEvidence: false,
      sessionIdsStoredInEvidence: false,
      canaryStoredInEvidence: false,
    },
    generatedAt,
    commitSha,
  };
  const failures = validateTruncatedRenderEvidence(evidence, { requirePass: true });
  if (failures.length) throw new Error(`live host observation failed evidence contract: ${failures.join('; ')}`);
  return evidence;
}

/** @param {unknown} error @param {string} generatedAt @param {string} commitSha */
export function assembleBlockedTruncatedRenderEvidence(error, generatedAt = new Date().toISOString(), commitSha = '') {
  const evidence = {
    ok: false,
    kind: 'm023-s07-truncated-render-live-uat',
    schemaVersion: 1,
    verdict: 'BLOCKED',
    blockedReason: boundedReason(error) || 'live Extension Development Host run was blocked without a diagnostic reason',
    generatedAt,
    commitSha,
  };
  const failures = validateTruncatedRenderEvidence(evidence);
  if (failures.length) throw new Error(`blocked evidence failed contract: ${failures.join('; ')}`);
  return evidence;
}
