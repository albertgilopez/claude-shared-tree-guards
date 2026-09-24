#!/usr/bin/env node
'use strict';
/**
 * commit-guard.cjs — PreToolUse(Bash). Blocks a `git commit` that would carry work this
 * command did not stage, or apply deletions the working tree contradicts.
 *
 * WHY (measured, not theorised)
 * -----------------------------
 * git has ONE index per clone. With more than one Claude Code session in the same working tree,
 * two perfectly ordinary commands become destructive:
 *
 *   A) `git commit -m "..."` with no `-- <paths>` commits the WHOLE index. Whatever another
 *      session had staged goes into your commit. Observed 2026-09-24: a commit swept up a
 *      file another session was still editing, and the push conflicted.
 *
 *   B) After a `git update-ref` (a merge done by plumbing) the index still points at the OLD
 *      tree: `git status` shows dozens of staged DELETIONS of files that are right there on
 *      disk. Committing there applies them. Observed four times before the guard existed.
 *
 * Both checks are SYNTACTIC, never judgement: they do not guess who a file "belongs to".
 * The first compares the index with what this same command staged; the second compares the
 * index with the disk. In every blocked case the commit would literally do something the
 * command does not express.
 *
 * Escapes: use `-- <paths>` (which is the right habit anyway), or SHARED_TREE_GUARDS_OFF=1.
 */
const fs = require('fs');
const path = require('path');
const { git, topLevel } = require('../lib/git.cjs');
const sessions = require('../lib/sessions.cjs');
const { readPayload, command, effectiveCwd, block, disabled, warnOnly, warn } = require('../lib/payload.cjs');

// ── reading the command ──────────────────────────────────────────────────────────────────
// Split on shell separators, because `git add X && git commit -m "..."` is ONE tool call.
// NOT on newlines: a multi-line commit message would leave the `commit` segment without the
// trailing `-- <paths>` and the gate would fire on a correct command. Measured: the guard
// blocked its own (correct) commit. A guard that blocks the right case gets switched off,
// so where it is ambiguous this gate is LENIENT.
const segments = (cmd) => String(cmd).split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean);

const isCommit = (s) => /(^|\s)git\s+(-[^\s]+\s+|-C\s+\S+\s+)*commit(\s|$)/.test(s);
const isAdd = (s) => /(^|\s)git\s+(-[^\s]+\s+|-C\s+\S+\s+)*add(\s|$)/.test(s);
/** DR-2's single legitimate exception: `git rm --cached` stages a deletion of a file that stays. */
const isRmCached = (s) => /(^|\s)git\s+(-[^\s]+\s+|-C\s+\S+\s+)*rm\s[^|;&]*--cached\b/.test(s);
/** `git rm` and `git mv` stage things too. "What this command staged" is not "what it `git add`ed". */
const isRm = (s) => /(^|\s)git\s+(-[^\s]+\s+|-C\s+\S+\s+)*rm(\s|$)/.test(s);
const isMv = (s) => /(^|\s)git\s+(-[^\s]+\s+|-C\s+\S+\s+)*mv(\s|$)/.test(s);
const isStaging = (s) => isAdd(s) || isRm(s) || isMv(s);

/**
 * Is there a real pathspec after `commit`? It must be found OUTSIDE quotes.
 * A naive indexOf(' -- ') let a commit message containing " -- " look like a pathspec and
 * waved the entire index through — a silent false negative, which in a guard is worse than
 * no guard at all: it grants permission. Measured 2026-09-24.
 */
function hasPathspec(s) {
  const m = /(^|\s)git\s+(?:-[^\s]+\s+|-C\s+\S+\s+)*commit(\s|$)/.exec(s);
  if (!m) return false;
  const after = s.slice(m.index + m[0].length);
  let q = null;
  for (let i = 0; i < after.length - 3; i++) {
    const c = after[i];
    if (q) { if (c === q && after[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ' ' && after[i + 1] === '-' && after[i + 2] === '-' && after[i + 3] === ' ') {
      return after.slice(i + 4).trim().length > 0;
    }
  }
  return false;
}

/** Paths a staging subcommand (`add`, `rm`, `mv`) touched in the same tool call. Deliberately
 *  GENEROUS: when in doubt, assume it is covered, because this gate may only fire when the
 *  answer is unambiguous. */
function addedPaths(seg) {
  const toks = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const out = [];
  let seen = false;
  for (const tok of toks) {
    const t = tok.replace(/^["']|["']$/g, '');
    if (!seen) { if (t === 'add' || t === 'rm' || t === 'mv') seen = true; continue; }
    if (t === '--' || t.startsWith('-')) continue;
    out.push(t.replace(/\\/g, '/').replace(/\/+$/, ''));
  }
  return out;
}

const covered = (p, roots) => roots.some((r) => r === '.' || p === r || p.startsWith(r + '/'));

// ── the gate ─────────────────────────────────────────────────────────────────────────────
/**
 * @param readStaged injected so the test bench exercises THE GATE. With real git wired in,
 * any failure fell through to fail-open and the tests passed for the wrong reason (3 of 6
 * did, measured). A bench that cannot fail proves nothing.
 */
function evaluate(cmd, root, io = fs, readStaged = null) {
  const segs = segments(cmd);
  const commits = segs.filter(isCommit);
  if (!commits.length) return null;
  if (commits.every(hasPathspec)) return null; // the right habit: nothing to say

  let staged;
  try {
    const raw = readStaged ? readStaged() : git(['diff', '--cached', '--name-status'], root);
    if (raw === null || raw === undefined) return null; // not a repo, or git unavailable: fail open
    staged = String(raw).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  if (!staged.length) return null;             // empty index: the commit carries nothing

  const rows = staged.map((l) => { const [st, ...r] = l.split('\t'); return { st: st[0], p: r.join('\t') }; });

  // ── Check B: staged deletions of files that ARE on disk (a stale index) ────────────────
  // Skipped when this same command ran `git rm --cached`, which stages exactly that state
  // on purpose (DR-2). LIMIT: a `git rm --cached` from an EARLIER tool call is invisible
  // here and will be blocked; the escape is `-- <paths>` or SHARED_TREE_GUARDS_OFF=1.
  if (!segs.some(isRmCached)) {
    const zombies = rows.filter((r) => r.st === 'D' && io.existsSync(path.join(root, r.p)));
    if (zombies.length) {
      return {
        kind: 'zombie-deletions',
        paths: zombies.map((z) => z.p),
        msg: [
          `BLOCKED: the index holds ${zombies.length} staged DELETION(S) of files that are on disk.`,
          `  That is a stale index (typically after a plumbing merge / update-ref), not a decision:`,
          `  ${zombies.slice(0, 6).map((z) => z.p).join(', ')}${zombies.length > 6 ? ` (+${zombies.length - 6} more)` : ''}`,
          `  -> \`git reset -q\` (resets the index to HEAD, leaves the tree untouched), then stage what is yours.`,
          `  If you meant it, this was a \`git rm --cached\` in an earlier command: repeat with \`-- <paths>\`.`,
          `  Escape: SHARED_TREE_GUARDS_OFF=1`,
        ].join('\n'),
      };
    }
  }

  // ── Check A: the index holds things this command did not stage ────────────────────────
  const roots = segs.filter(isStaging).flatMap(addedPaths);
  const extra = rows.map((r) => r.p).filter((p) => !covered(p, roots));
  if (!extra.length) return null;

  const judged = commits.map((c) => c.replace(/\s+/g, ' ').slice(0, 160)).join(' | ');
  return {
    kind: 'foreign-index',
    paths: extra,
    msg: [
      `BLOCKED: \`git commit\` without \`-- <paths>\` would carry ${extra.length} file(s) this command did not stage.`,
      `  Another session is working in this same clone and git has ONE index: this may be their work.`,
      `  ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ` (+${extra.length - 8} more)` : ''}`,
      `  -> Repeat with a pathspec:  git commit -m "..." -- <your paths>`,
      `     (or \`git reset -q\` and stage only yours).  Escape: SHARED_TREE_GUARDS_OFF=1`,
      ``,
      `  [what I judged] ${commits.length} commit segment(s), none with a pathspec:`,
      `  ${judged}`,
      `  If that segment DID carry \` -- paths\`, this is a bug in the guard: report it with this line.`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------- hook
if (require.main === module) {
  readPayload((payload) => {
    const cmd = command(payload);
    if (!cmd || disabled(cmd)) process.exit(0);
    if (!segments(cmd).some(isCommit)) process.exit(0);          // fast path

    const cwd = effectiveCwd(cmd, payload);
    const root = topLevel(cwd);
    if (!root) process.exit(0);                                   // not a repo: silence (AC-12)

    // The gate that makes this publishable: with one session, say nothing at all.
    // Scope 'tree': a linked worktree has its OWN index, so a session in another worktree of
    // this clone cannot have staged anything into the index we are about to commit.
    const co = sessions.state({ ...payload, cwd }, Date.now(), { scope: 'tree' });
    if (co.state !== 'shared') process.exit(0);

    const verdict = evaluate(cmd, root);
    if (!verdict) process.exit(0);
    if (warnOnly()) warn(verdict.msg);   // see lib/payload.cjs: stderr alone never reaches the model
    block(verdict.msg);
  });
}

module.exports = { evaluate, isCommit, isAdd, isRmCached, isRm, isMv, isStaging, hasPathspec, addedPaths, covered, segments };
