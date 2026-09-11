'use strict';

/**
 * Realistic demo traffic for the superadmin dashboard: ~120 days of visits with
 * repeat visitors, companies (including inconsistent spellings), government
 * bodies, private visits, free-text hosts, companions, rejections, and the
 * unfinished records real gates leave behind (never checked out / in).
 *
 * The e2e suite loads this before checking that every dashboard number opens a
 * list of exactly that many visits — sparse data, where every bucket is "1",
 * would let a reconciliation bug hide.
 *
 * REFUSES to run unless the database name ends in _dev or _test. It must never
 * be pointed at production.
 *
 *   node test/seed-demo.js
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const config = require('../server/config');
const { pool } = require('../server/db');

const dbName = new URL(config.databaseUrl).pathname.replace(/^\//, '');
if (!/(_dev|_test)$/.test(dbName)) {
  console.error(`[seed-demo] refusing to seed "${dbName}" — only *_dev or *_test databases.`);
  process.exit(1);
}

// Deterministic, so a failing reconciliation reproduces run to run.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260911);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

const FIRST = ['Suresh', 'Lakshmi', 'Arun', 'Priya', 'Karthik', 'Meena', 'Ramesh', 'Divya', 'Senthil', 'Anitha',
  'Vijay', 'Kavitha', 'Ganesh', 'Revathi', 'Murali', 'Deepa', 'Bala', 'Sangeetha', 'Prakash', 'Uma',
  'Rajesh', 'Nithya', 'Saravanan', 'Gayathri', 'Mohan', 'Swathi', 'Venkat', 'Radha', 'Dinesh', 'Keerthi'];
const LAST = ['Kumar', 'Raman', 'Iyer', 'Natarajan', 'Subramanian', 'Pillai', 'Rao', 'Krishnan', 'S', 'M'];
// Deliberately inconsistent spellings: the dashboard must group these together.
const COMPANIES = [
  ['Kiara Global Services', ['Kiara Global Services', 'kiara global services', ' Kiara Global Services ']],
  ['Axis Bank', ['Axis Bank', 'AXIS BANK']],
  ['Tata Consultancy Services', ['Tata Consultancy Services']],
  ['HDFC Ergo', ['HDFC Ergo', 'Hdfc Ergo']],
  ['Zoho', ['Zoho']],
  ['Sundaram Finance', ['Sundaram Finance']],
  ['L&T Finance', ['L&T Finance']],
  ['Infosys', ['Infosys']],
  ['Muthoot Fincorp', ['Muthoot Fincorp']],
  ['Chola MS', ['Chola MS']],
];
const GOVT = ['Income Tax Department', 'GST Office', 'Corporation of Chennai', 'Police — B2 Station'];
const FREE_HOSTS = ['Accounts Desk', 'accounts desk', 'HR', 'Reception', 'Legal'];
const PURPOSES = ['Loan enquiry', 'Document submission', 'Meeting', 'Delivery', 'Audit', 'Interview', 'Payment', 'Site visit'];
const HOURS = [[8, 1], [9, 2], [10, 5], [11, 6], [12, 4], [13, 1], [14, 3], [15, 5], [16, 4], [17, 3], [18, 1], [19, 1]];

const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pad = (n) => String(n).padStart(2, '0');
// Gate-local wall time -> absolute instant (IST has no DST, so +05:30 is exact).
const at = (day, h, m) => new Date(`${day}T${pad(h)}:${pad(m)}:00+05:30`);
const plusMin = (d, min) => new Date(d.getTime() + min * 60000);

async function makePhotos() {
  const sharp = require('../server/node_modules/sharp');
  fs.mkdirSync(config.photoDir, { recursive: true });
  const colours = ['#c0392b', '#2471a3', '#1e8449', '#b9770e', '#7d3c98', '#117a65', '#a04000', '#2e4053'];
  const names = [];
  for (const c of colours) {
    const name = `${crypto.randomUUID()}.jpg`;
    await sharp({ create: { width: 480, height: 600, channels: 3, background: c } })
      .jpeg({ quality: 70 }).toFile(path.join(config.photoDir, name));
    names.push(name);
  }
  return names;
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: users } = await client.query(
      "SELECT id, role FROM users WHERE is_active AND role IN ('SECURITY', 'ADMIN', 'SUPERADMIN')"
    );
    const guards = users.filter((u) => u.role === 'SECURITY').map((u) => u.id);
    const approvers = users.filter((u) => u.role !== 'SECURITY').map((u) => u.id);
    if (!guards.length || !approvers.length) throw new Error('need at least one active guard and one approver');

    const photos = await makePhotos();
    const today = todayLocal();
    const nowLocalHour = Number(new Date().toLocaleString('en-GB', { timeZone: config.timezone, hour: '2-digit', hour12: false }));

    await client.query('BEGIN');

    // A pool of people; the first 15 are regulars who come back.
    const people = [];
    for (let i = 0; i < 70; i += 1) {
      const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
      const phone = i < 48 ? `9${String(800000000 + i * 7919).slice(0, 9)}` : null;
      people.push({ name, phone, id: null });
    }
    async function visitorFor(p) {
      if (p.phone && p.id) return p.id;
      const { rows } = await client.query('INSERT INTO visitors (full_name, phone) VALUES ($1, $2) RETURNING id', [p.name, p.phone]);
      if (p.phone) p.id = rows[0].id; // no phone -> a new person every time, as at the real gate
      return rows[0].id;
    }

    let visits = 0;
    for (let back = 120; back >= 0; back -= 1) {
      const day = addDays(today, -back);
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 Sun
      let n = dow === 0 ? (chance(0.3) ? 1 : 0) : dow === 6 ? 2 : 4;
      if (back < 30) n += 1; // busier lately
      n = Math.max(0, n + Math.floor(rnd() * 3) - 1);

      for (let k = 0; k < n; k += 1) {
        let hour = weighted(HOURS);
        if (back === 0) {
          if (nowLocalHour < 8) continue;
          hour = Math.min(hour, nowLocalHour);
        }
        const created = at(day, hour, Math.floor(rnd() * 60));
        if (created > new Date()) continue;

        const person = chance(0.45) ? people[Math.floor(rnd() * 15)] : pick(people);
        const visitorId = await visitorFor(person);

        let fromType = weighted([['COMPANY', 50], ['PRIVATE', 25], ['GOVERNMENT', 10], [null, back > 60 ? 15 : 0]]);
        let fromDetail = null;
        if (fromType === 'COMPANY') fromDetail = chance(0.06) ? null : pick(pick(COMPANIES)[1]);
        if (fromType === 'GOVERNMENT') fromDetail = pick(GOVT);
        if (fromType === 'PRIVATE' && chance(0.3)) fromDetail = pick(['Relative of Meena', 'Personal', 'Friend of Arun']);

        const staffHost = chance(0.7);
        const hostAdmin = staffHost ? pick(approvers) : null;
        const hostName = staffHost ? null : pick(FREE_HOSTS);

        // Outcome, including the unfinished records a real gate leaves behind.
        let status;
        if (back === 0) status = weighted([['PENDING', 2], ['APPROVED', 2], ['INSIDE', 3], ['CHECKED_OUT', 3], ['REJECTED', 1]]);
        else status = weighted([['CHECKED_OUT', 72], ['INSIDE', 8], ['APPROVED', 10], ['REJECTED', 7]]);

        const decider = status === 'PENDING' ? null : pick(approvers);
        const decisionAt = decider ? plusMin(created, 1 + Math.floor(rnd() * rnd() * 45)) : null;
        const checkedIn = ['INSIDE', 'CHECKED_OUT'].includes(status) ? plusMin(decisionAt, 1 + Math.floor(rnd() * 5)) : null;
        const checkedOut = status === 'CHECKED_OUT' ? plusMin(checkedIn, 20 + Math.floor(rnd() * 160)) : null;
        const cap = (d) => (d && d > new Date() ? new Date() : d);

        const { rows } = await client.query(
          `INSERT INTO visits (visitor_id, photo_path, purpose, from_type, from_detail, host_admin_id, host_name,
                               logged_by, status, approved_by, decision_at, rejection_reason,
                               checked_in_at, checked_out_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [visitorId, pick(photos), pick(PURPOSES), fromType, fromDetail, hostAdmin, hostName,
            pick(guards), status, decider, cap(decisionAt), status === 'REJECTED' ? 'No appointment' : null,
            cap(checkedIn), cap(checkedOut), created]
        );
        const visitId = rows[0].id;

        const members = weighted([[0, 65], [1, 20], [2, 10], [3, 5]]);
        for (let m = 0; m < members; m += 1) {
          await client.query(
            'INSERT INTO visit_companions (visit_id, name, photo_path, position, created_at) VALUES ($1,$2,$3,$4,$5)',
            [visitId, `${pick(FIRST)} ${pick(LAST)}`, pick(photos), m + 1, created]
          );
        }

        const ev = [['CREATED', pick(guards), created]];
        if (decider) ev.push([status === 'REJECTED' ? 'REJECTED' : 'APPROVED', decider, cap(decisionAt)]);
        if (checkedIn) ev.push(['CHECKED_IN', pick(guards), cap(checkedIn)]);
        if (checkedOut) ev.push(['CHECKED_OUT', pick(guards), cap(checkedOut)]);
        for (const [action, actor, when] of ev) {
          await client.query('INSERT INTO visit_events (visit_id, actor_id, action, at) VALUES ($1,$2,$3,$4)', [visitId, actor, action, when]);
        }
        visits += 1;
      }
    }

    await client.query('COMMIT');
    console.log(`[seed-demo] ${dbName}: ${visits} visits over 121 days, ${photos.length} photos`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[seed-demo] failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
