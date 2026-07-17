import type { Page } from '@playwright/test';

/** Pinned authoring clock for visual pilots (static, timezone-independent ISO). */
export const VISUAL_CLOCK_ISO = '2026-03-15T12:00:00.000Z';

/** Compact main-webview containment for risk-coverage matrix cases. */
export const COMPACT_WEBVIEW_VIEWPORT = { width: 320, height: 600 } as const;

/** Pinned locale for visual pilots and Playwright project config. */
export const VISUAL_LOCALE = 'en-US';

/** Pinned IANA timezone for visual pilots and Playwright project config. */
export const VISUAL_TIMEZONE = 'UTC';

/**
 * Explicit font stack used for synthetic browser rasterization.
 * Does not prove native VS Code host font fallback.
 */
export const VISUAL_FONT_STACK =
  'Segoe WPC, Segoe UI, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"';

/** Editor/monospace stack used for code surfaces. */
export const VISUAL_EDITOR_FONT_STACK =
  'Consolas, "Courier New", monospace, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"';

export type VisualThemeKind = 'dark' | 'light' | 'high-contrast';

export interface VisualEnvironmentOptions {
  theme?: VisualThemeKind;
  locale?: string;
  timezone?: string;
  now?: string | number | Date;
  reducedMotion?: boolean;
  fontStack?: string;
  editorFontStack?: string;
  hideCaret?: boolean;
  normalizeScroll?: boolean;
}

/** Playwright `use` defaults shared by visual projects (T02+). */
export const VISUAL_PLAYWRIGHT_USE = {
  locale: VISUAL_LOCALE,
  timezoneId: VISUAL_TIMEZONE,
  colorScheme: 'dark' as const,
  deviceScaleFactor: 1,
  reducedMotion: 'reduce' as const,
};

const BODY_THEME_CLASS: Record<VisualThemeKind, string> = {
  dark: 'vscode-dark',
  light: 'vscode-light',
  'high-contrast': 'vscode-high-contrast',
};

/**
 * Static VS Code semantic tokens for synthetic browser themes.
 * These intentionally do not claim native host theme fidelity.
 */
export const VSCODE_THEME_TOKENS: Record<VisualThemeKind, Record<string, string>> = {
  dark: {
    '--vscode-font-family': VISUAL_FONT_STACK,
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': VISUAL_EDITOR_FONT_STACK,
    '--vscode-foreground': '#cccccc',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-disabledForeground': '#848484',
    '--vscode-errorForeground': '#f48771',
    '--vscode-icon-foreground': '#c5c5c5',
    '--vscode-focusBorder': '#007fd4',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)',
    '--vscode-editor-background': '#1e1e1e',
    '--vscode-editor-foreground': '#d4d4d4',
    '--vscode-editorCursor-foreground': '#aeafad',
    '--vscode-editor-selectionBackground': '#264f78',
    '--vscode-editorWarning-foreground': '#cca700',
    '--vscode-editorWidget-background': '#252526',
    '--vscode-editorHoverWidget-background': '#252526',
    '--vscode-editorHoverWidget-border': '#454545',
    '--vscode-editorHoverWidget-foreground': '#cccccc',
    '--vscode-sideBar-background': '#252526',
    '--vscode-panel-border': '#2b2b2b',
    '--vscode-input-background': '#3c3c3c',
    '--vscode-input-foreground': '#cccccc',
    '--vscode-input-border': '#3c3c3c',
    '--vscode-input-placeholderForeground': '#a6a6a6',
    '--vscode-inputValidation-errorBackground': '#5a1d1d',
    '--vscode-inputValidation-errorBorder': '#be1100',
    '--vscode-inputValidation-infoBorder': '#007acc',
    '--vscode-inputValidation-warningBackground': '#352a05',
    '--vscode-inputValidation-warningBorder': '#b89500',
    '--vscode-button-background': '#0e639c',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#1177bb',
    '--vscode-button-border': 'transparent',
    '--vscode-button-secondaryBackground': '#3a3d41',
    '--vscode-button-secondaryForeground': '#ffffff',
    '--vscode-button-secondaryHoverBackground': '#45494e',
    '--vscode-dropdown-background': '#3c3c3c',
    '--vscode-dropdown-foreground': '#f0f0f0',
    '--vscode-dropdown-border': '#3c3c3c',
    '--vscode-list-activeSelectionBackground': '#094771',
    '--vscode-list-activeSelectionForeground': '#ffffff',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-badge-background': '#4d4d4d',
    '--vscode-badge-foreground': '#ffffff',
    '--vscode-menu-background': '#252526',
    '--vscode-menu-foreground': '#cccccc',
    '--vscode-menu-border': '#454545',
    '--vscode-menu-selectionBackground': '#094771',
    '--vscode-menu-selectionForeground': '#ffffff',
    '--vscode-textLink-foreground': '#3794ff',
    '--vscode-textLink-activeForeground': '#3794ff',
    '--vscode-textCodeBlock-background': '#2b2b2b',
    '--vscode-toolbar-hoverBackground': '#2a2d2e',
    '--vscode-settings-dropdownBackground': '#3c3c3c',
    '--vscode-settings-dropdownBorder': '#3c3c3c',
    '--vscode-settings-dropdownListBorder': '#454545',
    '--vscode-charts-blue': '#3794ff',
    '--vscode-charts-orange': '#d18616',
    '--vscode-charts-yellow': '#b89500',
    '--vscode-testing-iconPassed': '#73c991',
    '--vscode-symbolIcon-folderForeground': '#dcb67a',
    '--vscode-symbolIcon-keywordForeground': '#569cd6',
    '--vscode-symbolIcon-propertyForeground': '#cccccc',
    '--vscode-symbolIcon-stringForeground': '#ce9178',
    '--vscode-symbolIcon-variableForeground': '#9cdcfe',
  },
  light: {
    '--vscode-font-family': VISUAL_FONT_STACK,
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': VISUAL_EDITOR_FONT_STACK,
    '--vscode-foreground': '#3b3b3b',
    '--vscode-descriptionForeground': '#616161',
    '--vscode-disabledForeground': '#949494',
    '--vscode-errorForeground': '#a1260d',
    '--vscode-icon-foreground': '#424242',
    '--vscode-focusBorder': '#0090f1',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.16)',
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#000000',
    '--vscode-editorCursor-foreground': '#000000',
    '--vscode-editor-selectionBackground': '#add6ff',
    '--vscode-editorWarning-foreground': '#bf8803',
    '--vscode-editorWidget-background': '#f3f3f3',
    '--vscode-editorHoverWidget-background': '#f3f3f3',
    '--vscode-editorHoverWidget-border': '#c8c8c8',
    '--vscode-editorHoverWidget-foreground': '#3b3b3b',
    '--vscode-sideBar-background': '#f3f3f3',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-foreground': '#3b3b3b',
    '--vscode-input-border': '#cecece',
    '--vscode-input-placeholderForeground': '#767676',
    '--vscode-inputValidation-errorBackground': '#f2dede',
    '--vscode-inputValidation-errorBorder': '#be1100',
    '--vscode-inputValidation-infoBorder': '#0090f1',
    '--vscode-inputValidation-warningBackground': '#f6f5d2',
    '--vscode-inputValidation-warningBorder': '#b89500',
    '--vscode-button-background': '#0078d4',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#026ec1',
    '--vscode-button-border': 'transparent',
    '--vscode-button-secondaryBackground': '#5f6a79',
    '--vscode-button-secondaryForeground': '#ffffff',
    '--vscode-button-secondaryHoverBackground': '#4c5561',
    '--vscode-dropdown-background': '#ffffff',
    '--vscode-dropdown-foreground': '#3b3b3b',
    '--vscode-dropdown-border': '#cecece',
    '--vscode-list-activeSelectionBackground': '#0060c0',
    '--vscode-list-activeSelectionForeground': '#ffffff',
    '--vscode-list-hoverBackground': '#f0f0f0',
    '--vscode-badge-background': '#cccccc',
    '--vscode-badge-foreground': '#3b3b3b',
    '--vscode-menu-background': '#ffffff',
    '--vscode-menu-foreground': '#3b3b3b',
    '--vscode-menu-border': '#cecece',
    '--vscode-menu-selectionBackground': '#0060c0',
    '--vscode-menu-selectionForeground': '#ffffff',
    '--vscode-textLink-foreground': '#006ab1',
    '--vscode-textLink-activeForeground': '#006ab1',
    '--vscode-textCodeBlock-background': '#f3f3f3',
    '--vscode-toolbar-hoverBackground': '#e8e8e8',
    '--vscode-settings-dropdownBackground': '#ffffff',
    '--vscode-settings-dropdownBorder': '#cecece',
    '--vscode-settings-dropdownListBorder': '#c8c8c8',
    '--vscode-charts-blue': '#1a85ff',
    '--vscode-charts-orange': '#d18616',
    '--vscode-charts-yellow': '#b89500',
    '--vscode-testing-iconPassed': '#388a34',
    '--vscode-symbolIcon-folderForeground': '#dcb67a',
    '--vscode-symbolIcon-keywordForeground': '#0000ff',
    '--vscode-symbolIcon-propertyForeground': '#001080',
    '--vscode-symbolIcon-stringForeground': '#a31515',
    '--vscode-symbolIcon-variableForeground': '#001080',
  },
  'high-contrast': {
    '--vscode-font-family': VISUAL_FONT_STACK,
    '--vscode-font-size': '13px',
    '--vscode-editor-font-family': VISUAL_EDITOR_FONT_STACK,
    '--vscode-foreground': '#ffffff',
    '--vscode-descriptionForeground': '#ffffff',
    '--vscode-disabledForeground': '#a0a0a0',
    '--vscode-errorForeground': '#f48771',
    '--vscode-icon-foreground': '#ffffff',
    '--vscode-focusBorder': '#f38518',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.6)',
    '--vscode-editor-background': '#000000',
    '--vscode-editor-foreground': '#ffffff',
    '--vscode-editorCursor-foreground': '#ffffff',
    '--vscode-editor-selectionBackground': '#ffffff',
    '--vscode-editorWarning-foreground': '#ffcc00',
    '--vscode-editorWidget-background': '#0c141f',
    '--vscode-editorHoverWidget-background': '#0c141f',
    '--vscode-editorHoverWidget-border': '#6fc3df',
    '--vscode-editorHoverWidget-foreground': '#ffffff',
    '--vscode-sideBar-background': '#000000',
    '--vscode-panel-border': '#6fc3df',
    '--vscode-input-background': '#000000',
    '--vscode-input-foreground': '#ffffff',
    '--vscode-input-border': '#6fc3df',
    '--vscode-input-placeholderForeground': '#ffffff',
    '--vscode-inputValidation-errorBackground': '#5a1d1d',
    '--vscode-inputValidation-errorBorder': '#be1100',
    '--vscode-inputValidation-infoBorder': '#6fc3df',
    '--vscode-inputValidation-warningBackground': '#352a05',
    '--vscode-inputValidation-warningBorder': '#ffcc00',
    '--vscode-button-background': '#0e639c',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#1177bb',
    '--vscode-button-border': '#6fc3df',
    '--vscode-button-secondaryBackground': '#000000',
    '--vscode-button-secondaryForeground': '#ffffff',
    '--vscode-button-secondaryHoverBackground': '#000000',
    '--vscode-dropdown-background': '#000000',
    '--vscode-dropdown-foreground': '#ffffff',
    '--vscode-dropdown-border': '#6fc3df',
    '--vscode-list-activeSelectionBackground': '#000000',
    '--vscode-list-activeSelectionForeground': '#ffffff',
    '--vscode-list-hoverBackground': '#000000',
    '--vscode-badge-background': '#000000',
    '--vscode-badge-foreground': '#ffffff',
    '--vscode-menu-background': '#000000',
    '--vscode-menu-foreground': '#ffffff',
    '--vscode-menu-border': '#6fc3df',
    '--vscode-menu-selectionBackground': '#000000',
    '--vscode-menu-selectionForeground': '#ffffff',
    '--vscode-textLink-foreground': '#3794ff',
    '--vscode-textLink-activeForeground': '#3794ff',
    '--vscode-textCodeBlock-background': '#000000',
    '--vscode-toolbar-hoverBackground': '#000000',
    '--vscode-settings-dropdownBackground': '#000000',
    '--vscode-settings-dropdownBorder': '#6fc3df',
    '--vscode-settings-dropdownListBorder': '#6fc3df',
    '--vscode-charts-blue': '#3794ff',
    '--vscode-charts-orange': '#d18616',
    '--vscode-charts-yellow': '#ffcc00',
    '--vscode-testing-iconPassed': '#73c991',
    '--vscode-symbolIcon-folderForeground': '#dcb67a',
    '--vscode-symbolIcon-keywordForeground': '#569cd6',
    '--vscode-symbolIcon-propertyForeground': '#ffffff',
    '--vscode-symbolIcon-stringForeground': '#ce9178',
    '--vscode-symbolIcon-variableForeground': '#9cdcfe',
  },
};

function resolveNowMs(now?: string | number | Date): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') return Date.parse(now);
  return Date.parse(VISUAL_CLOCK_ISO);
}

export function visualThemeTokens(theme: VisualThemeKind = 'dark'): Record<string, string> {
  return { ...VSCODE_THEME_TOKENS[theme] };
}

export function bodyThemeClass(theme: VisualThemeKind = 'dark'): string {
  return BODY_THEME_CLASS[theme];
}

interface VisualInitConfig {
  theme: VisualThemeKind;
  bodyClass: string;
  tokens: Record<string, string>;
  locale: string;
  timezone: string;
  nowMs: number;
  fontStack: string;
  editorFontStack: string;
  reducedMotion: boolean;
  hideCaret: boolean;
}

const PAGE_VISUAL_CONFIG = new WeakMap<Page, VisualInitConfig>();

function buildVisualInitConfig(options: VisualEnvironmentOptions = {}): VisualInitConfig {
  const theme = options.theme ?? 'dark';
  return {
    theme,
    bodyClass: BODY_THEME_CLASS[theme],
    tokens: visualThemeTokens(theme),
    locale: options.locale ?? VISUAL_LOCALE,
    timezone: options.timezone ?? VISUAL_TIMEZONE,
    nowMs: resolveNowMs(options.now),
    fontStack: options.fontStack ?? VISUAL_FONT_STACK,
    editorFontStack: options.editorFontStack ?? VISUAL_EDITOR_FONT_STACK,
    reducedMotion: options.reducedMotion ?? true,
    hideCaret: options.hideCaret ?? true,
  };
}

/**
 * Install page-level determinism for visual assertions:
 * theme tokens, body classes, font stack, frozen clock, reduced motion CSS, caret hide.
 * Call before navigation, then call ensureVisualEnvironmentApplied() after the page is ready.
 * Pair with VISUAL_PLAYWRIGHT_USE for locale/timezone/device scale.
 */
export async function installVisualEnvironment(
  page: Page,
  options: VisualEnvironmentOptions = {},
): Promise<void> {
  const config = buildVisualInitConfig(options);
  PAGE_VISUAL_CONFIG.set(page, config);

  if (config.reducedMotion) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  }

  // Prefer Playwright's clock for deterministic Date.now / timers.
  await page.clock.install({ time: config.nowMs });
  await page.clock.setFixedTime(config.nowMs);

  // Best-effort early paint via init script (may not survive every setContent path).
  await page.addInitScript((seed: VisualInitConfig) => {
    const apply = () => {
      if (!document.documentElement || !document.body || !document.head) return false;
      document.documentElement.lang = seed.locale;
      document.documentElement.setAttribute('data-muster-visual-theme', seed.theme);
      document.documentElement.setAttribute('data-muster-visual-timezone', seed.timezone);
      for (const cls of ['vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
        document.body.classList.remove(cls);
      }
      document.body.classList.add(seed.bodyClass);
      const styleId = 'muster-visual-environment';
      let style = document.getElementById(styleId) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement('style');
        style.id = styleId;
        document.head.appendChild(style);
      }
      const tokenLines = Object.entries(seed.tokens)
        .map(([key, value]) => `  ${key}: ${value};`)
        .join('\n');
      const motionRules = seed.reducedMotion
        ? `*,*::before,*::after{animation:none!important;animation-duration:0s!important;animation-iteration-count:1!important;transition:none!important;caret-color:${seed.hideCaret ? 'transparent' : 'auto'}!important;}`
        : seed.hideCaret
          ? `*,*::before,*::after{caret-color:transparent!important;}`
          : '';
      style.textContent = `:root{color-scheme:${seed.theme === 'light' ? 'light' : 'dark'};--vscode-font-family:${seed.fontStack};--vscode-editor-font-family:${seed.editorFontStack};${tokenLines}}html,body{font-family:${seed.fontStack};}${motionRules}`;
      return true;
    };
    (window as unknown as { __musterApplyVisualEnvironment?: () => boolean }).__musterApplyVisualEnvironment =
      apply;
    if (!apply()) {
      document.addEventListener('DOMContentLoaded', () => apply(), { once: true });
    }
  }, config);
}

/**
 * Re-apply theme tokens after navigation / setContent.
 * Uses the config captured by installVisualEnvironment (authoritative path).
 */
export async function ensureVisualEnvironmentApplied(page: Page): Promise<void> {
  const config = PAGE_VISUAL_CONFIG.get(page);
  if (!config) {
    throw new Error('ensureVisualEnvironmentApplied requires installVisualEnvironment(page) first');
  }
  const applied = await page.evaluate((seed) => {
    if (!document.documentElement || !document.body || !document.head) return false;
    document.documentElement.lang = seed.locale;
    document.documentElement.setAttribute('data-muster-visual-theme', seed.theme);
    document.documentElement.setAttribute('data-muster-visual-timezone', seed.timezone);
    for (const cls of ['vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light']) {
      document.body.classList.remove(cls);
    }
    document.body.classList.add(seed.bodyClass);
    const styleId = 'muster-visual-environment';
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }
    const tokenLines = Object.entries(seed.tokens)
      .map(([key, value]) => `  ${key}: ${value};`)
      .join('\n');
    const motionRules = seed.reducedMotion
      ? `
*, *::before, *::after {
  animation: none !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition: none !important;
  caret-color: ${seed.hideCaret ? 'transparent' : 'auto'} !important;
}
`
      : seed.hideCaret
        ? `
*, *::before, *::after {
  caret-color: transparent !important;
}
`
        : '';
    style.textContent = `
:root {
  color-scheme: ${seed.theme === 'light' ? 'light' : 'dark'};
  --vscode-font-family: ${seed.fontStack};
  --vscode-editor-font-family: ${seed.editorFontStack};
${tokenLines}
}
html, body {
  font-family: ${seed.fontStack};
}
${motionRules}
`;
    return true;
  }, config);
  if (!applied) {
    throw new Error('ensureVisualEnvironmentApplied: document shell not ready');
  }
}

/** Wait for document fonts (and optional selector) before screenshots. */
export async function waitForVisualReady(
  page: Page,
  options: { selector?: string; timeoutMs?: number } = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? 10_000;
  await page.waitForFunction(
    async (selector) => {
      if (document.fonts?.status !== 'loaded') {
        try {
          await document.fonts.ready;
        } catch {
          // ignore font readiness failures in synthetic environments
        }
      }
      if (selector) {
        return Boolean(document.querySelector(selector));
      }
      return document.fonts?.status === 'loaded' || document.fonts == null;
    },
    options.selector ?? null,
    { timeout },
  );
}

/** Blur focus and reset scroll so screenshots do not capture transient chrome. */
/**
 * Reset scroll without blurring focus. Use when the case intentionally keeps
 * focus (composer autocomplete, validation focus rings).
 */
export async function normalizeVisualScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (el instanceof HTMLElement && el.scrollTop) {
        el.scrollTop = 0;
      }
    }
  });
}

export async function normalizeVisualChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
    window.getSelection()?.removeAllRanges();
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (el instanceof HTMLElement && el.scrollTop) {
        el.scrollTop = 0;
      }
    }
  });
}

const FORBIDDEN_VISUAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'absolute-windows-path', re: /[A-Za-z]:\\/ },
  { name: 'absolute-unix-home-path', re: /\/(?:Users|home)\/[^/\s]+/ },
  { name: 'file-url', re: /file:\/\//i },
  { name: 'openai-style-secret', re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: 'github-pat', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}\b/i },
];

/** Reject fixture payloads that leak secrets, absolute paths, or live-looking tokens. */
export function assertSanitizedVisualFixture(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (!serialized) {
    throw new Error('sanitized visual fixture: empty payload');
  }
  for (const rule of FORBIDDEN_VISUAL_PATTERNS) {
    if (rule.re.test(serialized)) {
      throw new Error(`sanitized visual fixture violated ${rule.name}`);
    }
  }
}

/** Options for deterministic main-webview host snapshots (protocol v5). */
export interface StaticWebviewFixtureOptions {
  /** When set, projects a static Ask card for accessible validation coverage. */
  pendingAsk?: {
    turnId: string;
    askId: string;
    questions: Array<{ prompt: string; options: string[]; allowFreeText?: boolean }>;
  };
  taskId?: string;
  goal?: string;
  transcriptContent?: string;
  runtimeActivity?: 'idle' | 'running' | 'waiting';
  viewStatus?: 'idle' | 'running' | 'waiting' | 'error';
}

/**
 * Deterministic main-webview host snapshot: fixed ids, UTC timestamps, and no
 * secrets, absolute paths, or real user transcripts. Protocol v5 shape.
 */
export function createStaticWebviewFixture(
  options: StaticWebviewFixtureOptions = {},
) {
  const taskId = options.taskId ?? 'task-visual-pilot';
  const goal = options.goal ?? 'Visual pilot workspace';
  const task = {
    id: taskId,
    parentId: null,
    goal,
    role: 'coordinator',
    lifecycle: 'active',
    runtimeActivity: (options.runtimeActivity ?? 'idle') as 'idle',
    viewStatus: (options.viewStatus ?? 'idle') as 'idle',
    currentTurnActivity: null,
    updatedAt: VISUAL_CLOCK_ISO,
    backend: 'claude',
  };
  const fixture = {
    type: 'snapshot' as const,
    // Must match webview/src/lib/protocol.ts PROTOCOL_VERSION so the pilot
    // does not render the host/UI version-mismatch banner.
    protocolVersion: 5,
    rootTasks: [task],
    focusedTaskId: taskId,
    subtree: [task],
    transcript: [
      {
        id: 'msg-visual-pilot-1',
        kind: 'assistant' as const,
        content: options.transcriptContent ?? 'Synthetic visual pilot transcript.',
      },
    ],
    storeRevision: 1400,
    ...(options.pendingAsk ? { pendingAsk: options.pendingAsk } : {}),
  };
  assertSanitizedVisualFixture(fixture);
  return fixture;
}

/** Static free-text Ask used for accessible validation-error baselines. */
export function createStaticPendingAsk() {
  return {
    turnId: 'turn-visual-ask',
    askId: 'ask-visual-validation',
    questions: [
      {
        prompt: 'Confirm the visual gate fixture label',
        options: [] as string[],
        allowFreeText: true,
      },
    ],
  };
}

/** Static runtime permission payload for compact Settings + prompt baselines. */
export function createStaticPendingPermission() {
  return {
    sessionId: 'session-visual-prompt',
    permissionId: 'perm-visual-prompt',
    title: 'Write docs/UI-VISUAL-REGRESSION.md',
    kind: 'write',
    classification: 'write' as const,
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'reject', name: 'Deny', kind: 'reject' as const },
    ],
  };
}

/** Host message that projects a runtime permission card. */
export function createStaticPermissionPendingMessage() {
  return {
    type: 'permissionPending' as const,
    protocolVersion: 5,
    ...createStaticPendingPermission(),
  };
}

/** Sanitized runtime storage settings snapshot for Settings panel baselines. */
export function createStaticRuntimeStorageSettingsSnapshot() {
  return {
    settings: [
      {
        id: 'runLimit',
        kind: 'enum',
        description: 'Maximum uninterrupted agent run duration.',
        defaultValue: '30m',
        value: '30m',
        options: ['15m', '30m', '1h', '2h', '4h', '8h'],
      },
      {
        id: 'maxRetainedTurnsPerTask',
        kind: 'number',
        description: 'Completed turns kept per task.',
        defaultValue: 50,
        value: 50,
        minimum: 1,
      },
      {
        id: 'maxStoredOutputChars',
        kind: 'number',
        description: 'Stored output characters per retained turn.',
        defaultValue: 200_000,
        value: 200_000,
        minimum: 1_000,
      },
    ],
  };
}

/** Sanitized permission policy snapshot for Settings panel baselines. */
export function createStaticPermissionSettingsSnapshot() {
  return {
    activeMode: 'ask' as const,
    options: [
      {
        mode: 'ask' as const,
        label: 'Ask',
        description:
          'Safe: auto-allow read-only tool calls, prompt for writes/commands/unknown actions.',
        risk: 'recommended' as const,
      },
      {
        mode: 'allow' as const,
        label: 'Allow',
        description: 'Auto-allow all tool calls for this workspace session.',
        risk: 'elevated' as const,
      },
    ],
  };
}

/** Sanitized task-type catalog snapshot for Settings panel baselines. */
export function createStaticTaskTypesSettingsSnapshot() {
  return {
    types: [
      {
        id: 'worker',
        label: 'Worker',
        description: 'Default worker task type for visual fixtures.',
        backend: 'claude',
        role: 'worker' as const,
        briefKind: 'generic' as const,
        isDefault: true,
        isBuiltIn: true,
      },
    ],
    defaults: [
      {
        id: 'worker',
        backend: 'claude',
        role: 'worker' as const,
        briefKind: 'generic' as const,
      },
    ],
    constraints: {
      maxTypes: 32,
      idPattern: '^[a-z][a-z0-9_-]{0,63}$',
      descriptionMax: 200,
      stringMax: 128,
      roles: ['coordinator', 'worker'] as Array<'coordinator' | 'worker'>,
      briefKinds: ['generic', 'investigation', 'implementation'],
    },
  };
}

/** Relative-only file mention suggestions (no absolute paths or cwd). */
export function createStaticFileMentionSuggestions(
  requestId: string,
  options: { parentDepth?: 0 | 1 | 2; relativeQuery?: string } = {},
) {
  // Protocol success shape: items + parentDepth + relativeQuery (not `suggestions`).
  // Type guard rejects unknown keys and requires these fields.
  return {
    type: 'fileMentionSuggestions' as const,
    requestId,
    parentDepth: (options.parentDepth ?? 0) as 0 | 1 | 2,
    relativeQuery: options.relativeQuery ?? 're',
    items: [
      {
        id: 'file:readme.md',
        kind: 'file' as const,
        label: 'readme.md',
        insertionPath: 'readme.md',
      },
      {
        id: 'dir:docs',
        kind: 'directory' as const,
        label: 'docs',
        insertionPath: 'docs',
      },
    ],
  };
}

/** Static Presentation pilot fixture. */
export function createStaticPresentationFixture() {
  const fixture = {
    presentationId: 'visual-pilot-presentation',
    ownerTaskId: 'task-visual-pilot',
    revision: 1,
    title: 'Visual pilot presentation',
    markdown: [
      '# Visual pilot presentation',
      '',
      'Synthetic document used only for deterministic screenshots.',
      '',
      '| Area | State |',
      '| --- | --- |',
      '| Baseline | Pinned |',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Start] --> B[Finish]',
      '```',
    ].join('\n'),
    kind: 'document' as const,
    sourcePath: 'synthetic/visual-pilot.md',
    updatedAt: VISUAL_CLOCK_ISO,
  };
  assertSanitizedVisualFixture(fixture);
  return fixture;
}
