# shared-tree-guards

A Claude Code plugin for the case the tooling assumes away: **more than one agent session in the
same git clone**.

Git has one index and one working tree per clone. With two sessions in it, two ordinary commands
become destructive — `git commit -m "..."` commits *the whole index*, including whatever the other
session had staged, and `git checkout <ref> -- <path>` overwrites their uncommitted work with no
reflog, no stash and nothing to recover.

**This does not make sharing a working tree safe.** Nothing does; the industry answer is one
worktree per agent, and if you can do that, do that. This is damage reduction for when you cannot.

## It is silent unless you are actually sharing

Every guard is gated on co-tenancy. With one session in the clone the plugin is
**indistinguishable from not having it installed** — no output, no blocking, nothing. It only
speaks when its assumption holds.

Two escape hatches, both honoured as an env var and as a literal prefix in the command:

```bash
SHARED_TREE_GUARDS_OFF=1 git commit -m "..."    # off entirely
SHARED_TREE_GUARDS_WARN=1                       # warn instead of block
```

**The limit, up front:** the gate only sees sessions that *register*. Share a tree with something
that does not — a script, a cron, another agent — and the plugin will see `solo` and stay quiet
exactly when it should speak.

## Install

```bash
claude plugin marketplace add albertgilopez/claude-shared-tree-guards
claude plugin install shared-tree-guards@shared-tree-guards
```

## What it does

| Component | When | What |
|---|---|---|
| `cotenancy` | SessionStart / SessionEnd | Registers the session in `<git-common-dir>/claude-sessions/`; prints one warning if someone else is already there. **Never blocks** (DR-6). |
| `commit-guard` | `PreToolUse(Bash)` | Blocks a `git commit` whose index holds paths this command did not stage, or staged deletions of files that are on disk. |
| `overwrite-guard` | `PreToolUse(Bash)` | *Not implemented yet (T5).* `checkout` / `restore` / `reset --hard` / `clean -f` over paths with uncommitted changes. |

The registry lives in `git rev-parse --git-common-dir` because every worktree of a clone shares
that directory and two clones never do: **the scope of detection is the scope of the problem, by
construction** — no process enumeration, nothing OS-specific.

Session identity is `(session_id, CLAUDE_PID)`, measured rather than assumed — a hook is a
short-lived child process whose own pid is dead before the next hook runs, so registering
`process.pid` would have produced a plugin that installs, tests green and does nothing.
See `DOCTRINE.md` D-01 for the measurement.

## Status

Early. `commit-guard` and `cotenancy` are implemented and green locally on Windows
(16 acceptance cases, 9 library tests); Linux is CI-pending. `overwrite-guard`, the cost
measurement and the formal negative-control suite are next. `SPEC.md` and `cases.yaml` are the
contract: every acceptance criterion cites a case id, and the cases run against the real handlers
in real temporary repositories — no mocks of git.

## Develop

```bash
npm install
node test/run-cases.mjs          # --verbose, or --only AC-01,AC-16
node --test test/lib.test.mjs
claude plugin validate .
```

`AGENTS.md` has the layout and the conventions. `DOCTRINE.md` has the rules with the cost that
bought each one.

MIT.
