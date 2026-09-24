#!/usr/bin/env node
'use strict';
/**
 * overwrite-guard.cjs — PreToolUse(Bash). Blocks a git command that overwrites the working
 * tree when the paths it would touch hold changes that are not committed anywhere.
 *
 * WHY THESE COMMANDS AND NOT OTHERS
 * ---------------------------------
 * `git checkout <ref> -- <path>` and `git restore <path>` are the only git commands that
 * destroy work with **nothing left to recover from**: no reflog entry, no stash, no dangling
 * blob. A `reset --hard` at least leaves the commit reachable through the reflog. Uncommitted
 * changes overwritten by a checkout are simply gone.
 *
 * That is why this blocks rather than warns: there is no judgement to make. If the paths hold
 * work nobody has committed, you need to know before, every time.
 *
 * WHY IT EXISTS
 * -------------
 * One session ran `git checkout origin/main -- <dir>` on a shared working tree to bring in its
 * own changes, and destroyed another session's tracked-but-uncommitted edits. It was not the
 * first time: the same command, the same tree and the same outcome had happened two months
 * earlier. The remedy had been written down both times, which is precisely why it needed to
 * stop being something to remember.
 *
 * It is also the hole that the rest of the tooling leaves open: guards that watch file-editing
 * tools do not see Bash at all, and a git command that destroys two hundred files is invisible
 * to them.
 *
 * CRITERION
 *   1. No destructive token in the command -> pass immediately (fast path).
 *   2. Not sharing this working tree with a live session -> pass (the co-tenancy gate).
 *   3. Resolve the repo and the pathspecs; ask `git status --porcelain` what is dirty THERE.
 *   4. Dirty -> block, listing the files at risk and the ways out.
 *   5. Clean -> pass. Fail OPEN on any internal error (DR-3).
 */
const { git, topLevel } = require('../lib/git.cjs');
const sessions = require('../lib/sessions.cjs');
const { readPayload, command, effectiveCwd, block, disabled, warnOnly, warn } = require('../lib/payload.cjs');

const MAX_LISTED = 12;

/**
 * Commands that overwrite the working tree, and which kind of change each one destroys:
 * 'tracked' (modifications to versioned files) or 'untracked'.
 */
const DESTRUCTIVE = [
  { re: /\bgit\s+(?:-C\s+\S+\s+)?checkout\b(?=[^|;&]*\s--\s)/, kind: 'tracked', name: 'git checkout … -- <path>' },
  { re: /\bgit\s+(?:-C\s+\S+\s+)?checkout\s+--\s/, kind: 'tracked', name: 'git checkout -- <path>' },
  { re: /\bgit\s+(?:-C\s+\S+\s+)?restore\b/, kind: 'tracked', name: 'git restore' },
  { re: /\bgit\s+(?:-C\s+\S+\s+)?reset\s+--hard\b/, kind: 'tracked', name: 'git reset --hard' },
  { re: /\bgit\s+(?:-C\s+\S+\s+)?clean\s+-[a-zA-Z]*f/, kind: 'untracked', name: 'git clean -f' },
];

const hits = (cmd) => DESTRUCTIVE.find((d) => d.re.test(cmd));

/** Explicit paths after a `--`. None means the whole repo. */
function extractPathspecs(cmd) {
  const m = String(cmd).match(/\s--\s+([^|;&]+)/);
  if (!m) return [];
  return m[1]
    .trim()
    .split(/\s+/)
    .map((s) => s.replace(/^["']|["']$/g, ''))
    .filter((s) => s && !s.startsWith('-'));
}

/** What `git status --porcelain` says is at risk in those paths, or null if nothing is. */
function analyze(cmd, cwd) {
  const hit = hits(cmd);
  if (!hit) return null;

  const root = topLevel(cwd);
  if (!root) return null; // not a repo: fail open

  const paths = extractPathspecs(cmd);
  const args = ['status', '--porcelain'];
  if (paths.length) args.push('--', ...paths);

  const out = git(args, cwd);
  if (!out) return null; // git failed, or the scope is clean

  const lines = out.split('\n').filter(Boolean);
  const at_risk = lines.filter((l) => {
    const x = l.slice(0, 2);
    if (hit.kind === 'untracked') return x === '??';
    // tracked: any change in the tree or the index that this command would step on
    return x !== '??' && x.trim() !== '';
  });
  if (!at_risk.length) return null;

  return { hit, root, paths, at_risk };
}

function buildReason({ hit, root, paths, at_risk }, co = {}) {
  const shown = at_risk.slice(0, MAX_LISTED);
  const rest = at_risk.length - shown.length;
  const scope = paths.length ? paths.join(' ') : '(the whole repo)';
  const verb = hit.kind === 'untracked' ? 'would delete' : 'would overwrite';
  const recoverable =
    hit.kind === 'untracked'
      ? 'Untracked files exist nowhere else: once deleted there is no reflog and no stash to bring them back.'
      : hit.name.startsWith('git reset')
        ? 'The commit would still be reachable through the reflog. The uncommitted changes would not.'
        : 'There is no reflog entry, no stash and no dangling blob: what is lost here is not recoverable.';

  return [
    `BLOCKED: \`${hit.name}\` ${verb} ${at_risk.length} file(s) with uncommitted changes.`,
    ``,
    `  repo:  ${root}`,
    `  scope: ${scope}`,
    ``,
    ...shown.map((l) => `  ${l}`),
    ...(rest > 0 ? [`  … and ${rest} more`] : []),
    ``,
    recoverable,
    ``,
    co.reason === 'subagent'
      ? `This command comes from a SUBAGENT, which shares the session's working tree. These changes`
      : co.reason === 'own-subagent'
        ? `A SUBAGENT of this session acted recently and shares this working tree. These changes`
        : `Another Claude Code session is live in this same working tree, so these changes`,
    `may be theirs and still in progress. Ways out:`,
    `  1. Commit what is there (with explicit paths) and repeat the command.`,
    `  2. \`git stash push -m "<why>" -- <paths>\` if it is not yours and you do not want to lose it.`,
    `  3. Narrow the pathspec so it does not touch the dirty files.`,
    `  4. If you really do mean to discard them: SHARED_TREE_GUARDS_OFF=1 <command>`,
  ].join('\n');
}

// ---------------------------------------------------------------- hook
if (require.main === module) {
  readPayload((payload) => {
    const cmd = command(payload);
    if (!cmd || disabled(cmd)) process.exit(0);
    // `git restore --help` touches nothing: not worth a false positive.
    if (/\s(--help|-h)\b/.test(cmd)) process.exit(0);
    if (!hits(cmd)) process.exit(0); // fast path

    const cwd = effectiveCwd(cmd, payload);
    if (!topLevel(cwd)) process.exit(0); // not a repo: silence (AC-12)

    // Scope 'tree': a session in another worktree of this clone has its own working tree and
    // cannot be the owner of what this command would overwrite here.
    const co = sessions.state({ ...payload, cwd }, Date.now(), { scope: 'tree' });
    if (co.state !== 'shared') process.exit(0);
    // Remember that a subagent acted, so this session's OWN later commands are guarded too:
    // whatever the subagent staged is in this same index and invisible from the main session.
    if (co.reason === 'subagent') sessions.noteSubagent({ ...payload, cwd });

    const res = analyze(cmd, cwd);
    if (!res) process.exit(0);

    const reason = buildReason(res, co);
    if (warnOnly()) warn(reason);
    block(reason);
  });
}

module.exports = { analyze, buildReason, extractPathspecs, hits, DESTRUCTIVE };
