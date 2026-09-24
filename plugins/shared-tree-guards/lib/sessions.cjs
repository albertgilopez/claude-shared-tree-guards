'use strict';
/**
 * lib/sessions.cjs — the registry that answers one question: is another CLAUDE CODE SESSION
 * working in this same clone right now?
 *
 * "Claude Code session" is the literal scope, not shorthand. An entry only exists because a
 * SessionStart hook wrote it, so the only thing this can ever see is a Claude Code session with
 * this plugin loaded. A script, a cron, another agent CLI or a session that was already open
 * before the plugin was installed are all invisible here, and the guards will report `solo`.
 * That boundary is in the README because a user has to know it before relying on it.
 *
 * WHERE IT LIVES — `<git-common-dir>/claude-sessions/`. Every worktree of a clone shares that
 * directory; two different clones never do. So the scope of detection is the scope of the
 * problem, by construction, without enumerating processes or asking the OS anything.
 *
 * HOW IDENTITY WORKS — measured on 2026-09-24 (Windows, Claude Code 2.x), not assumed:
 *
 *   signal                SessionStart   PreToolUse   SessionEnd
 *   process.pid              78036         66608        78776      <- ephemeral, useless
 *   process.ppid             69204         30688        76844      <- ephemeral, useless
 *   CLAUDE_PID               37308         37308        37308      <- the session process
 *   CLAUDE_CODE_SESSION_ID   9936..61fd    same         same       <- the session identity
 *
 * A hook is a short-lived child process: its own pid is dead before the next hook runs.
 * Registering `process.pid` would make every liveness check return "dead", every state
 * return `solo`, and the guards would never fire — green, and doing nothing. The stable
 * pair is (session_id, CLAUDE_PID), and both come free with the hook payload/env.
 *
 * LIVENESS — an entry counts as live only if BOTH hold:
 *   1. its pid still exists (`process.kill(pid, 0)`; ESRCH = dead, EPERM = alive, another user)
 *   2. its transcript was touched within IDLE_MINUTES
 * Two conditions, ANDed, because the failure we can afford is a false `solo` (the guards stay
 * quiet, i.e. the plugin behaves like it is not installed). A false `shared` would block a
 * legitimate `git commit` for someone who shares nothing — that is the one that gets a plugin
 * uninstalled. Condition 2 is also what covers PID recycling by the OS.
 *
 * DR-7 — a dead entry is debris: it is ignored, and deleted in passing. Nobody is ever asked
 * to clean up. DR-8 — this directory is the ONLY thing any of these guards ever writes to.
 */
const fs = require('fs');
const path = require('path');
const { gitCommonDir, topLevel, canonical } = require('./git.cjs');

const DIR_NAME = 'claude-sessions';
/** How long after a subagent was last seen the session still counts as sharing its index. */
const SUBAGENT_WINDOW_MINUTES = Number(process.env.SHARED_TREE_GUARDS_SUBAGENT_MINUTES || 30);
const IDLE_MINUTES = Number(process.env.SHARED_TREE_GUARDS_IDLE_MINUTES || 180);

/** The registry directory for this repo, or null when we are not in a usable repo. */
function registryDir(cwd) {
  const common = gitCommonDir(cwd);
  return common ? path.join(common, DIR_NAME) : null;
}

/** Is `pid` a live process? EPERM means it exists and belongs to someone else. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/**
 * Note that a SUBAGENT of this session has just acted, so that the session's own later commands
 * are guarded too. Cheap: one small write the first time a subagent appears, not on every call.
 * Returns true if it wrote.
 */
function noteSubagent(payload = {}, now = Date.now()) {
  const me = identify(payload);
  if (!me.id) return false;
  const dir = registryDir(me.cwd);
  if (!dir) return false;
  const file = path.join(dir, safeName(me.id) + '.json');
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const last = Date.parse(entry.lastSubagentAt || 0) || 0;
    if (now - last < 60_000) return false;         // already noted a moment ago
    entry.lastSubagentAt = new Date(now).toISOString();
    fs.writeFileSync(file, JSON.stringify(entry) + '\n');
    return true;
  } catch {
    return false;   // no entry of our own (plugin installed mid-session): nothing to note
  }
}

/** The identity of the session this hook belongs to, from payload + env. */
function identify(payload = {}) {
  const id = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
  const pid = Number(process.env.CLAUDE_PID || 0) || null;
  const cwd = payload.cwd || process.cwd();
  return {
    id,
    pid,
    transcript: payload.transcript_path || null,
    cwd,
    toplevel: topLevel(cwd),
  };
}

function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Write (or refresh) this session's entry. Returns the entry path, or null if it could not
 * be written — a read-only .git is `unknown`, never an error in the user's face.
 */
function register(payload = {}, now = Date.now()) {
  const me = identify(payload);
  if (!me.id) return null;
  const dir = registryDir(me.cwd);
  if (!dir) return null;
  const file = path.join(dir, safeName(me.id) + '.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let startedAt = new Date(now).toISOString();
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev && prev.startedAt) startedAt = prev.startedAt; // refresh keeps the original start
    } catch { /* first write */ }
    const entry = {
      id: me.id,
      pid: me.pid,
      transcript: me.transcript,
      cwd: me.cwd,
      toplevel: me.toplevel,
      startedAt,
      touchedAt: new Date(now).toISOString(),
      host: require('os').hostname(),
    };
    fs.writeFileSync(file, JSON.stringify(entry) + '\n');
    return file;
  } catch {
    return null;
  }
}

/** Remove this session's entry (SessionEnd). Best effort; silence on failure. */
function unregister(payload = {}) {
  const me = identify(payload);
  if (!me.id) return false;
  const dir = registryDir(me.cwd);
  if (!dir) return false;
  try {
    fs.unlinkSync(path.join(dir, safeName(me.id) + '.json'));
    return true;
  } catch {
    return false;
  }
}

function transcriptFresh(entry, now) {
  if (!entry.transcript) return true; // cannot measure -> do not use this to kill the entry
  try {
    const st = fs.statSync(entry.transcript);
    return now - st.mtimeMs <= IDLE_MINUTES * 60 * 1000;
  } catch {
    return true; // transcript gone or unreadable: fall back to the pid check alone
  }
}

/**
 * All live entries in this repo. Dead ones are unlinked in passing (DR-7).
 * Returns [] when the registry cannot be read — which the caller must treat as `unknown`,
 * not as "nobody there": see `state()`.
 */
function list(cwd, now = Date.now()) {
  const dir = registryDir(cwd);
  if (!dir) return null;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return []; // directory not created yet == no other sessions have registered
  }
  const live = [];
  for (const n of names) {
    const f = path.join(dir, n);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      try { fs.unlinkSync(f); } catch {}
      continue;
    }
    if (pidAlive(entry.pid) && transcriptFresh(entry, now)) {
      live.push(entry);
    } else {
      try { fs.unlinkSync(f); } catch {} // debris, nobody is asked to clean it
    }
  }
  return live;
}

/**
 * `solo` | `shared` | `unknown`, plus the other live sessions.
 * `payload` identifies us so we are not counted as our own co-tenant.
 *
 * TWO SCOPES, and they are not the same thing (measured 2026-09-24):
 *
 *   scope 'clone' (default) — everyone under the same `--git-common-dir`. This is what the
 *     SessionStart banner reports, and it is genuinely informational: those sessions do share
 *     refs, the object store and the stash.
 *
 *   scope 'tree' — only sessions with the same `--show-toplevel`. This is what a GUARD must
 *     use, because two linked worktrees of one clone have SEPARATE indexes
 *     (`.git/worktrees/<name>/index`) and separate working trees. Blocking a private
 *     worktree's commit with "this may be their work" is false and, worse, it is the message
 *     that gets a plugin uninstalled. In a workspace that opens one worktree per session —
 *     which is exactly the workflow this plugin is for — that would be every single commit.
 */
function state(payload = {}, now = Date.now(), { scope = 'clone' } = {}) {
  const me = identify(payload);

  // ── Subagents share this session's index, and no registry can see them ────────────────────
  // Measured 2026-09-24: a Bash call made by a subagent DOES reach PreToolUse, and its payload
  // carries `agent_id` / `agent_type`, which a main-session call does not. It carries the same
  // session_id and the same CLAUDE_PID, so the registry cannot tell them apart — but it does not
  // need to. If this call comes from a subagent, then by construction there are at least two
  // actors on this one index (this subagent, and the session that spawned it, and possibly
  // sibling subagents running in parallel), and none of them can see what the others staged.
  //
  // That is co-tenancy DEMONSTRATED BY THE PAYLOAD ITSELF. No registry lookup, no write, no
  // guessing — which makes it the strongest signal in this file, not a weaker one.
  if (payload.agent_id) {
    return {
      state: 'shared',
      others: [],
      self: me,
      scope,
      reason: 'subagent',
      detail: `this command comes from a subagent (${payload.agent_type || 'unknown type'}) that shares the session's index`,
    };
  }

  const live = list(me.cwd, now);
  if (live === null) return { state: 'unknown', others: [] };
  // Dedupe by pid as well as by id. One PROCESS is one session: if SessionStart fires again
  // under a new session_id for the same process (a /clear, a /compact), the old entry is still
  // in the registry and we would count ourselves as our own co-tenant — `shared` with nobody,
  // for up to IDLE_MINUTES. That is exactly the false `shared` D-02 says we cannot afford.
  let others = live.filter((e) => e.id !== me.id && !(me.pid && e.pid === me.pid));
  if (scope === 'tree') {
    // An entry written before `toplevel` existed has none: keep it rather than silently
    // dropping a real co-tenant. Fail towards "still visible", not towards a false solo.
    others = others.filter((e) => !e.toplevel || !me.toplevel || canonical(e.toplevel) === me.toplevel);
  }
  if (others.length > 0) return { state: 'shared', others, self: me, scope, reason: 'other-session' };

  // The other half of the subagent case: this is the MAIN session speaking, but one of its own
  // subagents acted recently, so whatever it staged is in this same index and invisible here.
  const mine = live.find((e) => e.id === me.id);
  const lastSub = mine && Date.parse(mine.lastSubagentAt || 0);
  if (lastSub && now - lastSub <= SUBAGENT_WINDOW_MINUTES * 60 * 1000) {
    return {
      state: 'shared', others: [], self: me, scope, reason: 'own-subagent',
      detail: 'a subagent of this session acted recently and shares this index',
    };
  }

  return { state: 'solo', others, self: me, scope, reason: 'alone' };
}

module.exports = {
  register, unregister, list, state, identify, pidAlive, noteSubagent,
  registryDir, DIR_NAME, IDLE_MINUTES, SUBAGENT_WINDOW_MINUTES,
};
