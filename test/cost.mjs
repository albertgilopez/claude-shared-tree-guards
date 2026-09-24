#!/usr/bin/env node
/**
 * cost.mjs — what this plugin costs per Bash tool call, measured rather than assumed.
 *
 * The design said "to be measured, not assumed", and the number decides a design question: if
 * being `solo` costs enough to be felt on every `git` command, the answer is to cache the state
 * per session, not to write a reassuring sentence in the README.
 *
 * Four arms, because the interesting number is not the total but what the GUARD adds:
 *
 *   baseline    node starts and exits              <- the floor nothing can go below
 *   fast-path   a command with no `git commit`     <- what almost every Bash call pays
 *   solo        a commit, nobody else in the tree  <- the gate says nothing to do
 *   shared      a commit, someone else is there    <- the full measurement
 *
 *   node test/cost.mjs [--n 100]
 */
import { spawnSync, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const H = path.join(ROOT, 'plugins', 'shared-tree-guards', 'hooks-handlers');
const nArg = process.argv.indexOf('--n');
const N = nArg >= 0 ? Number(process.argv[nArg + 1]) : 100;

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stg-cost-')));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
for (const f of ['a.md', 'b.md']) fs.writeFileSync(path.join(repo, f), `${f}\n`);
git('add', 'a.md', 'b.md');
git('commit', '-qm', 'base');
fs.writeFileSync(path.join(repo, 'a.md'), 'A2\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'B2\n');
git('add', 'a.md', 'b.md');

const regDir = path.join(repo, '.git', 'claude-sessions');
const payload = (command) => JSON.stringify({
  session_id: 'me', transcript_path: null, cwd: repo,
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
});

function timeIt(label, fn) {
  fn(); // warm up: the first run pays for cold file cache and would skew a small N
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  return { label, ms };
}

const run = (input) => spawnSync(process.execPath, [path.join(H, 'commit-guard.cjs')], {
  cwd: repo, input, encoding: 'utf8',
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'me', CLAUDE_PID: String(process.pid) },
});

const results = [];
results.push(timeIt('baseline (node starts and exits)',
  () => spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' })));
results.push(timeIt('fast path (no `git commit` in the command)',
  () => run(payload('ls -la'))));

// solo: no registry at all
fs.rmSync(regDir, { recursive: true, force: true });
results.push(timeIt('solo (a commit, nobody else here)', () => run(payload('git commit -m "x"'))));

// shared: one live co-tenant, so the guard does the whole job
const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300000)'], { stdio: 'ignore' });
fs.mkdirSync(regDir, { recursive: true });
fs.writeFileSync(path.join(regDir, 'other.json'), JSON.stringify({
  id: 'other', pid: other.pid, transcript: null, cwd: repo, toplevel: repo,
  startedAt: new Date().toISOString(), touchedAt: new Date().toISOString(),
}) + '\n');
results.push(timeIt('shared (a commit, and it blocks)', () => run(payload('git commit -m "x"'))));

// A timing run on code that crashes on line 1 looks like a triumph. It happened here: an
// optimisation introduced a syntax error, every guard died instantly, and this file reported
// the cost falling from 330 ms to 4 ms. So before any number is printed, prove the guard still
// does its job in both states.
const blocked = run(payload('git commit -m "x"'));
fs.rmSync(regDir, { recursive: true, force: true });
const silent = run(payload('git commit -m "x"'));
other.kill();
if (blocked.status !== 2 || !/BLOCKED/.test(blocked.stderr) || silent.status !== 0 || silent.stderr) {
  console.log('the guard is not working, so these timings mean nothing:');
  console.log(`  shared -> exit ${blocked.status}, stderr ${JSON.stringify(blocked.stderr.slice(0, 200))}`);
  console.log(`  solo   -> exit ${silent.status}, stderr ${JSON.stringify(silent.stderr.slice(0, 200))}`);
  process.exit(1);
}

const base = results[0].ms;
console.log(`n = ${N} invocations per arm · ${process.platform} · node ${process.versions.node}\n`);
for (const r of results) {
  const added = r.label.startsWith('baseline') ? '' : `  (+${(r.ms - base).toFixed(1)} ms over baseline)`;
  console.log(`  ${r.label.padEnd(44)} ${r.ms.toFixed(1)} ms${added}`);
}
console.log(`\nrepo: ${repo}`);
console.log(
  '\nRead it as: almost every Bash call pays the fast path, and what the plugin itself adds is\n' +
  'the difference between that and the baseline. Starting a node process dominates; the guard\n' +
  'work (a readdir, or a `git diff --cached`) is the smaller part.'
);
