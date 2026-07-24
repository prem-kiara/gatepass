'use strict';

/**
 * Numbered-migration runner. Applies every unapplied file in ./migrations in
 * filename order, each inside its own transaction, recording it in `migrations`.
 * Safe to re-run — this is what deploy.sh calls on every deploy.
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const DIR = path.join(__dirname, 'migrations');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT name FROM migrations')).rows.map((r) => r.name)
    );

    const files = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      process.stdout.write(`[migrate] applying ${file} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('ok');
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }

    console.log(count === 0 ? '[migrate] already up to date' : `[migrate] applied ${count} migration(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[migrate] error:', err.message);
  process.exit(1);
});
