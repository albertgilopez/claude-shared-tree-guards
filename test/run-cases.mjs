#!/usr/bin/env node
/**
 * run-cases.mjs — runs cases.yaml against the REAL hook handlers, in REAL temporary git
 * repositories, as REAL child processes. No mocks of git, no mocks of the hook protocol.
 *
 * The co-tenancy fixture is the part that matters: by default every case registers one other
 * live session in the repo's registry (a real entry, with a real live pid), because the guards
 * are deliberately silent when you are alone. A case can ask for `live_sessions: 0` to assert
 * exactly that silence (AC-16).
 *
 *   node test/run-cases.mjs                # all
 *   node test/run-cases.mjs --only AC-01,AC-16
 *   node test/run-cases.mjs --verbose
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// STG_HANDLERS_DIR lets negative-control.mjs point the bench at a MUTATED copy of the plugin
// without ever touching the real one. A negative control that edits the tree it is testing is
// one crash away from leaving a broken guard behind.
const HANDLERS = process.env.STG_HANDLERS_DIR || path.join(ROOT, 'plugins', 'shared-tree-guards', 'hooks-handlers');
const CASES = path.join(ROOT, 'cases.yaml');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const onlyArg = argv.indexOf('--only');
const ONLY = onlyArg >= 0 ? new Set(String(argv[onlyArg + 1] || '').split(',').map((s) => s.trim())) : null;

const HANDLER_FILE = {
  'commit-guard': 'commit-guard.cjs',
  'overwrite-guard': 'overwrite-guard.cjs',
  cotenancy: 'cotenancy.cjs',
};

// ---------------------------------------------------------------- fixtures
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-'));
  if (spec.git === false) return dir; // AC-12: a directory that is NOT a repo
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);

  const write = (p, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  };

  // A base commit so HEAD exists (deletions need something to delete from).
  write('.keep', 'base\n');
  git(['add', '.keep'], dir);
  git(['commit', '-qm', 'base'], dir);

  for (const p of spec.staged || []) {
    write(p, `content of ${p}\n`);
    git(['add', '--', p], dir);
  }

  // A staged deletion of a file that IS still on disk: exactly what a stale index looks like.
  for (const p of spec.staged_deletions_of_present_files || []) {
    write(p, `content of ${p}\n`);
    git(['add', '--', p], dir);
    git(['commit', '-qm', `add ${p}`], dir);
    git(['rm', '--cached', '-q', '--', p], dir); // index says deleted, disk says present
  }

  // A real deletion: committed, then removed from both index and disk.
  for (const p of spec.staged_deletions_of_absent_files || []) {
    write(p, `content of ${p}\n`);
    git(['add', '--', p], dir);
    git(['commit', '-qm', `add ${p}`], dir);
    git(['rm', '-q', '--', p], dir);
  }

  for (const p of spec.modified_uncommitted || []) {
    write(p, `content of ${p}\n`);
    git(['add', '--', p], dir);
    git(['commit', '-qm', `add ${p}`], dir);
    write(p, `MODIFIED ${p}\n`); // tracked, dirty, not staged
  }

  for (const p of spec.clean || []) {
    write(p, `content of ${p}\n`);
    git(['add', '--', p], dir);
    git(['commit', '-qm', `add ${p}`], dir);
  }

  // Some cases reference origin/main. Give them a real one.
  if ((spec.modified_uncommitted || []).length || (spec.clean || []).length) {
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], dir);
  }
  return dir;
}

function registryDirOf(repo) {
  const common = git(['rev-parse', '--git-common-dir'], repo).trim();
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  return path.join(abs, 'claude-sessions');
}

const SELF_ID = 'the-session-under-test';

// A pid that cannot exist. 999999 is a real, reachable pid on Linux (pid_max goes to 4194304).
const DEAD_PID = 2 ** 31 - 1;

// One long-lived child, reaped at exit, standing in for "another session's process".
let _other = null;
function otherPid() {
  if (!_other) {
    _other = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' });
    process.on('exit', () => { try { _other.kill(); } catch {} });
  }
  return _other.pid;
}

/**
 * Plant `n` live sessions IN TOTAL, the first of which is the session under test itself —
 * so `live_sessions: 2` means "two sessions in this clone, one of them me", i.e. 1 other.
 *
 * The OTHERS get a genuinely different live pid (a spawned child), not this process's pid:
 * `state()` dedupes co-tenants by pid as well as by id, so reusing our own pid would make
 * every planted "other" collapse into us and the whole bench would silently go green for the
 * wrong reason. Measured: doing that took 16 pass/0 fail to 12 pass/4 fail.
 */
function plantSessions(repo, n, opts = {}) {
  if (!n) return;
  const dir = registryDirOf(repo);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const id = opts.includeSelf && i === 0 ? SELF_ID : `other-session-${i}`;
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        pid: opts.dead ? DEAD_PID : id === SELF_ID ? process.pid : otherPid(),
        transcript: null,
        cwd: repo,
        toplevel: opts.otherToplevel && id !== SELF_ID ? opts.otherToplevel : repo,
        ...(opts.recentSubagent && id === SELF_ID ? { lastSubagentAt: new Date().toISOString() } : {}),
        startedAt: new Date(Date.now() - 3600_000).toISOString(),
        touchedAt: new Date().toISOString(),
        host: os.hostname(),
      }) + '\n'
    );
  }
}

// ---------------------------------------------------------------- running a case
function runHandler(guard, repo, input, env, runFrom) {
  const file = path.join(HANDLERS, HANDLER_FILE[guard]);
  if (!fs.existsSync(file)) return { skipped: `handler ${guard} not implemented yet` };

  if (input.mode === 'list') {
    const args = [file, '--list', '--json'];
    if (input.scope) args.push('--scope', input.scope);
    const r = spawnSync(process.execPath, args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env, SHARED_TREE_GUARDS_CWD: runFrom || repo, CLAUDE_CODE_SESSION_ID: SELF_ID },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  const payload = {
    session_id: SELF_ID,
    transcript_path: null,
    cwd: runFrom || repo,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: input.command },
    // A Bash call made by a subagent carries these; a main-session call does not. Measured.
    ...(input.agent_id ? { agent_id: input.agent_id, agent_type: input.agent_type || 'general-purpose' } : {}),
  };
  const r = spawnSync(process.execPath, [file], {
    cwd: runFrom || repo,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env, CLAUDE_CODE_SESSION_ID: SELF_ID, CLAUDE_PID: String(process.pid) },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Rebuild PATH without any directory containing a git executable (AC-14). */
function pathWithoutGit() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];
  const kept = (process.env.PATH || '')
    .split(sep)
    .filter((d) => d && !names.some((n) => fs.existsSync(path.join(d, n))));
  return kept.join(sep);
}

function check(c, res) {
  const want = c.expected || {};
  const fails = [];
  if (want.exit !== undefined && res.status !== want.exit) fails.push(`exit ${res.status}, expected ${want.exit}`);
  if (want.stderr === '' && (res.stderr || '').trim() !== '') fails.push(`stderr not empty: ${res.stderr.trim().slice(0, 120)}`);
  if (want.stdout === '' && (res.stdout || '').trim() !== '') fails.push(`stdout not empty: ${res.stdout.trim().slice(0, 120)}`);
  for (const m of want.mentions || []) {
    if (!(res.stderr + res.stdout).includes(m)) fails.push(`message does not mention "${m}"`);
  }
  if (want.stderr_contains && !res.stderr.includes(want.stderr_contains)) {
    fails.push(`stderr does not contain "${want.stderr_contains}"`);
  }
  if (want.state !== undefined || want.others !== undefined) {
    let j = {};
    try { j = JSON.parse(res.stdout); } catch { fails.push(`stdout is not JSON: ${res.stdout.slice(0, 80)}`); }
    if (want.state !== undefined && j.state !== want.state) fails.push(`state ${j.state}, expected ${want.state}`);
    if (want.others !== undefined && j.others !== want.others) fails.push(`others ${j.others}, expected ${want.others}`);
  }
  return fails;
}

// ---------------------------------------------------------------- main
const cases = parseYaml(fs.readFileSync(CASES, 'utf8')).filter((c) => !ONLY || ONLY.has(c.id));
let pass = 0, fail = 0, skip = 0;

for (const c of cases) {
  const guards = c.guard === 'all' ? Object.keys(HANDLER_FILE) : [c.guard];
  for (const guard of guards) {
    const spec = c.repo || {};
    const repo = makeRepo(spec);

    // Co-tenancy fixture. Default: one other live session, so the guards are ON.
    if (spec.git !== false) {
      if (spec.live_sessions !== undefined) plantSessions(repo, spec.live_sessions, { includeSelf: true, otherToplevel: fs.realpathSync(repo), recentSubagent: spec.recent_subagent });
      else if (spec.dead_sessions !== undefined) plantSessions(repo, spec.dead_sessions, { dead: true });
      else plantSessions(repo, 1);
    }

    // A linked worktree of the SAME clone: shares the registry, has its OWN index.
    // The session under test lives in the worktree; the planted co-tenant sits in the main
    // tree with its own staged work. That is the shape the guards must not confuse.
    let runFrom = null;
    if (spec.self_in_linked_worktree) {
      const wt = path.join(repo, 'wt');
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: repo, stdio: 'ignore' });
      runFrom = fs.realpathSync(wt);
      for (const f of spec.staged_in_worktree || []) {
        fs.writeFileSync(path.join(runFrom, f), `content of ${f}
`);
        execFileSync('git', ['add', '--', f], { cwd: runFrom });
      }
    }

    const env = { ...(c.env || {}) };
    if (spec.git_on_path === false) env.PATH = pathWithoutGit();

    const res = runHandler(guard, repo, c.input || {}, env, runFrom);
    if (res.skipped) {
      skip++;
      console.log(`SKIP ${c.id} [${guard}] — ${res.skipped}`);
      continue;
    }
    const fails = check(c, res);
    if (fails.length === 0) {
      pass++;
      console.log(`ok   ${c.id} [${guard}]`);
      if (VERBOSE) console.log(`       exit=${res.status} stderr=${JSON.stringify(res.stderr.slice(0, 200))}`);
    } else {
      fail++;
      console.log(`FAIL ${c.id} [${guard}]`);
      for (const f of fails) console.log(`       ${f}`);
      if (VERBOSE) console.log(`       repo=${repo}`);
    }
  }
}

console.log(`\n${pass} pass · ${fail} fail · ${skip} skip`);
process.exit(fail ? 1 : 0);
