'use strict';
/**
 * lib/payload.cjs — reading the hook protocol, and the single definition of "block".
 *
 * Input  (stdin): { "tool_input": { "command": "..." }, "cwd": "...", ... }
 * Output (stderr): a human message, only when blocking
 * Exit:   0 = pass · 2 = block (the message reaches the model)
 *
 * Both guards use exit 2 + stderr. They must not each invent a protocol: the KB versions
 * had drifted apart (one exit-2, one JSON permissionDecision) and that is a bug waiting to
 * happen the day someone reads one to understand the other.
 */

/** Read the whole of stdin, then hand the parsed payload to `fn`. Never throws; never blocks on parse failure. */
function readPayload(fn) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      process.exit(0); // unparseable input is not a reason to block anyone
    }
    try {
      fn(payload || {});
    } catch {
      process.exit(0); // DR-3: an internal error never blocks
    }
    process.exit(0);
  });
}

const command = (p) => String(p?.tool_input?.command || '');

/**
 * The cwd a guard should measure from. The payload's cwd is authoritative; `cd X && git ...`
 * inside the command overrides it for that command.
 */
function effectiveCwd(cmd, payload) {
  const fallback = payload?.cwd || process.cwd();
  const m = String(cmd).match(/(?:^|[;&]|\|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/);
  if (!m) return fallback;
  return m[1].replace(/^["']|["']$/g, '');
}

/** Block: print the reason to stderr and exit 2. DR-5 — the message must say what was judged. */
function block(msg) {
  process.stderr.write(String(msg).replace(/\s*$/, '') + '\n');
  process.exit(2);
}

/** Global escape hatch (DR-4). Honoured as an env var AND as a literal prefix in the command,
 *  because a hook runs in its own process and does NOT inherit `VAR=1 some-command`. */
function disabled(cmd) {
  if (process.env.SHARED_TREE_GUARDS_OFF === '1') return true;
  if (cmd && /SHARED_TREE_GUARDS_OFF=1/.test(cmd)) return true;
  return false;
}

const warnOnly = () => process.env.SHARED_TREE_GUARDS_WARN === '1';

/**
 * Warn without blocking (SHARED_TREE_GUARDS_WARN=1).
 *
 * MEASURED 2026-09-24, and it is the reason this function exists at all: writing to stderr and
 * exiting 0 from a PreToolUse hook puts the text in the transcript and **the model never sees
 * it** — a real `claude -p` run with WARN=1 made the dangerous commit and said nothing about a
 * warning. A documented mode that does nothing is the exact failure D-01 is about. The channel
 * that does reach the model on a non-blocking PreToolUse is `hookSpecificOutput.additionalContext`
 * on stdout, so that is what this sends (stderr too, for a human tailing the terminal).
 */
function warn(msg) {
  const text = String(msg).replace(/\s*$/, '');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
      systemMessage: text,
    })
  );
  process.stderr.write(text + '\n');
  process.exit(0);
}

module.exports = { readPayload, command, effectiveCwd, block, disabled, warnOnly, warn };
