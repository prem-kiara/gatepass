'use strict';

/**
 * Idempotent superadmin seed. Creates the account only when the username is absent,
 * so re-running on every deploy never overwrites a rotated password.
 */

const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const config = require('./config');

async function run() {
  const { username, password, name } = config.seed;

  if (!password) {
    console.error('[seed] SEED_ADMIN_PASS is not set — refusing to create an account without a password.');
    process.exit(1);
  }
  if (password.length < 8 || password.includes('CHANGE_ME')) {
    console.error('[seed] SEED_ADMIN_PASS must be a real password of at least 8 characters.');
    process.exit(1);
  }

  const existing = await pool.query('SELECT id, role FROM users WHERE username = $1', [username]);
  if (existing.rowCount > 0) {
    console.log(`[seed] user "${username}" already exists (${existing.rows[0].role}) — leaving it untouched.`);
    await pool.end();
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO users (name, username, password_hash, role)
     VALUES ($1, $2, $3, 'SUPERADMIN')
     RETURNING id`,
    [name, username, hash]
  );

  console.log(`[seed] created SUPERADMIN "${username}" (${rows[0].id}).`);
  console.log('[seed] Log in and change this password immediately.');
  await pool.end();
}

run().catch((err) => {
  console.error('[seed] error:', err.message);
  process.exit(1);
});
