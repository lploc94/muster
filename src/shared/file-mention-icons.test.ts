import { describe, expect, it } from 'vitest';
import { fileMentionItemIcon, fileMentionThemeIconId } from './file-mention-icons';

describe('fileMentionItemIcon', () => {
  it('uses folder icon for directories regardless of name', () => {
    expect(fileMentionItemIcon('directory', 'src')).toBe('codicon-folder');
    expect(fileMentionItemIcon('directory', 'app.ts')).toBe('codicon-folder');
  });

  it('uses generic file icon for unknown extensions', () => {
    expect(fileMentionItemIcon('file', 'notes.xyz')).toBe('codicon-file');
    expect(fileMentionItemIcon('file', 'Makefile.bak')).toBe('codicon-file');
  });

  it('maps common source extensions', () => {
    expect(fileMentionItemIcon('file', 'app.ts')).toBe('codicon-file-code');
    expect(fileMentionItemIcon('file', 'App.tsx')).toBe('codicon-file-code');
    expect(fileMentionItemIcon('file', 'index.js')).toBe('codicon-file-code');
    expect(fileMentionItemIcon('file', 'main.py')).toBe('codicon-python');
    expect(fileMentionItemIcon('file', 'Gemfile.rb')).toBe('codicon-ruby');
  });

  it('maps config, docs, media, and archive extensions', () => {
    expect(fileMentionItemIcon('file', 'package.json')).toBe('codicon-json');
    expect(fileMentionItemIcon('file', 'README.md')).toBe('codicon-markdown');
    expect(fileMentionItemIcon('file', 'notes.txt')).toBe('codicon-file-text');
    expect(fileMentionItemIcon('file', 'schema.sql')).toBe('codicon-database');
    expect(fileMentionItemIcon('file', 'logo.png')).toBe('codicon-file-media');
    expect(fileMentionItemIcon('file', 'spec.pdf')).toBe('codicon-file-pdf');
    expect(fileMentionItemIcon('file', 'dist.zip')).toBe('codicon-file-zip');
    expect(fileMentionItemIcon('file', 'run.sh')).toBe('codicon-terminal');
  });

  it('maps well-known basenames', () => {
    expect(fileMentionItemIcon('file', 'Dockerfile')).toBe('codicon-file-code');
    expect(fileMentionItemIcon('file', 'LICENSE')).toBe('codicon-law');
    expect(fileMentionItemIcon('file', 'README')).toBe('codicon-markdown');
    expect(fileMentionItemIcon('file', '.gitignore')).toBe('codicon-exclude');
    expect(fileMentionItemIcon('file', '.env')).toBe('codicon-gear');
  });

  it('uses only the basename when given a relative path', () => {
    expect(fileMentionItemIcon('file', 'src/lib/util.ts')).toBe('codicon-file-code');
    expect(fileMentionItemIcon('file', '../../package.json')).toBe('codicon-json');
  });

  it('exposes ThemeIcon ids without the codicon- prefix', () => {
    expect(fileMentionThemeIconId('directory', 'src')).toBe('folder');
    expect(fileMentionThemeIconId('file', 'app.ts')).toBe('file-code');
    expect(fileMentionThemeIconId('file', 'notes.xyz')).toBe('file');
  });
});
