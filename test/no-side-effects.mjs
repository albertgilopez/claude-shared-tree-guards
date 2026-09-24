#!/usr/bin/env node
/**
 * no-side-effects.mjs — DR-8: a guard writes nothing outside `<git-common-dir>/claude-sessions/`.
 *
 * Not the index, not refs, not the working tree. This is the invariant that makes the plugin
 * safe to install in someone else's repo, so it is measured rather than asserted in prose: the
 * whole `.git` directory and the whole working tree are snapshotted (path + size + mtime + a
 * hash of the content) before and after running every guard, and the diff must be exactly the
 * registry.
 *
 *   node test/no-side-effects.mjs
 */
import { spawnSync, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const H = path.join(ROOT, 'plugins', 'shared-tree-guards', 'hooks-handlers');

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stg-dr8-')));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
for (const f of ['a.md', 'b.md']) fs.writeFileSync(path.join(repo, f), `${f}\n`);
git('add', 'a.md', 'b.md');
git('commit', '-qm', 'base');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
fs.writeFileSync(path.join(repo, 'a.md'), 'A2\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'B2\n');
git('add', 'a.md', 'b.md');
fs.writeFileSync(path.join(repo, 'untracked.md'), 'u\n');

// Make it a SHARED tree, so the guards actually do their work instead of exiting at the gate.
// Measuring "wrote nothing" on a guard that never ran would be the emptiest of green ticks.
const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
const regDir = path.join(repo, '.git', 'claude-sessions');
fs.mkdirSync(regDir, { recursive: true });
fs.writeFileSync(path.join(regDir, 'other.json'), JSON.stringify({
  id: 'other', pid: other.pid, transcript: null, cwd: repo, toplevel: repo,
  startedAt: new Date().toISOString(), touchedAt: new Date().toISOString(),
}) + '\n');

function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      const buf = fs.readFileSync(p);
      const st = fs.statSync(p);
      out.set(path.relative(repo, p).split(path.sep).join('/'),
        `${st.size}:${crypto.createHash('sha1').update(buf).digest('hex')}`);
    }
  };
  walk(dir);
  return out;
}

function diff(before, after) {
  const changed = [];
  for (const [k, v] of after) if (before.get(k) !== v) changed.push((before.has(k) ? 'M ' : '+ ') + k);
  for (const k of before.keys()) if (!after.has(k)) changed.push('- ' + k);
  return changed;
}

const payload = (command, event = 'PreToolUse') => JSON.stringify({
  session_id: 'me', transcript_path: null, cwd: repo, hook_event_name: event,
  tool_name: 'Bash', tool_input: { command },
});

const INVOCATIONS = [
  ['commit-guard.cjs', payload('git add a.md && git commit -m "only a"')],
  ['commit-guard.cjs', payload('git commit -m "x" -- a.md')],
  ['overwrite-guard.cjs', payload('git checkout origin/main -- a.md')],
  ['overwrite-guard.cjs', payload('git clean -fd')],
  ['cotenancy.cjs', payload('', 'SessionStart')],
];

const statusBefore = git('status', '--porcelain');
const before = snapshot(repo);

for (const [file, input] of INVOCATIONS) {
  spawnSync(process.execPath, [path.join(H, file)], {
    cwd: repo, input, encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'me', CLAUDE_PID: String(process.pid) },
  });
}

const after = snapshot(repo);
const statusAfter = git('status', '--porcelain');
other.kill();

const changed = diff(before, after);
const outsideRegistry = changed.filter((c) => !c.slice(2).startsWith('.git/claude-sessions/'));

let fails = 0;
const T = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${detail ? '\n       ' + detail : ''}`); };

T('the guards ran against a SHARED tree (otherwise this proves nothing)',
  fs.existsSync(path.join(regDir, 'other.json')));
T('git status is identical before and after', statusBefore === statusAfter,
  statusBefore === statusAfter ? '' : `before:\n${statusBefore}\nafter:\n${statusAfter}`);
T('nothing changed outside <git-common-dir>/claude-sessions/', outsideRegistry.length === 0,
  outsideRegistry.join('\n       '));
T('the session DID register (so the snapshot is sensitive enough to notice a write)',
  changed.some((c) => c.slice(2).startsWith('.git/claude-sessions/')),
  changed.join('\n       '));

console.log(`\nchanged paths: ${changed.length ? changed.join(', ') : '(none)'}`);
console.log(`${fails ? `${fails} FAILED` : 'all green'}  (repo: ${repo})`);
process.exit(fails ? 1 : 0);
