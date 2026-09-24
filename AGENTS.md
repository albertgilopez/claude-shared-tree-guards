# AGENTS.md — claude-shared-tree-guards

What any agent (Claude Code, Codex, Cursor) needs before touching this repo.

## What this is

A Claude Code plugin, and in the same repo the one-entry marketplace that serves it. It makes a
git working tree **shared by more than one Claude Code session** less dangerous. It does not make
it safe; nothing can. See `SPEC.md` § "Explicitly out of scope".

**The scope is Claude Code, and that is load-bearing.** The whole mechanism rests on sessions
registering themselves in `<git-common-dir>/claude-sessions/`, and the only thing that does that
is a Claude Code session with this plugin loaded. Do not describe it as guarding against "agents"
or "other tools": it does not see them, and saying otherwise promises what it cannot do.

## Layout

```
.claude-plugin/marketplace.json          the marketplace (lists one plugin)
plugins/shared-tree-guards/
  .claude-plugin/plugin.json             the plugin manifest
  hooks/hooks.json                       SessionStart + SessionEnd + PreToolUse(Bash)
  hooks-handlers/cotenancy.cjs           registers the session; warns; `--list [--json]` CLI
  hooks-handlers/commit-guard.cjs        blocks a commit that carries unstaged-by-this-command work
  hooks-handlers/overwrite-guard.cjs     (T5, not written yet)
  lib/git.cjs                            the ONLY place that shells out to git; never throws
  lib/payload.cjs                        hook protocol in, block() out, escape hatches
  lib/sessions.cjs                       the registry in <git-common-dir>/claude-sessions/
test/run-cases.mjs                       cases.yaml against the REAL handlers, in real temp repos
test/lib.test.mjs                        DR-3: fail-open at the library level
SPEC.md · cases.yaml                     the contract; every AC cites a case id
DOCTRINE.md                              rules, each with the cost that bought it
```

## Commands

```bash
npm install
node test/run-cases.mjs              # acceptance cases (add --verbose, or --only AC-01,AC-16)
node --test test/lib.test.mjs        # library contract
claude plugin validate .             # manifests
```

Local install, end to end:

```bash
claude plugin marketplace add "$PWD"
claude plugin install shared-tree-guards@shared-tree-guards
```

## Conventions that are not negotiable

- **Exit 2 + stderr is the only block protocol.** `lib/payload.cjs` `block()` is the single
  definition. Do not reintroduce `permissionDecision: deny` — the two ported guards had drifted
  apart on this and it is a bug waiting for whoever reads one to understand the other.
- **Nothing in `lib/` throws.** Return `null`. See DOCTRINE D-03.
- **Every guard is gated on co-tenancy.** With one session it must be *completely* silent — that
  is what makes this publishable, not a nicety.
- **A guard writes nowhere but `<git-common-dir>/claude-sessions/`.** Not the index, not refs, not
  the working tree.
- **No `.koncept/` here.** Deliberate: koncepto is workspace governance and a public repo should
  not ask contributors to learn a system that is not theirs. The invariants are the tests.
- **English everywhere in this repo**, including comments, commit messages, test fixture strings
  and the cases file. It is public. The original specs were written in Catalan in a private
  workspace; `SPEC.md` here is the English one and is the canonical contract from now on. The
  Catalan design document is deliberately NOT shipped: it is full of references to one private
  workspace and would be noise to anyone else. `DOCTRINE.md` carries the decisions that matter.

## Decided NOT to do

- **`worktree-guard` does not travel here.** It encodes a Tier model specific to one workspace
  (15 references to it, plus junction logic pointing at Google Drive). Measured, not assumed.
- **Making a shared tree safe.** These guards reduce damage. The industry answer is one worktree
  per session; this is for people who cannot.
- **Publishing to Anthropic's official marketplace.** Own repo first.

## The known limit, which belongs in the README and not in a comment

The co-tenancy gate only sees sessions that **register**, i.e. Claude Code sessions with this
plugin loaded. A script, a cron, another agent CLI, an editor plugin that commits on a timer, or
a Claude Code session that was already open before the plugin was installed: for all of those the
plugin reports `solo` and stays quiet exactly when it should speak.

If that ever needs to change, the shape is a public `register` command any process could call,
not loosening the gate. Nobody has asked for it, and it adds public surface to maintain.
