/**
 * Shared codicon mapping for file mentions and workspace file pickers.
 * Kind drives folder vs file; known extensions get a more specific glyph.
 * Webview uses the full `codicon-*` class; host Quick Pick uses the ThemeIcon id.
 */

export type FileMentionIconKind = 'file' | 'directory';

/** Extension (no dot, lowercased) → full codicon class. */
const EXTENSION_ICONS: Record<string, string> = {
  ts: 'codicon-file-code',
  tsx: 'codicon-file-code',
  js: 'codicon-file-code',
  jsx: 'codicon-file-code',
  mjs: 'codicon-file-code',
  cjs: 'codicon-file-code',
  cts: 'codicon-file-code',
  mts: 'codicon-file-code',
  vue: 'codicon-file-code',
  svelte: 'codicon-file-code',
  py: 'codicon-python',
  rb: 'codicon-ruby',
  go: 'codicon-file-code',
  rs: 'codicon-file-code',
  java: 'codicon-file-code',
  kt: 'codicon-file-code',
  swift: 'codicon-file-code',
  c: 'codicon-file-code',
  h: 'codicon-file-code',
  cpp: 'codicon-file-code',
  cc: 'codicon-file-code',
  cxx: 'codicon-file-code',
  hpp: 'codicon-file-code',
  cs: 'codicon-file-code',
  php: 'codicon-file-code',
  sh: 'codicon-terminal',
  bash: 'codicon-terminal',
  zsh: 'codicon-terminal',
  fish: 'codicon-terminal',
  ps1: 'codicon-terminal',
  bat: 'codicon-terminal',
  cmd: 'codicon-terminal',
  json: 'codicon-json',
  jsonc: 'codicon-json',
  json5: 'codicon-json',
  yaml: 'codicon-file-code',
  yml: 'codicon-file-code',
  toml: 'codicon-file-code',
  xml: 'codicon-file-code',
  html: 'codicon-file-code',
  htm: 'codicon-file-code',
  css: 'codicon-file-code',
  scss: 'codicon-file-code',
  less: 'codicon-file-code',
  sass: 'codicon-file-code',
  md: 'codicon-markdown',
  mdx: 'codicon-markdown',
  markdown: 'codicon-markdown',
  txt: 'codicon-file-text',
  log: 'codicon-file-text',
  csv: 'codicon-file-text',
  tsv: 'codicon-file-text',
  sql: 'codicon-database',
  db: 'codicon-database',
  sqlite: 'codicon-database',
  png: 'codicon-file-media',
  jpg: 'codicon-file-media',
  jpeg: 'codicon-file-media',
  gif: 'codicon-file-media',
  webp: 'codicon-file-media',
  svg: 'codicon-file-media',
  ico: 'codicon-file-media',
  bmp: 'codicon-file-media',
  mp3: 'codicon-file-media',
  mp4: 'codicon-file-media',
  wav: 'codicon-file-media',
  webm: 'codicon-file-media',
  pdf: 'codicon-file-pdf',
  zip: 'codicon-file-zip',
  gz: 'codicon-file-zip',
  tgz: 'codicon-file-zip',
  tar: 'codicon-file-zip',
  rar: 'codicon-file-zip',
  '7z': 'codicon-file-zip',
  bz2: 'codicon-file-zip',
  wasm: 'codicon-file-binary',
  bin: 'codicon-file-binary',
  exe: 'codicon-file-binary',
  dll: 'codicon-file-binary',
  so: 'codicon-file-binary',
  dylib: 'codicon-file-binary',
  o: 'codicon-file-binary',
  a: 'codicon-file-binary',
  ipynb: 'codicon-notebook',
  lock: 'codicon-lock',
};

/** Exact basename (lowercased) → full codicon class. */
const BASENAME_ICONS: Record<string, string> = {
  dockerfile: 'codicon-file-code',
  makefile: 'codicon-tools',
  gemfile: 'codicon-ruby',
  rakefile: 'codicon-ruby',
  procfile: 'codicon-terminal',
  license: 'codicon-law',
  licence: 'codicon-law',
  copying: 'codicon-law',
  readme: 'codicon-markdown',
  changelog: 'codicon-markdown',
  authors: 'codicon-file-text',
  contributors: 'codicon-file-text',
  '.env': 'codicon-gear',
  '.env.local': 'codicon-gear',
  '.env.development': 'codicon-gear',
  '.env.production': 'codicon-gear',
  '.gitignore': 'codicon-exclude',
  '.gitattributes': 'codicon-exclude',
  '.editorconfig': 'codicon-gear',
  '.npmrc': 'codicon-gear',
  '.nvmrc': 'codicon-gear',
  '.prettierrc': 'codicon-gear',
  '.eslintrc': 'codicon-gear',
  '.eslintrc.js': 'codicon-file-code',
  '.eslintrc.cjs': 'codicon-file-code',
  '.eslintrc.json': 'codicon-json',
  'cargo.toml': 'codicon-file-code',
  'go.mod': 'codicon-file-code',
  'go.sum': 'codicon-file-code',
  'pyproject.toml': 'codicon-python',
  'requirements.txt': 'codicon-python',
  pipfile: 'codicon-python',
};

function basename(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || name;
}

function extensionOf(fileName: string): string {
  const base = basename(fileName);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Return a full codicon class for a suggestion row / menu glyph.
 * Directories always use folder; files use basename/extension maps or `codicon-file`.
 */
export function fileMentionItemIcon(
  kind: FileMentionIconKind,
  labelOrPath: string,
): string {
  if (kind === 'directory') return 'codicon-folder';

  const base = basename(labelOrPath);
  const lower = base.toLowerCase();

  const byName = BASENAME_ICONS[lower];
  if (byName) return byName;

  const ext = extensionOf(base);
  if (ext) {
    const byExt = EXTENSION_ICONS[ext];
    if (byExt) return byExt;
  }

  return 'codicon-file';
}

/** ThemeIcon id (no `codicon-` prefix) for VS Code Quick Pick / status bar. */
export function fileMentionThemeIconId(
  kind: FileMentionIconKind,
  labelOrPath: string,
): string {
  const cls = fileMentionItemIcon(kind, labelOrPath);
  return cls.startsWith('codicon-') ? cls.slice('codicon-'.length) : cls;
}
