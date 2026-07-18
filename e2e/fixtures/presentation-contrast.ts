import type { Page } from '@playwright/test';

/** Relative luminance for sRGB channels in 0–255. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two sRGB colors. */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export function parseCssRgb(color: string): [number, number, number] | null {
  const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export interface PresentationContrastSample {
  kind: 'table-cell' | 'mermaid-node' | 'mermaid-label';
  foreground: string;
  background: string;
  ratio: number;
  text?: string;
}

export interface PresentationContrastReport {
  ok: boolean;
  minRatio: number;
  samples: PresentationContrastSample[];
  failures: string[];
}

/**
 * Fail closed when Presentation tables or Mermaid nodes/labels are effectively
 * black-on-black / dark-on-black (the V02/V06 defect). Threshold is AA-ish for
 * large text; synthetic tokens should clear this easily when styles apply.
 */
export async function measurePresentationReadableContrast(
  page: Page,
  options: { minRatio?: number } = {},
): Promise<PresentationContrastReport> {
  const minRatio = options.minRatio ?? 3;
  return page.evaluate((threshold) => {
    const parse = (color: string): [number, number, number] | null => {
      const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    const lum = (rgb: [number, number, number]): number => {
      const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const ratioOf = (a: [number, number, number], b: [number, number, number]): number => {
      const l1 = lum(a);
      const l2 = lum(b);
      const hi = Math.max(l1, l2);
      const lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };
    const effectiveBg = (el: Element): string => {
      let cur: Element | null = el;
      while (cur && cur !== document.documentElement) {
        const bg = getComputedStyle(cur).backgroundColor;
        const parsed = parse(bg);
        if (parsed && !/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)/i.test(bg)) {
          return bg;
        }
        cur = cur.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };

    type Sample = {
      kind: 'table-cell' | 'mermaid-node' | 'mermaid-label';
      foreground: string;
      background: string;
      ratio: number;
      text?: string;
    };
    const samples: Sample[] = [];
    const failures: string[] = [];

    const cells = Array.from(
      document.querySelectorAll('.presentation-content table th, .presentation-content table td'),
    ).slice(0, 12);
    for (const cell of cells) {
      const cs = getComputedStyle(cell);
      const fg = parse(cs.color);
      const bgCss = effectiveBg(cell);
      const bg = parse(bgCss);
      if (!fg || !bg) {
        failures.push(`table-cell unparsable colors fg=${cs.color} bg=${bgCss}`);
        continue;
      }
      const ratio = ratioOf(fg, bg);
      const text = (cell.textContent || '').trim().slice(0, 40);
      samples.push({ kind: 'table-cell', foreground: cs.color, background: bgCss, ratio, text });
      if (ratio < threshold) {
        failures.push(`table-cell contrast ${ratio.toFixed(2)} < ${threshold} ("${text}")`);
      }
    }

    const mermaidRoot = document.querySelector(
      '.mermaid-diagram[data-mermaid-state="rendered"] svg',
    );
    if (mermaidRoot) {
      const nodeShapes = Array.from(
        mermaidRoot.querySelectorAll(
          '.node rect, .node circle, .node polygon, .node ellipse, rect.basic, .label-container',
        ),
      ).slice(0, 8);
      for (const shape of nodeShapes) {
        const cs = getComputedStyle(shape);
        const fill = parse(cs.fill) || parse(shape.getAttribute('fill') || '');
        const pageBgCss = effectiveBg(shape);
        const pageBg = parse(pageBgCss);
        if (!fill || !pageBg) {
          failures.push(`mermaid-node unparsable fill=${cs.fill}`);
          continue;
        }
        const fillVsPage = ratioOf(fill, pageBg);
        samples.push({
          kind: 'mermaid-node',
          foreground: cs.fill,
          background: pageBgCss,
          ratio: fillVsPage,
        });
        // Flag only the historical pure-black node defect (styles stripped), not
        // intentional near-page dark widget fills with visible borders/labels.
        const stroke = parse(cs.stroke) || parse(shape.getAttribute('stroke') || '');
        const pureBlackFill = fill[0] < 8 && fill[1] < 8 && fill[2] < 8;
        const strokeMissingOrBlack =
          !stroke || (stroke[0] < 20 && stroke[1] < 20 && stroke[2] < 20);
        if (pureBlackFill && strokeMissingOrBlack && lum(pageBg) < 0.08) {
          failures.push(`mermaid-node black-on-black fill=${cs.fill} page=${pageBgCss}`);
        }
      }

      const labels = Array.from(
        mermaidRoot.querySelectorAll('text, tspan, .nodeLabel, .label'),
      ).slice(0, 12);
      for (const label of labels) {
        const cs = getComputedStyle(label);
        const fillCss = cs.fill && cs.fill !== 'none' ? cs.fill : cs.color;
        const fg = parse(fillCss) || parse(label.getAttribute('fill') || '');
        const node = label.closest('.node') || label.parentElement;
        let bgCss = effectiveBg(label);
        if (node) {
          const shape = node.querySelector('rect, circle, polygon, ellipse, .label-container');
          if (shape) {
            const shapeFill = getComputedStyle(shape).fill;
            if (parse(shapeFill)) bgCss = shapeFill;
          }
        }
        const bg = parse(bgCss);
        if (!fg || !bg) {
          failures.push(`mermaid-label unparsable fill=${fillCss} bg=${bgCss}`);
          continue;
        }
        const ratio = ratioOf(fg, bg);
        const text = (label.textContent || '').trim().slice(0, 40);
        if (!text) continue;
        samples.push({ kind: 'mermaid-label', foreground: fillCss, background: bgCss, ratio, text });
        if (ratio < threshold) {
          failures.push(`mermaid-label contrast ${ratio.toFixed(2)} < ${threshold} ("${text}")`);
        }
      }
    } else if (document.querySelector('.mermaid-diagram')) {
      failures.push('mermaid diagram present but not data-mermaid-state=rendered');
    }

    if (cells.length === 0) {
      failures.push('no presentation table cells found for contrast sampling');
    }

    return {
      ok: failures.length === 0,
      minRatio: threshold,
      samples,
      failures,
    };
  }, minRatio);
}

export async function assertPresentationReadableContrast(
  page: Page,
  options: { minRatio?: number } = {},
): Promise<PresentationContrastReport> {
  const report = await measurePresentationReadableContrast(page, options);
  if (!report.ok) {
    const details = report.failures.join(' | ');
    throw new Error('Presentation contrast contract failed: ' + details);
  }
  return report;
}
