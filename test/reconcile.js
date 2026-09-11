'use strict';

/**
 * Proves every number on the superadmin dashboard opens a list of exactly that
 * many visits (or people) — the contract documented in server/lib/insights.js.
 *
 * Walks each insights payload, finds every `{ value, drill }` pair, requests the
 * drill, and compares. Also checks the parts add up to the whole (per-day bars,
 * the weekday x hour grid and the visiting-from split must each sum to the
 * headline), then does the same for the people directory and person pages.
 *
 * Two modes, same checks:
 *   node test/reconcile.js --api http://127.0.0.1:3040/api --user superadmin --pass ...
 *       over HTTP, as the dashboard itself calls it (used by test/e2e.sh)
 *   node test/reconcile.js --direct
 *       in-process against the database, no login needed — for read-only
 *       verification on the production VM. It only ever reads.
 */

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const DIRECT = args.includes('--direct');

let pass = 0;
let fail = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const bad = (msg) => { fail += 1; console.log(`  FAIL  ${msg}`); };

/* ------------------------------------------------------------- transports */

async function httpClient() {
  const api = opt('api');
  const res = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opt('user'), password: opt('pass') }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const get = async (path, params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const r = await fetch(`${api}${path}?${qs}`, { headers: { cookie } });
    if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
    return r.json();
  };
  return {
    insights: (p) => get('/admin/insights', p),
    visits: (p) => get('/admin/visits', { ...p, limit: 1 }),
    visitors: (p) => get('/admin/visitors', p),
    profile: (id) => get(`/admin/visitors/${id}`),
    close: async () => {},
  };
}

function directClient() {
  const lib = require('../server/lib/insights');
  const { pool } = require('../server/db');
  // Stringify params exactly as a query string would, so the direct path
  // exercises the same parsing the HTTP path does.
  const qs = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
  return {
    insights: (p) => lib.computeInsights(qs(p)),
    visits: (p) => lib.countVisits(qs(p)),
    visitors: (p) => lib.listVisitors(qs(p)),
    profile: (id) => lib.visitorProfile(id),
    close: () => pool.end(),
  };
}

/* ------------------------------------------------------------------ walk */

function pairs(node, path = '$', out = []) {
  if (Array.isArray(node)) node.forEach((n, i) => pairs(n, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    if (node.drill && typeof node.value === 'number') out.push({ path, value: node.value, drill: node.drill });
    for (const [k, v] of Object.entries(node)) if (k !== 'drill') pairs(v, `${path}.${k}`, out);
  }
  return out;
}

async function checkPairs(client, label, payload) {
  const found = pairs(payload);
  let mismatches = 0;
  for (const p of found) {
    const { view, params, measure } = p.drill;
    let got;
    if (view === 'visits') {
      const r = await client.visits(params);
      got = measure === 'people' ? r.people : r.total;
    } else if (view === 'visitors') {
      got = (await client.visitors({ ...params, limit: 1 })).total;
    } else {
      bad(`${label} ${p.path}: unknown drill view "${view}"`);
      mismatches += 1;
      continue;
    }
    if (got !== p.value) {
      mismatches += 1;
      bad(`${label} ${p.path}: shows ${p.value} but its drill-down returns ${got} — ${JSON.stringify(params)}`);
    }
  }
  if (mismatches === 0) ok(`${label}: all ${found.length} numbers match their drill-downs`);
  return found.length;
}

function sums(label, ins) {
  const total = ins.totals.visits.value;
  const parts = {
    'per-day bars': ins.series.reduce((s, b) => s + b.visits.value, 0),
    'weekday x hour grid': ins.heatmap.reduce((s, c) => s + c.visits.value, 0),
    'visiting-from split': ins.from_types.reduce((s, t) => s + t.visits.value, 0),
    'outcome split': ins.totals.approved.value + ins.totals.rejected.value + ins.totals.pending.value,
    'gate staff split': ins.guards.reduce((s, g) => s + g.visits.value, 0),
  };
  const wrong = Object.entries(parts).filter(([, v]) => v !== total);
  if (wrong.length === 0) ok(`${label}: every breakdown adds up to the ${total} visits headline`);
  else wrong.forEach(([name, v]) => bad(`${label}: ${name} sums to ${v}, headline says ${total}`));

  const decided = ins.deciders.reduce((s, d) => s + d.total.value, 0);
  const expected = ins.totals.approved.value + ins.totals.rejected.value;
  if (decided === expected) ok(`${label}: decisions per person add up to ${expected} decided visits`);
  else bad(`${label}: per-decider totals ${decided} != approved+rejected ${expected}`);
}

/* ------------------------------------------------------------------- main */

(async () => {
  const client = DIRECT ? directClient() : await httpClient();
  try {
    let checked = 0;
    for (const preset of ['today', '7d', '30d', '90d', 'month', 'all']) {
      const ins = await client.insights({ preset });
      checked += await checkPairs(client, preset, ins);
      sums(preset, ins);
    }

    // The people directory and a few person pages carry their own drills.
    const dir = await client.visitors({ preset: 'all', limit: 100 });
    const repeaters = dir.visitors.filter((v) => v.visits.value > 1).slice(0, 3);
    const sample = [...new Map([...repeaters, ...dir.visitors.slice(0, 2)].map((v) => [v.visitor_id, v])).values()];
    checked += await checkPairs(client, 'people directory', { rows: dir.visitors });
    for (const v of sample) {
      const prof = await client.profile(v.visitor_id);
      checked += await checkPairs(client, `person ${v.full_name}`, prof);
      const fromSum = prof.from.reduce((s, f) => s + f.visits.value, 0);
      const hostSum = prof.hosts.reduce((s, h) => s + h.visits.value, 0);
      if (fromSum === prof.stats.visits.value && hostSum === prof.stats.visits.value) {
        ok(`person ${v.full_name}: where-from and whom-they-met both add up to ${prof.stats.visits.value} visits`);
      } else {
        bad(`person ${v.full_name}: from=${fromSum} hosts=${hostSum} visits=${prof.stats.visits.value}`);
      }
    }
    console.log(`RECONCILE checked=${checked} passed=${pass} failed=${fail}`);
  } catch (err) {
    bad(`reconcile crashed: ${err.message}`);
    console.log(`RECONCILE checked=0 passed=${pass} failed=${fail}`);
  } finally {
    await client.close();
    process.exitCode = fail ? 1 : 0;
  }
})();
