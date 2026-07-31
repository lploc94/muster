// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { collectToolCardRenderObservations } from './render-probe';

function fixture(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
}

describe('collectToolCardRenderObservations', () => {
  it('collects stable retention-summary facts without reading diff text', () => {
    const observation = collectToolCardRenderObservations(fixture(`
      <section data-muster-file-changes>
        <article data-muster-file-change data-muster-retention-truncated="true">
          <div data-muster-file-summary="static">
            <span data-muster-file-path>src/aged.ts</span>
            <span data-muster-file-counts>+5 −3 (retention summary)</span>
          </div>
        </article>
      </section>
    `));

    expect(observation).toEqual({
      fileChangeGroups: [{ fileRowCount: 1 }],
      files: [{
        retentionTruncated: true,
        pathText: 'src/aged.ts',
        countsLabel: '+5 −3 (retention summary)',
        hasStaticSummary: true,
        hasDiffBody: false,
      }],
    });
  });

  it('distinguishes a normal expandable file row from a retention summary', () => {
    const observation = collectToolCardRenderObservations(fixture(`
      <section data-muster-file-changes>
        <article data-muster-file-change>
          <button data-muster-file-summary="expandable">
            <span data-muster-file-path>src/live.ts</span>
            <span data-muster-file-counts>+1 −1</span>
          </button>
          <div data-muster-diff-body></div>
        </article>
      </section>
    `));

    expect(observation.files).toEqual([{
      retentionTruncated: false,
      pathText: 'src/live.ts',
      countsLabel: '+1 −1',
      hasStaticSummary: false,
      hasDiffBody: true,
    }]);
  });

  it('reports empty groups and blank rendered text instead of filtering failed rows away', () => {
    const observation = collectToolCardRenderObservations(fixture(`
      <section data-muster-file-changes></section>
      <section data-muster-file-changes>
        <article data-muster-file-change data-muster-retention-truncated="true">
          <div data-muster-file-summary="static">
            <span data-muster-file-path>   </span>
            <span data-muster-file-counts></span>
          </div>
          <div data-muster-diff-body></div>
        </article>
      </section>
    `));

    expect(observation.fileChangeGroups).toEqual([
      { fileRowCount: 0 },
      { fileRowCount: 1 },
    ]);
    expect(observation.files[0]).toMatchObject({
      retentionTruncated: true,
      pathText: '',
      countsLabel: '',
      hasStaticSummary: true,
      hasDiffBody: true,
    });
  });
});
