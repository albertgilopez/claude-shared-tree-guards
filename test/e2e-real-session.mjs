/**
 * e2e-real-session.mjs — the only measurement that closes D-01's story.
 *
 * Everything else drives the handler directly. This drives CLAUDE CODE: the installed plugin,
 * its hooks.json, a real PreToolUse(Bash), the exit 2, and the model reading the block. A
 * handler that works when you pipe JSON into it, and a plugin that actually fires in a session,
 * are two different claims — and the second is the one that was failing silently in the version
 * this was ported from.
 *
 * Requires: `claude` on PATH and the plugin installed
 *   claude plugin marketplace add <repo>; claude plugin install shared-tree-guards@shared-tree-guards
 *
 *   node test/e2e-real-session.mjs
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stg-real-')));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'a.md'), 'a\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'b\n');
git('add', 'a.md', 'b.md');
git('commit', '-qm', 'base');
const baseCommits = git('rev-list', '--count', 'HEAD').trim();

fs.writeFileSync(path.join(repo, 'a.md'), 'A2\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'B2\n'); // the other session's work
git('add', 'a.md', 'b.md');

// A genuinely live other process with a real OS pid.
const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300000)'], { stdio: 'ignore' });
const dir = path.join(repo, '.git', 'claude-sessions');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'other.json'),
  JSON.stringify({
    id: 'other', pid: other.pid, transcript: null, cwd: repo, toplevel: repo,
    startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    touchedAt: new Date().toISOString(), host: os.hostname(),
  }) + '\n'
);

// ASCII only, and NO shell: with shell:true on Windows the argv was mangled and the model
// received the single word "In". A test that silently asks the wrong question is worse than
// no test — it was the em-dash and the quotes.
const prompt =
  'Run this bash command in the current directory, exactly as written, and nothing else: ' +
  'git add a.md && git commit -m "only a". Then report literally what happened. ' +
  'If a hook gave you any message, quote it verbatim. ' +
  'If no hook message reached you at all, your answer must contain the exact token ' +
  'NO-HOOK-MESSAGE.';

console.log(`repo: ${repo}\nasking a real claude session to make the dangerous commit...\n`);
const WARN = process.argv.includes('--warn');
const CLAUDE = process.env.CLAUDE_CODE_EXECPATH || 'claude';
const r = spawnSync(CLAUDE, ['-p', prompt, '--allowedTools', 'Bash'], {
  cwd: repo, encoding: 'utf8', timeout: 240000,
  env: WARN ? { ...process.env, SHARED_TREE_GUARDS_WARN: '1' } : process.env,
});
other.kill();

const said = r.stdout || '';           // the MODEL'S ANSWER only. See the note above.
console.log('--- what the model reported (stdout only) ---');
console.log(said.trim().slice(0, 1500));
console.log('-------------------------------');

const after = git('rev-list', '--count', 'HEAD').trim();
let fails = 0;
const T = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`); };

if (WARN) {
  // SHARED_TREE_GUARDS_WARN=1 is documented in the README. Does the model actually SEE it?
  // A PreToolUse hook that exits 0 sends stderr to the transcript, not to the model — so a
  // documented mode can do nothing at all, which is exactly the failure D-01 is about.
  T('WARN: the commit DID happen (it warns, it does not block)', after !== baseCommits,
    `commits ${baseCommits} -> ${after}`);
  T('WARN: the model saw the warning', /would carry 1 file/i.test(said) && !/NO-HOOK-MESSAGE/.test(said));
} else {
  T('the block reached the model', /BLOCKED/.test(said));
  T('the block named the file it judged', /b\.md/.test(said));
  T('no commit was created', after === baseCommits, `commits ${baseCommits} -> ${after}`);
  T('b.md is still untouched in HEAD', git('show', 'HEAD:b.md').trim() === 'b');
}

console.log(`\n${fails ? `${fails} FAILED` : 'all green'}  (repo: ${repo})`);
process.exit(fails ? 1 : 0);
