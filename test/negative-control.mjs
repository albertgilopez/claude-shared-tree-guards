#!/usr/bin/env node
/**
 * negative-control.mjs — the suite that makes the green one mean something.
 *
 * For each guard it applies a mutation that SHOULD break it, runs the acceptance bench against
 * the mutated copy, and asserts the bench goes red. If a mutation passes, the bench is not
 * testing what it claims to test.
 *
 * This is not paranoia, it is the history of this code. Three separate times in one day a
 * measurement here said green for the wrong reason:
 *
 *   - the ported gate tests ran with real git wired in, so every failure fell through to
 *     fail-open and 3 of 6 proved nothing;
 *   - the WARN check read the child process's stderr, which Claude Code echoes, so it passed
 *     with the warning wired to a channel the model never sees;
 *   - the bench planted co-tenants with its own pid, which after the pid-dedupe change made
 *     every planted "other" collapse into the session under test.
 *
 * Each mutation below is one of those shapes, frozen.
 *
 * It never touches the real plugin: it copies the handlers and lib into a temp directory,
 * mutates the copy, and points the bench at it with STG_HANDLERS_DIR.
 *
 *   node test/negative-control.mjs            # all
 *   node test/negative-control.mjs --verbose
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'shared-tree-guards');
const HANDLERS = path.join(PLUGIN, 'hooks-handlers');
const VERBOSE = process.argv.includes('--verbose');

/**
 * Each mutation names the file, the exact source it replaces, what it breaks, and which cases
 * must notice. `mustFail` is the point: a mutation nobody notices is a hole in the bench.
 */
const MUTATIONS = [
  {
    name: 'commit-guard cannot block at all',
    file: 'hooks-handlers/commit-guard.cjs',
    from: 'const verdict = evaluate(cmd, root, fs, null, co);',
    to: 'const verdict = null;',
    breaks: 'the gate itself',
    mustFail: ['AC-01', 'AC-02', 'AC-06', 'AC-15'],
  },
  {
    name: 'commit-guard ignores the co-tenancy gate',
    file: 'hooks-handlers/commit-guard.cjs',
    from: "    if (co.state !== 'shared') process.exit(0);",
    to: '    // gate removed',
    breaks: 'the silence that makes this publishable',
    mustFail: ['AC-16'],
  },
  {
    name: 'commit-guard treats " -- " inside a message as a pathspec',
    file: 'hooks-handlers/commit-guard.cjs',
    from: '  let q = null;',
    to: '  let q = null; if (after.includes(" -- ")) return true;',
    breaks: 'the false negative that grants permission silently',
    mustFail: ['AC-02'],
  },
  {
    name: 'overwrite-guard cannot block at all',
    file: 'hooks-handlers/overwrite-guard.cjs',
    from: '    const res = analyze(cmd, cwd);',
    to: '    const res = null;',
    breaks: 'the gate itself',
    mustFail: ['AC-08'],
  },
  {
    name: 'overwrite-guard ignores the co-tenancy gate',
    file: 'hooks-handlers/overwrite-guard.cjs',
    from: "    if (co.state !== 'shared') process.exit(0);",
    to: '    // gate removed',
    breaks: 'the silence that makes this publishable',
    mustFail: ['AC-19'],
  },
  {
    name: 'subagent calls are not recognised as co-tenancy',
    file: 'lib/sessions.cjs',
    from: '  if (payload.agent_id) {',
    to: '  if (false && payload.agent_id) {',
    breaks: 'D-14: a subagent shares its session index and no registry can see it',
    mustFail: ['AC-21', 'AC-23'],
  },
  {
    name: 'the main session forgets its own subagent acted',
    file: 'lib/sessions.cjs',
    from: '  const lastSub = mine && Date.parse(mine.lastSubagentAt || 0);',
    to: '  const lastSub = 0;',
    breaks: 'the other direction of D-14: the session sweeping up its subagent work',
    mustFail: ['AC-22'],
  },
  {
    name: 'liveness says every registered session is alive',
    file: 'lib/sessions.cjs',
    from: '  if (!Number.isInteger(pid) || pid <= 0) return false;',
    to: '  return true;',
    breaks: 'DR-7: a dead entry must be debris, not a co-tenant',
    mustFail: ['AC-11'],
  },
  {
    name: 'guards scope co-tenancy to the clone instead of the working tree',
    file: 'hooks-handlers/commit-guard.cjs',
    from: "sessions.state({ ...payload, cwd }, Date.now(), { scope: 'tree' })",
    to: "sessions.state({ ...payload, cwd }, Date.now(), { scope: 'clone' })",
    breaks: 'D-07: a linked worktree has its own index',
    mustFail: ['AC-20'],   // added because THIS suite showed nothing covered it
  },
];

function mutantDir(mut) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-mut-'));
  fs.cpSync(PLUGIN, dir, { recursive: true });
  const target = path.join(dir, mut.file);
  const src = fs.readFileSync(target, 'utf8');
  if (!src.includes(mut.from)) {
    throw new Error(`mutation "${mut.name}": source not found in ${mut.file}\n  looked for: ${mut.from}`);
  }
  fs.writeFileSync(target, src.replace(mut.from, mut.to));
  return path.join(dir, 'hooks-handlers');
}

function runBench(handlersDir) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'run-cases.mjs')], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, STG_HANDLERS_DIR: handlersDir },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /(\d+) pass · (\d+) fail · (\d+) skip/.exec(out);
  const failed = [...out.matchAll(/^FAIL (AC-\d+)/gm)].map((x) => x[1]);
  return { ok: r.status === 0, summary: m ? m[0] : '(no summary)', failed, out };
}

// The unmutated bench must be green, or everything below measures the wrong thing.
//
// "exit 0" is NOT a sufficient baseline, and that was the first thing this suite caught about
// ITSELF: pointed at the wrong directory it reported `0 pass · 0 fail · 21 skip`, exited 0, and
// then declared every mutation an uncaught hole. A run where nothing ran is not a green run.
const baseline = runBench(HANDLERS);
const counts = (/(\d+) pass · (\d+) fail · (\d+) skip/.exec(baseline.summary) || []).map(Number);
const [, passN, failN, skipN] = counts;
if (!baseline.ok || !passN || failN || skipN) {
  console.log(`the bench is not green BEFORE mutating anything (${baseline.summary}) — fix that first:`);
  console.log(baseline.out.split('\n').filter((l) => l.startsWith('FAIL') || l.startsWith('SKIP')).join('\n'));
  process.exit(1);
}
console.log(`baseline: ${baseline.summary}\n`);

let bad = 0;
for (const mut of MUTATIONS) {
  const dir = mutantDir(mut);
  const r = runBench(dir);
  const caught = mut.mustFail.filter((id) => r.failed.includes(id));
  const missed = mut.mustFail.filter((id) => !r.failed.includes(id));

  if (mut.expectNoFailIsOk) {
    console.log(`note  ${mut.name}`);
    console.log(`        ${r.failed.length ? 'caught by ' + r.failed.join(', ') : 'NOT covered by any case'} — ${mut.breaks}`);
    continue;
  }
  const ok = !r.ok && missed.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'ok   ' : 'HOLE '} ${mut.name}`);
  console.log(`        breaks ${mut.breaks} → ${r.summary}`);
  if (caught.length) console.log(`        caught by: ${caught.join(', ')}`);
  if (missed.length) console.log(`        NOT caught by: ${missed.join(', ')}  <-- the bench has a hole here`);
  if (VERBOSE) console.log(r.out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => '        ' + l).join('\n'));
}

console.log(`\n${bad ? `${bad} mutation(s) went UNNOTICED — the bench proves less than it claims` : 'every mutation was caught'}`);
process.exit(bad ? 1 : 0);
