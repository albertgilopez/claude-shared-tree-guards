#!/usr/bin/env node
/**
 * e2e-subagent.mjs — the measurement behind D-14, end to end.
 *
 * A subagent runs inside its parent session: same `session_id`, same `CLAUDE_PID`. No registry
 * can tell them apart, and for a while this plugin therefore stayed silent for exactly the
 * situation people hit most — several subagents working in one tree, through one index.
 *
 * What makes it solvable is that a Bash call made by a subagent DOES reach `PreToolUse`, and its
 * payload carries `agent_id` / `agent_type`, which a main-session call does not. So co-tenancy is
 * demonstrated by the payload itself.
 *
 * This drives a real `claude -p` that spawns a real subagent and asks it to make the dangerous
 * commit. It requires the plugin to be INSTALLED (and up to date):
 *
 *   claude plugin update shared-tree-guards
 *   node test/e2e-subagent.mjs
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stg-sub-')));
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'a.md'), 'a\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'b\n');
git('add', 'a.md', 'b.md');
git('commit', '-qm', 'base');
const baseCommits = git('rev-list', '--count', 'HEAD').trim();

// b.md is staged by "someone else in this session" before the subagent is asked to commit.
fs.writeFileSync(path.join(repo, 'a.md'), 'A2\n');
fs.writeFileSync(path.join(repo, 'b.md'), 'B2\n');
git('add', 'a.md', 'b.md');

// NO other session is planted. That is the point: the only co-tenancy here is the subagent.
const prompt =
  'Use the Agent tool to launch ONE general-purpose subagent. Its only job is to run this bash ' +
  'command in the current directory, exactly as written: git add a.md && git commit -m "only a". ' +
  'Then report back literally what happened, including any hook message, quoted verbatim. ' +
  'If no hook message reached the subagent at all, your answer must contain the exact token ' +
  'NO-HOOK-MESSAGE.';

console.log(`repo: ${repo}\nasking a real subagent to make the dangerous commit...\n`);
const CLAUDE = process.env.CLAUDE_CODE_EXECPATH || 'claude';
const r = spawnSync(CLAUDE, ['-p', prompt, '--allowedTools', 'Bash,Agent'], {
  cwd: repo, encoding: 'utf8', timeout: 300000,
});

// The model's answer only. Claude Code echoes hook stderr to its own stderr, so reading both
// would make this check unable to fail — which is how the WARN measurement lied once already.
const said = r.stdout || '';
console.log('--- what the model reported (stdout only) ---');
console.log(said.trim().slice(0, 1800));
console.log('--------------------------------------------');

const after = git('rev-list', '--count', 'HEAD').trim();
let fails = 0;
const T = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`); };

T('the block reached the subagent', /BLOCKED/.test(said) && !/NO-HOOK-MESSAGE/.test(said));
T('the message says it was a SUBAGENT', /SUBAGENT/.test(said));
T('it named the file it judged', /b\.md/.test(said));
T('no commit was created', after === baseCommits, `commits ${baseCommits} -> ${after}`);

console.log(`\n${fails ? `${fails} FAILED` : 'all green'}  (repo: ${repo})`);
process.exit(fails ? 1 : 0);
