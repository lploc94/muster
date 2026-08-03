/**
 * Read-only DOM observations used by the UAT-only host probe.
 *
 * The collector deliberately reads only explicitly marked render facts. It never
 * traverses payload or diff-line text, keeping the observation bounded to the
 * file path and summary state the live UAT needs to verify.
 */
export interface ToolCardFileRenderObservation {
  retentionTruncated: boolean;
  pathText: string;
  countsLabel: string;
  hasStaticSummary: boolean;
  hasDiffBody: boolean;
}

export interface ToolCardRenderObservation {
  fileChangeGroups: Array<{ fileRowCount: number }>;
  files: ToolCardFileRenderObservation[];
}

function textAt(row: Element, selector: string): string {
  return row.querySelector(selector)?.textContent?.trim() ?? '';
}

/** Collect probe facts from ToolCard's stable, explicitly marked DOM surface. */
export function collectToolCardRenderObservations(root: ParentNode): ToolCardRenderObservation {
  const groups = Array.from(root.querySelectorAll('[data-muster-file-changes]'));
  const rows = Array.from(root.querySelectorAll('[data-muster-file-change]'));

  return {
    fileChangeGroups: groups.map((group) => ({
      fileRowCount: group.querySelectorAll('[data-muster-file-change]').length,
    })),
    files: rows.map((row) => ({
      retentionTruncated: row.getAttribute('data-muster-retention-truncated') === 'true',
      pathText: textAt(row, '[data-muster-file-path]'),
      countsLabel: textAt(row, '[data-muster-file-counts]'),
      hasStaticSummary: row.querySelector('[data-muster-file-summary="static"]') !== null,
      hasDiffBody: row.querySelector('[data-muster-diff-body]') !== null,
    })),
  };
}
