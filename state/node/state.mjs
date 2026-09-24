#!/usr/bin/env node
/**
 * state/node/state.mjs — the derived half of this repo's digital twin.
 *
 * Everything here is MEASURED at the moment it is asked, never written down and trusted later.
 * The judged half (where we are, what is next, what is blocked) lives in STATED.json with the
 * commit it was written at, so it can visibly go stale.
 *
 *   node state/node/state.mjs            # writes state.json and prints it
 *   node state/node/state.mjs --print    # prints only
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sh = (args, opts = {}) => {
  try {
    return execFileSync(args[0], args.slice(1), { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    return opts.onError === null ? null : String((e.stdout || '') + (e.stderr || '')).trim();
  }
};

function runTests() {
  const cases = sh([process.execPath, 'test/run-cases.mjs']);
  const m = /(\d+) pass · (\d+) fail · (\d+) skip/.exec(cases || '');
  let lib = null;
  const libOut = sh([process.execPath, '--test', 'test/lib.test.mjs']);
  const lm = /# pass (\d+)[\s\S]*# fail (\d+)/.exec(libOut || '');
  if (lm) lib = { pass: Number(lm[1]), fail: Number(lm[2]) };
  return {
    cases: m ? { pass: Number(m[1]), fail: Number(m[2]), skip: Number(m[3]) } : null,
    lib,
  };
}

const manifests = [
  '.claude-plugin/marketplace.json',
  'plugins/shared-tree-guards/.claude-plugin/plugin.json',
  'plugins/shared-tree-guards/hooks/hooks.json',
];

const handlers = ['cotenancy.cjs', 'commit-guard.cjs', 'overwrite-guard.cjs'];

const derived = {
  measured_at: new Date().toISOString(),
  commit: sh(['git', 'rev-parse', 'HEAD'], { onError: null }),
  dirty: (sh(['git', 'status', '--porcelain'], { onError: null }) || '').split('\n').filter(Boolean).length,
  manifests_parse: manifests.every((p) => {
    try { JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); return true; } catch { return false; }
  }),
  handlers_present: Object.fromEntries(
    handlers.map((h) => [h, fs.existsSync(path.join(ROOT, 'plugins/shared-tree-guards/hooks-handlers', h))])
  ),
  cases_declared: (() => {
    const y = fs.readFileSync(path.join(ROOT, 'cases.yaml'), 'utf8');
    return (y.match(/^- id: /gm) || []).length;
  })(),
  tests: runTests(),
};

const out = { derived, stated_file: 'STATED.json' };
if (!process.argv.includes('--print')) {
  fs.writeFileSync(path.join(ROOT, 'state.json'), JSON.stringify(out, null, 2) + '\n');
}
console.log(JSON.stringify(out, null, 2));
