'use strict';

const express = require('express');
const multer = require('multer');
const { query, withTransaction } = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { str, normalizePhone, uuid, ValidationError } = require('../lib/validate');
const { storePhoto, deletePhotos } = require('../lib/photos');
const { VISIT_SELECT, todayClause, decorate } = require('../lib/visitQueries');
const { notifyAdmin } = require('../lib/notify');

const router = express.Router();

// Photos are held in memory only long enough for sharp to normalize them —
// nothing untrusted is ever written to disk in its original form.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxPhotoBytes, files: config.maxCompanions + 1 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) {
      return cb(new ValidationError('Only image files can be uploaded.', 'photo'));
    }
    cb(null, true);
  },
});

const securityOnly = [requireAuth, requireRole('SECURITY')];

/**
 * Reuses an existing visitor row when the phone number matches, so repeat visitors
 * accumulate history under one identity. Without a phone we cannot safely identify
 * anyone, so each visit gets a fresh visitor row.
 */
async function resolveVisitor(client, { fullName, phone }) {
  if (phone) {
    const existing = await client.query(
      'SELECT id, full_name FROM visitors WHERE phone = $1 ORDER BY created_at LIMIT 1',
      [phone]
    );
    if (existing.rowCount > 0) {
      const visitor = existing.rows[0];
      if (visitor.full_name !== fullName) {
        await client.query('UPDATE visitors SET full_name = $1 WHERE id = $2', [fullName, visitor.id]);
      }
      return visitor.id;
    }
  }
  const inserted = await client.query(
    'INSERT INTO visitors (full_name, phone) VALUES ($1, $2) RETURNING id',
    [fullName, phone]
  );
  return inserted.rows[0].id;
}

function parseCompanionNames(raw, expectedCount) {
  if (expectedCount === 0) return [];
  let names;
  try {
    names = JSON.parse(raw || '[]');
  } catch (err) {
    throw new ValidationError('Companion details could not be read.', 'companions');
  }
  if (!Array.isArray(names) || names.length !== expectedCount) {
    throw new ValidationError('Each additional member needs both a name and a photo.', 'companions');
  }
  return names.map((entry, i) => {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    return str(name, `Member ${i + 1} name`, { required: true, max: 120 });
  });
}

// POST /api/visits — create a PENDING visit. Multipart: primary photo (required) + companion photos.
router.post(
  '/',
  ...securityOnly,
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'companion_photos', maxCount: config.maxCompanions },
  ]),
  async (req, res, next) => {
    const stored = [];
    try {
      const files = req.files || {};
      const primary = (files.photo || [])[0];
      if (!primary) throw new ValidationError("The visitor's photo is required.", 'photo');

      const fullName = str(req.body.full_name, 'Visitor name', { required: true, max: 150 });
      const phone = normalizePhone(req.body.phone, 'Phone number');
      const purpose = str(req.body.purpose, 'Purpose', { max: 500 });
      const hostAdminId = uuid(req.body.host_admin_id, 'Host');
      const hostName = str(req.body.host_name, 'Host name', { max: 150 });

      if (!hostAdminId && !hostName) {
        throw new ValidationError('Select whom the visitor has come to see.', 'host');
      }

      // A host_admin_id that is not actually an active admin would produce a visit
      // nobody can act on, so verify it before writing anything.
      if (hostAdminId) {
        const host = await query(
          "SELECT id FROM users WHERE id = $1 AND is_active = true AND role IN ('ADMIN', 'SUPERADMIN')",
          [hostAdminId]
        );
        if (host.rowCount === 0) throw new ValidationError('That host is not available.', 'host');
      }

      const companionFiles = files.companion_photos || [];
      const companionNames = parseCompanionNames(req.body.companions, companionFiles.length);

      const primaryPhoto = await storePhoto(primary.buffer);
      stored.push(primaryPhoto);
      const companionPhotos = [];
      for (const file of companionFiles) {
        const name = await storePhoto(file.buffer);
        stored.push(name);
        companionPhotos.push(name);
      }

      const visitId = await withTransaction(async (client) => {
        const visitorId = await resolveVisitor(client, { fullName, phone });

        const { rows } = await client.query(
          `INSERT INTO visits
             (visitor_id, photo_path, purpose, host_admin_id, host_name, logged_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
           RETURNING id`,
          [visitorId, primaryPhoto, purpose, hostAdminId, hostAdminId ? null : hostName, req.user.id]
        );
        const id = rows[0].id;

        for (let i = 0; i < companionNames.length; i += 1) {
          await client.query(
            'INSERT INTO visit_companions (visit_id, name, photo_path) VALUES ($1, $2, $3)',
            [id, companionNames[i], companionPhotos[i]]
          );
        }

        await client.query(
          `INSERT INTO visit_events (visit_id, actor_id, action, detail)
           VALUES ($1, $2, 'CREATED', $3)`,
          [
            id,
            req.user.id,
            JSON.stringify({
              visitor_name: fullName,
              phone,
              purpose,
              companions: companionNames.length,
              host: hostAdminId ? { admin_id: hostAdminId } : { name: hostName },
            }),
          ]
        );

        return id;
      });

      const { rows } = await query(`${VISIT_SELECT} WHERE v.id = $1`, [visitId]);
      const visit = decorate(rows[0]);

      notifyAdmin(visit, { hostAdmin: null }).catch(() => {});
      res.status(201).json({ visit });
    } catch (err) {
      // The photos are already on disk but the row never landed — do not leave orphans.
      await deletePhotos(stored);
      next(err);
    }
  }
);

// GET /api/visits/today — today's gate log.
router.get('/today', ...securityOnly, async (req, res, next) => {
  try {
    const { rows } = await query(
      `${VISIT_SELECT} WHERE ${todayClause(1)} ORDER BY v.created_at DESC`,
      [config.timezone]
    );
    res.json({ visits: rows.map(decorate) });
  } catch (err) {
    next(err);
  }
});

/**
 * Advances a visit's status only from the exact state that permits it. The
 * conditional UPDATE is the concurrency control: if it matches nothing, another
 * device already moved this visit and we report the current state instead of
 * overwriting it.
 */
async function transition(req, res, next, { from, to, setSql, action }) {
  try {
    const visitId = uuid(req.params.id, 'Visit', { required: true });

    const updated = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE visits SET status = $1, ${setSql} WHERE id = $2 AND status = $3 RETURNING id`,
        [to, visitId, from]
      );
      if (rows.length === 0) return null;

      await client.query(
        `INSERT INTO visit_events (visit_id, actor_id, action, detail) VALUES ($1, $2, $3, $4)`,
        [visitId, req.user.id, action, JSON.stringify({ from, to })]
      );
      return rows[0].id;
    });

    const { rows } = await query(`${VISIT_SELECT} WHERE v.id = $1`, [visitId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'That visit no longer exists.' });
    }

    if (!updated) {
      return res.status(409).json({
        error: 'INVALID_STATE',
        message: `This visit is already marked ${rows[0].status.toLowerCase().replace('_', ' ')}.`,
        visit: decorate(rows[0]),
      });
    }

    res.json({ visit: decorate(rows[0]) });
  } catch (err) {
    next(err);
  }
}

router.post('/:id/check-in', ...securityOnly, (req, res, next) =>
  transition(req, res, next, {
    from: 'APPROVED',
    to: 'INSIDE',
    setSql: 'checked_in_at = now()',
    action: 'CHECKED_IN',
  })
);

// One check-out covers the whole group — companions are not tracked separately.
router.post('/:id/check-out', ...securityOnly, (req, res, next) =>
  transition(req, res, next, {
    from: 'INSIDE',
    to: 'CHECKED_OUT',
    setSql: 'checked_out_at = now()',
    action: 'CHECKED_OUT',
  })
);

module.exports = router;
