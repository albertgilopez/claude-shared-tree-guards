/**
 * lib.test.mjs — DR-3 at the library level: outside a repo, and with git absent from PATH,
 * nothing here throws and nothing returns a wrong answer. It returns null.
 *
 * This is the layer where fail-open is decided. If `git()` threw, every caller would need a
 * try/catch and the day one forgot, a guard would block someone because of its OWN error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'plugins', 'shared-tree-guards', 'lib');

const gitlib = require(path.join(LIB, 'git.cjs'));
const sessions = require(path.join(LIB, 'sessions.cjs'));
const payload = require(path.join(LIB, 'payload.cjs'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stg-lib-'));

function withoutGit(fn) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];
  const original = process.env.PATH;
  process.env.PATH = (original || '')
    .split(sep)
    .filter((d) => d && !names.some((n) => fs.existsSync(path.join(d, n))))
    .join(sep);
  try { return fn(); } finally { process.env.PATH = original; }
}

test('git() returns null instead of throwing when the command fails', () => {
  const d = tmp();
  assert.equal(gitlib.git(['rev-parse', '--show-toplevel'], d), null); // not a repo
  assert.equal(gitlib.git(['this-is-not-a-git-subcommand'], d), null);
});

test('git() returns null when git is not on PATH', () => {
  const d = tmp();
  withoutGit(() => {
    assert.equal(gitlib.git(['rev-parse', '--show-toplevel'], d), null);
    assert.equal(gitlib.topLevel(d), null);
    assert.equal(gitlib.gitCommonDir(d), null);
  });
});

test('topLevel() and gitCommonDir() are null outside a repo', () => {
  const d = tmp();
  assert.equal(gitlib.topLevel(d), null);
  assert.equal(gitlib.gitCommonDir(d), null);
});

test('gitCommonDir() is absolute in the MAIN worktree, where git prints a relative path', () => {
  const d = fs.realpathSync(tmp());
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: d });
  const common = gitlib.gitCommonDir(d);
  assert.ok(common && path.isAbsolute(common), `expected an absolute path, got ${common}`);
  assert.ok(fs.existsSync(common), `${common} should exist`);
});

test('sessions.state() is unknown outside a repo, and never throws', () => {
  const d = tmp();
  const res = sessions.state({ cwd: d, session_id: 'x' });
  assert.equal(res.state, 'unknown');
  assert.deepEqual(res.others, []);
});

test('sessions.register() returns null outside a repo instead of throwing', () => {
  const d = tmp();
  assert.equal(sessions.register({ cwd: d, session_id: 'x' }), null);
});

test('pidAlive: this process is alive, an implausible pid is not', () => {
  assert.equal(sessions.pidAlive(process.pid), true);
  assert.equal(sessions.pidAlive(999999), false);
  assert.equal(sessions.pidAlive(0), false);
  assert.equal(sessions.pidAlive(null), false);
});

test('effectiveCwd honours a leading `cd X &&`', () => {
  assert.equal(payload.effectiveCwd('git commit -m x', { cwd: '/repo' }), '/repo');
  assert.equal(payload.effectiveCwd('cd /other && git commit -m x', { cwd: '/repo' }), '/other');
  assert.equal(payload.effectiveCwd('cd "/with space" && git commit -m x', { cwd: '/repo' }), '/with space');
});

test('disabled() honours the env var AND a literal prefix in the command', () => {
  // A hook runs in its own process: it does NOT inherit `VAR=1 some-command`.
  assert.equal(payload.disabled('SHARED_TREE_GUARDS_OFF=1 git commit -m x'), true);
  assert.equal(payload.disabled('git commit -m x'), false);
});

test('a second entry with OUR pid under a different session_id is not a co-tenant', () => {
  // A /clear or /compact can re-fire SessionStart with a new session_id in the SAME process.
  // Counting that as someone else would give `shared` to a solo user for a whole idle window.
  const d = fs.realpathSync(tmp());
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: d });
  const dir = path.join(gitlib.gitCommonDir(d), 'claude-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const entry = (id) => JSON.stringify({
    id, pid: process.pid, transcript: null, cwd: d,
    startedAt: new Date().toISOString(), touchedAt: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(dir, 'me.json'), entry('me'));
  fs.writeFileSync(path.join(dir, 'me-before-clear.json'), entry('me-before-clear'));

  process.env.CLAUDE_PID = String(process.pid);
  const res = sessions.state({ cwd: d, session_id: 'me' });
  assert.equal(res.state, 'solo', 'same process under two ids must not be co-tenancy');
  assert.equal(res.others.length, 0);
});

test('a genuinely different live pid IS a co-tenant', () => {
  const d = fs.realpathSync(tmp());
  const { execFileSync, spawn } = require('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: d });
  const dir = path.join(gitlib.gitCommonDir(d), 'claude-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({
      id: 'other', pid: other.pid, transcript: null, cwd: d,
      startedAt: new Date().toISOString(), touchedAt: new Date().toISOString(),
    }));
    process.env.CLAUDE_PID = String(process.pid);
    const res = sessions.state({ cwd: d, session_id: 'me' });
    assert.equal(res.state, 'shared');
    assert.equal(res.others.length, 1);
  } finally {
    other.kill();
  }
});

test('scope "tree": a session in another worktree of the same clone is NOT an index co-tenant', () => {
  // Measured 2026-09-24: linked worktrees share --git-common-dir (so they share the registry)
  // but have SEPARATE indexes at .git/worktrees/<name>/index. A guard that blocks on clone
  // scope would block every commit in a workspace that opens one worktree per session.
  const { execFileSync, spawn } = require('node:child_process');
  const main = fs.realpathSync(tmp());
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: main });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: main });
  fs.writeFileSync(path.join(main, 'f.md'), 'x\n');
  execFileSync('git', ['add', 'f.md'], { cwd: main });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: main });
  const wt = path.join(main, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: main });

  const dir = path.join(gitlib.gitCommonDir(main), 'claude-sessions');
  fs.mkdirSync(dir, { recursive: true });
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({
      id: 'other', pid: other.pid, transcript: null,
      cwd: main, toplevel: fs.realpathSync(main),
      startedAt: new Date().toISOString(), touchedAt: new Date().toISOString(),
    }));
    process.env.CLAUDE_PID = String(process.pid);
    const asWorktree = { cwd: fs.realpathSync(wt), session_id: 'me' };

    assert.equal(sessions.state(asWorktree, Date.now(), { scope: 'clone' }).state, 'shared',
      'clone scope must still see them: they share refs and the object store');
    assert.equal(sessions.state(asWorktree, Date.now(), { scope: 'tree' }).state, 'solo',
      'tree scope must not: separate index, separate working tree');
  } finally {
    other.kill();
  }
});
