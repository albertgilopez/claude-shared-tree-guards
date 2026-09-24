# DOCTRINE — claude-shared-tree-guards

> Append-only. Every rule here was bought with a cost; the cost is written next to it.
> Nothing in this file is a preference.

base-exempt: this repo is three hook handlers and a session registry — there is no domain to keep pure. A `core/` with an AST boundary test would guard nothing, and the invariants that WOULD justify one (fail-open, "the guards are silent when solo", "the guards write nowhere else") are verified as executable cases instead: `test/lib.test.mjs` and `test/run-cases.mjs` against `cases.yaml`. DOCTRINE, AGENTS, `state/` and `STATED.json` still apply.

---

## D-01 · The identity of a session is `(session_id, CLAUDE_PID)`, never `process.pid`

**Measured 2026-09-24**, Windows, Claude Code 2.x, by installing a probe handler and reading
what three consecutive hook events actually see:

| signal | SessionStart | PreToolUse | SessionEnd |
|---|---|---|---|
| `process.pid` | 78036 | 66608 | 78776 |
| `process.ppid` | 69204 | 30688 | 76844 |
| `CLAUDE_PID` | **37308** | **37308** | **37308** |
| `CLAUDE_CODE_SESSION_ID` | `9936…61fd` | same | same |

**The cost this bought.** A hook is a short-lived child process: its own pid is dead before the
next hook runs. Registering `process.pid` would have made every liveness check say "dead", every
state say `solo`, and the guards would never have fired — a plugin that installs, tests green and
does nothing. That is the exact failure the SPEC calls *an instrument that lies in green*, and the
only way to rule it out was to measure, not to reason about it.

## D-02 · A false `solo` is acceptable; a false `shared` is not

Liveness requires BOTH a live pid AND a transcript touched within the idle window. Two conditions
ANDed, which biases the answer towards `solo`.

**Why that direction.** A false `solo` means the guards stay quiet — the plugin behaves as if it
were not installed, which is the state almost every user is in anyway. A false `shared` blocks a
legitimate `git commit -m "..."` for someone who shares nothing with anyone, and that is how a
plugin gets uninstalled. The AND also covers PID recycling by the OS for free.

## D-03 · Nothing in `lib/` throws

`git()` returns `null` when it cannot measure — git missing from PATH, not a repo, timeout. The
callers still wrap in try/catch, but the guarantee lives one level down, because the day a caller
forgets, a guard would block a stranger because of its own internal error. `test/lib.test.mjs`
holds this: it strips git from PATH and asserts `null`, not an exception.

## D-04 · A bench that cannot fail proves nothing

`evaluate()` takes an injected `readStaged` so the cases exercise **the gate**. In the version this
was ported from, real git was wired in: any failure fell through to fail-open and **3 of 6 gate
tests passed for the wrong reason** (measured 2026-09-24). Before declaring T4 done, the guard was
mutated to `const verdict = null` and the bench went from 16 pass / 0 fail to **12 pass / 4 fail** —
that run is the evidence that the bench can fail, and it is the only reason the green one counts.

## D-05 · "What this command staged" is not "what this command `git add`ed"

`git rm` and `git mv` stage things too. Reading only `git add` made `git rm --cached z.md && git
commit -m "x"` look like a foreign index (found by AC-17 on the first run). The concept the gate
needs is *staged by this invocation*, and the code must say so.

## D-06 · Where it is ambiguous, the gate is lenient

Two false-positive shapes were bought at the cost of a guard that blocked correct commands, which
is how guards get switched off:

- the command is **not** split on newlines — a multi-line commit message left the `commit` segment
  without its trailing `-- <paths>`;
- `addedPaths()` is deliberately generous — when in doubt, treat a path as covered.

And one false-**negative** shape, which is worse because it grants permission silently: ` -- `
inside a commit message used to look like a pathspec and waved the whole index through. The scan
for `--` skips quoted regions.
