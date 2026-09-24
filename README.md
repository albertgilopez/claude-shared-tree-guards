# shared-tree-guards

A Claude Code plugin for the case the tooling assumes away: **more than one Claude Code session
live in the same git clone**.

Git has one index and one working tree per clone. With two sessions in it, two ordinary commands
become destructive — `git commit -m "..."` commits *the whole index*, including whatever the other
session had staged, and `git checkout <ref> -- <path>` overwrites their uncommitted work with no
reflog, no stash and nothing to recover.

**This does not make sharing a working tree safe.** Nothing does; the industry answer is one
worktree per session, and if you can do that, do that. This is damage reduction for when you
cannot.

**It guards against other Claude Code sessions, specifically.** That is the scope, not a
simplification: the whole mechanism rests on sessions registering themselves, and the only thing
that registers is a Claude Code session with this plugin loaded. See "What it does not see".

## It is silent unless you are actually sharing

Every guard is gated on co-tenancy. With one session in the clone the plugin is
**indistinguishable from not having it installed** — no output, no blocking, nothing. It only
speaks when its assumption holds.

Two escape hatches, both honoured as an env var and as a literal prefix in the command:

```bash
SHARED_TREE_GUARDS_OFF=1 git commit -m "..."    # off entirely
SHARED_TREE_GUARDS_WARN=1 git commit -m "..."  # warn instead of block
```

### What it does not see

The gate only sees what **registers**, and the only thing that registers is a Claude Code session
with this plugin loaded. Everything else sharing that working tree is invisible to it:

- another agent CLI (Cursor, Codex, Aider, Copilot Workspace, …)
- your own scripts, a cron job, a `make` target, a deploy script
- an editor plugin that commits on a timer
- a teammate over a network share
- **a Claude Code session that was already open when you installed this** — plugins load at
  session start, so it takes effect in the *next* session, not the current one

In all of those the plugin reports `solo` and stays quiet exactly when it should speak. This is
the price of the decision above, and it is deliberate: a guard that fired without demonstrated
co-tenancy could not be published.

## Install

```bash
claude plugin marketplace add albertgilopez/claude-shared-tree-guards
claude plugin install shared-tree-guards@shared-tree-guards
```

## What it does

| Component | When | What |
|---|---|---|
| `cotenancy` | SessionStart / SessionEnd | Registers this Claude Code session in `<git-common-dir>/claude-sessions/` and removes it on exit; prints one warning if another session is already there. **Never blocks** (DR-6). |
| `commit-guard` | `PreToolUse(Bash)` | Blocks a `git commit` whose index holds paths this command did not stage, or staged deletions of files that are on disk. |
| `overwrite-guard` | `PreToolUse(Bash)` | Blocks `checkout <ref> -- <path>`, `restore`, `reset --hard` and `clean -f` when those paths hold uncommitted changes. These are the git commands that destroy work with no reflog, no stash and nothing dangling to recover from. |

The registry lives in `git rev-parse --git-common-dir` because every worktree of a clone shares
that directory and two clones never do: **the scope of detection is the scope of the problem, by
construction** — no process enumeration, nothing OS-specific.

### Which sessions count as sharing

| Situation | Counts? | Why |
|---|---|---|
| Two `claude` sessions in the same folder | **yes** | both register, different PIDs, same working tree |
| A session and a `claude -p` it spawns | **yes** | the child gets its own `session_id` and `CLAUDE_PID` |
| A session and one of its own subagents | no | same process, same `CLAUDE_PID`; it is you, not someone else |
| Sessions in **different worktrees** of one clone | they see each other, but the guards stay quiet | they share `.git`, not the index |
| Sessions in **different clones** | no | nothing is shared, and nothing is at risk |

Session identity is `(session_id, CLAUDE_PID)`, measured rather than assumed — a hook is a
short-lived child process whose own pid is dead before the next hook runs, so registering
`process.pid` would have produced a plugin that installs, tests green and does nothing.
See `DOCTRINE.md` D-01 for the measurement.

[![ci](https://github.com/albertgilopez/claude-shared-tree-guards/actions/workflows/ci.yml/badge.svg)](https://github.com/albertgilopez/claude-shared-tree-guards/actions/workflows/ci.yml)

## Status

Early. `commit-guard` and `cotenancy` are implemented and green on Linux and Windows
(18 acceptance cases, 12 library tests, and a real `claude -p` session that gets blocked -- in both block and warn modes);  `overwrite-guard`, the cost
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
