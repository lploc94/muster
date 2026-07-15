import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSkillNames } from './skill-discovery';

const tempDirs: string[] = [];

function makeTree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-skill-'));
  tempDirs.push(dir);
  return dir;
}

/** Create `<root>/<rel>/SKILL.md` (a valid skill dir). */
function skill(root: string, rel: string): void {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# skill\n');
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('discoverSkillNames', () => {
  it('lists workspace + user .claude/skills for claude (deduped, sorted)', () => {
    const cwd = makeTree();
    const home = makeTree();
    skill(cwd, '.claude/skills/review');
    skill(cwd, '.claude/skills/plan');
    skill(home, '.claude/skills/plan'); // dup across roots
    skill(home, '.claude/skills/deploy');
    expect(discoverSkillNames('claude', cwd, home)).toEqual(['deploy', 'plan', 'review']);
  });

  it('requires a SKILL.md — a bare directory is not a skill', () => {
    const cwd = makeTree();
    skill(cwd, '.claude/skills/real');
    fs.mkdirSync(path.join(cwd, '.claude/skills/empty'), { recursive: true });
    expect(discoverSkillNames('claude', cwd, undefined)).toEqual(['real']);
  });

  it('skips non-directory entries (e.g. .DS_Store) and names failing SKILL_NAME_RE', () => {
    const cwd = makeTree();
    skill(cwd, '.claude/skills/ok');
    fs.writeFileSync(path.join(cwd, '.claude/skills/.DS_Store'), 'junk');
    skill(cwd, '.claude/skills/has space'); // invalid name → rejected
    expect(discoverSkillNames('claude', cwd, undefined)).toEqual(['ok']);
  });

  it('uses .codex/skills (+ .agents/skills) for codex', () => {
    const cwd = makeTree();
    skill(cwd, '.codex/skills/refactor');
    skill(cwd, '.agents/skills/shared');
    skill(cwd, '.claude/skills/ignored'); // claude dir must not leak into codex
    expect(discoverSkillNames('codex', cwd, undefined)).toEqual(['refactor', 'shared']);
  });

  it('scans codex user dirs (.codex/skills and .agents/skills under $HOME)', () => {
    const home = makeTree();
    skill(home, '.codex/skills/userfix');
    skill(home, '.agents/skills/usershared');
    expect(discoverSkillNames('codex', undefined, home)).toEqual(['userfix', 'usershared']);
  });

  it('returns [] for an unknown backend', () => {
    const cwd = makeTree();
    skill(cwd, '.claude/skills/x');
    expect(discoverSkillNames('mystery', cwd, undefined)).toEqual([]);
  });

  it('rejects inherited-property backend names (no prototype pollution)', () => {
    const cwd = makeTree();
    skill(cwd, '.claude/skills/x');
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(discoverSkillNames(bad, cwd, undefined)).toEqual([]);
    }
  });

  it('returns [] and never throws when directories are missing', () => {
    expect(discoverSkillNames('claude', '/no/such/dir', '/also/missing')).toEqual([]);
    expect(discoverSkillNames('claude', undefined, undefined)).toEqual([]);
  });
});
