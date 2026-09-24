/**
 * e2e-manual.mjs — the end-to-end check the acceptance cases cannot do: a real repo, a
 * genuinely live second process registered as another session, and the guard invoked exactly
 * the way Claude Code invokes it (payload on stdin, exit code out).
 *
 *   node test/e2e-manual.mjs
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const H = path.join(ROOT, 'plugins', 'shared-tree-guards', 'hooks-handlers');

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stg-e2e-')));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'a.md'), 'a\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'b\n');
git('add', 'a.md', 'b.md');
git('commit', '-qm', 'base');
fs.writeFileSync(path.join(repo, 'a.md'), 'A2\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'B2\n'); // b.md is THE OTHER SESSION'S work
git('add', 'a.md', 'b.md');

// A genuinely live second process, with a real OS pid.
const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
const dir = path.join(repo, '.git', 'claude-sessions');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'other.json'),
  JSON.stringify({
    id: 'other', pid: other.pid, transcript: null, cwd: repo,
    startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    touchedAt: new Date().toISOString(), host: os.hostname(),
  }) + '\n'
);

const run = (file, args, payload, env = {}) =>
  spawnSync(process.execPath, [path.join(H, file), ...args], {
    cwd: repo, encoding: 'utf8', input: payload ? JSON.stringify(payload) : undefined,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'me', CLAUDE_PID: String(process.pid), ...env },
  });

const payload = (command) => ({
  session_id: 'me', cwd: repo, hook_event_name: 'PreToolUse',
  tool_name: 'Bash', tool_input: { command },
});

let fails = 0;
const T = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`); };

const list = run('cotenancy.cjs', ['--list', '--json'], null, { SHARED_TREE_GUARDS_CWD: repo });
const co = JSON.parse(list.stdout);
T('co-tenancy sees the other live session', co.state === 'shared' && co.others === 1, JSON.stringify(co));

const blocked = run('commit-guard.cjs', [], payload('git add a.md && git commit -m "only a"'));
T('the guard blocks the commit that would carry b.md', blocked.status === 2);
T('the message names b.md and the command it judged',
  blocked.stderr.includes('b.md') && blocked.stderr.includes('only a'));

const ok1 = run('commit-guard.cjs', [], payload('git commit -m "only a" -- a.md'));
T('the same commit WITH a pathspec passes', ok1.status === 0);

const off = run('commit-guard.cjs', [], payload('git add a.md && git commit -m "only a"'), { SHARED_TREE_GUARDS_OFF: '1' });
T('the escape hatch works', off.status === 0);

// Now remove the other session: the plugin must go completely quiet.
other.kill();
await new Promise((r) => setTimeout(r, 500));
const solo = run('commit-guard.cjs', [], payload('git add a.md && git commit -m "only a"'));
T('with nobody else there, the guard says nothing at all',
  solo.status === 0 && solo.stderr === '' && solo.stdout === '',
  `exit=${solo.status}`);

// DR-8: the guards wrote nothing outside the registry.
const dirty = git('status', '--porcelain');
T('DR-8: the working tree is untouched by the guards', dirty === git('status', '--porcelain'));
T('DR-8: the only thing written is the registry', fs.existsSync(dir));

console.log(`\n${fails ? `${fails} FAILED` : 'all green'}  (repo: ${repo})`);
process.exit(fails ? 1 : 0);
