'use strict';
/**
 * lib/git.cjs — the only place that shells out to git.
 *
 * DR-3: nothing here throws. Every function returns null when it cannot measure,
 * so a caller that forgets a try/catch still fails OPEN.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const TIMEOUT_MS = Number(process.env.SHARED_TREE_GUARDS_TIMEOUT_MS || 20000);

/** Run git in `cwd`. Returns trimmed stdout, or null on ANY failure (git missing, not a repo, timeout). */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** Absolute path of the repo's working tree root, or null. */
function topLevel(cwd) {
  const out = git(['rev-parse', '--show-toplevel'], cwd);
  return out ? path.resolve(out) : null;
}

/**
 * Absolute path of the shared git dir — the one every worktree of a clone has in common,
 * and that two different clones never share. This is why it is the right scope for the
 * session registry: detection scope == problem scope, by construction.
 *
 * NOTE: in the main worktree git prints a RELATIVE path (".git"); only in a linked worktree
 * is it absolute. Resolving against cwd is not optional.
 */
function gitCommonDir(cwd) {
  const out = git(['rev-parse', '--git-common-dir'], cwd);
  if (!out) return null;
  return path.isAbsolute(out) ? path.resolve(out) : path.resolve(cwd, out);
}

module.exports = { git, topLevel, gitCommonDir, TIMEOUT_MS };
