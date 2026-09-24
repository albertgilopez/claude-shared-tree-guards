'use strict';
/**
 * lib/sessions.cjs — the session registry that answers one question: is anyone else
 * working in this same clone right now?
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
const { gitCommonDir } = require('./git.cjs');

const DIR_NAME = 'claude-sessions';
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

/** The identity of the session this hook belongs to, from payload + env. */
function identify(payload = {}) {
  const id = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || null;
  const pid = Number(process.env.CLAUDE_PID || 0) || null;
  return {
    id,
    pid,
    transcript: payload.transcript_path || null,
    cwd: payload.cwd || process.cwd(),
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
 */
function state(payload = {}, now = Date.now()) {
  const me = identify(payload);
  const live = list(me.cwd, now);
  if (live === null) return { state: 'unknown', others: [] };
  const others = live.filter((e) => e.id !== me.id);
  return { state: others.length > 0 ? 'shared' : 'solo', others, self: me };
}

module.exports = {
  register, unregister, list, state, identify, pidAlive,
  registryDir, DIR_NAME, IDLE_MINUTES,
};
