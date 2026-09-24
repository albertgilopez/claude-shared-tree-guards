#!/usr/bin/env node
'use strict';
/**
 * cotenancy.cjs — SessionStart / SessionEnd handler, and the CLI the other guards' tests use.
 *
 * DR-6: this NEVER blocks. Sharing a working tree can be deliberate; what it does is tell you,
 * once, at the start, and switch the other two guards on. With one session it says nothing at
 * all — which is what makes this plugin safe to publish: for almost every installation it is
 * indistinguishable from not having it.
 *
 *   node cotenancy.cjs --list                  # human list of live sessions in this repo
 *   node cotenancy.cjs --list --json           # { state, others }
 *   node cotenancy.cjs --list --scope tree     # only sessions sharing this working tree
 */
const sessions = require('../lib/sessions.cjs');
const { readPayload } = require('../lib/payload.cjs');

function since(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function banner(res) {
  const n = res.others.length;
  const oldest = res.others
    .map((o) => o.startedAt)
    .sort()[0];
  return [
    `⚠️  shared working tree: ${n} other Claude Code session${n > 1 ? 's' : ''} in this clone` +
      (oldest ? ` (oldest started ${since(oldest)} ago)` : ''),
    `    git has ONE index and ONE working tree per clone, so \`git commit\` without \`-- <paths>\``,
    `    and \`git checkout <ref> -- <path>\` can take or destroy their work.`,
    `    shared-tree-guards is active for this session. Escape: SHARED_TREE_GUARDS_OFF=1`,
  ].join('\n');
}

// ---------------------------------------------------------------- CLI
if (process.argv.includes('--list')) {
  const payload = {
    cwd: process.env.SHARED_TREE_GUARDS_CWD || process.cwd(),
    session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
  };
  const si = process.argv.indexOf('--scope');
  const scope = si >= 0 ? process.argv[si + 1] : 'clone';
  const res = sessions.state(payload, Date.now(), { scope });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ state: res.state, others: res.others.length, entries: res.others }));
  } else if (res.state === 'shared') {
    console.log(banner(res));
    for (const o of res.others) console.log(`    · ${o.id} pid ${o.pid} · ${o.cwd} · started ${since(o.startedAt)} ago`);
  } else {
    console.log(`${res.state}: no other live session in this clone`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- hook
readPayload((payload) => {
  const event = payload.hook_event_name || '';
  if (event === 'SessionEnd') {
    sessions.unregister(payload);
    process.exit(0);
  }
  // SessionStart (and anything else): register, then report only if shared.
  const res = sessions.state(payload);           // who was here BEFORE us
  sessions.register(payload);
  if (res.state === 'shared') {
    process.stdout.write(banner(res) + '\n');    // additionalContext for the session
  }
  process.exit(0);                                // DR-6: never 2
});
