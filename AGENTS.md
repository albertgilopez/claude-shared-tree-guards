# AGENTS.md — claude-shared-tree-guards

What any agent (Claude Code, Codex, Cursor) needs before touching this repo.

## What this is

A Claude Code plugin — and, in the same repo, the one-entry marketplace that serves it. It makes
a git working tree **shared by more than one agent session** less dangerous. It does not make it
safe; nothing can. See `SPEC.md` § "Fora d'abast".

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
- **English in this repo**, including comments — it is public. (The specs it came from are in
  Catalan; that is fine, they are attached as provenance.)

## Decided NOT to do

- **`worktree-guard` does not travel here.** It encodes a Tier model specific to one workspace
  (15 references to it, plus junction logic pointing at Google Drive). Measured, not assumed.
- **Making a shared tree safe.** These guards reduce damage. The industry answer is one worktree
  per agent; this is for people who cannot.
- **Publishing to Anthropic's official marketplace.** Own repo first.

## The known limit, which belongs in the README and not in a comment

The co-tenancy gate only sees sessions that **register**. If you share a tree with something that
does not — a script, a cron, another agent — the plugin sees `solo` and stays quiet exactly when
it should speak.
