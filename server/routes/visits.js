'use strict';

const express = require('express');
const multer = require('multer');
const { query, withTransaction } = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { str, normalizePhone, uuid, oneOf, ValidationError } = require('../lib/validate');
const { storePhoto, deletePhotos } = require('../lib/photos');
const { VISIT_SELECT, todayClause, decorate, fromDisplay } = require('../lib/visitQueries');
const notify = require('../lib/notify');
const events = require('../lib/events');

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
      // Where the visitor is from: a category, plus a detail naming the specific
      // company or entity. Company and Government must say which; Private need not.
      const fromType = oneOf(req.body.from_type, 'Visiting from', ['COMPANY', 'PRIVATE', 'GOVERNMENT']);
      const fromDetail = str(req.body.from_detail, 'Details', { max: 200 });
      if (fromDetail && !fromType) {
        throw new ValidationError('Choose whether this is a company, private or government visit.', 'from_type');
      }
      if ((fromType === 'COMPANY' || fromType === 'GOVERNMENT') && !fromDetail) {
        throw new ValidationError(
          fromType === 'COMPANY' ? 'Enter which company.' : 'Enter which government entity.',
          'from_detail'
        );
      }
      const hostAdminId = uuid(req.body.host_admin_id, 'Host');
      const hostName = str(req.body.host_name, 'Host name', { max: 150 });

      if (!hostAdminId && !hostName) {
        throw new ValidationError('Select whom the visitor has come to see.', 'host');
      }

      // A host_admin_id that is not actually an active admin would produce a visit
      // nobody can act on, so verify it before writing anything.
      let hostDisplay = hostName;
      if (hostAdminId) {
        const host = await query(
          "SELECT id, name FROM users WHERE id = $1 AND is_active = true AND role IN ('ADMIN', 'SUPERADMIN')",
          [hostAdminId]
        );
        if (host.rowCount === 0) throw new ValidationError('That host is not available.', 'host');
        hostDisplay = host.rows[0].name;
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

      let queuedNotifications = [];
      const visitId = await withTransaction(async (client) => {
        const visitorId = await resolveVisitor(client, { fullName, phone });

        const { rows } = await client.query(
          `INSERT INTO visits
             (visitor_id, photo_path, purpose, from_type, from_detail, host_admin_id, host_name, logged_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING')
           RETURNING id`,
          [visitorId, primaryPhoto, purpose, fromType, fromDetail, hostAdminId, hostAdminId ? null : hostName, req.user.id]
        );
        const id = rows[0].id;

        for (let i = 0; i < companionNames.length; i += 1) {
          // position preserves the order the guard added them; created_at cannot,
          // because every row in this transaction shares one timestamp.
          await client.query(
            'INSERT INTO visit_companions (visit_id, name, photo_path, position) VALUES ($1, $2, $3, $4)',
            [id, companionNames[i], companionPhotos[i], i + 1]
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
              from_type: fromType,
              from_detail: fromDetail,
              companions: companionNames.length,
              host: hostAdminId ? { admin_id: hostAdminId } : { name: hostName },
            }),
          ]
        );

        // Written in this transaction so the alert cannot exist without the
        // visit, or the visit without the alert.
        queuedNotifications = await notify.visitPending(client, {
          id,
          full_name: fullName,
          host_display: hostDisplay,
          purpose,
          from_display: fromDisplay(fromType, fromDetail),
          companion_count: companionNames.length,
          logged_by_name: req.user.name,
        });

        return id;
      });

      const { rows } = await query(`${VISIT_SELECT} WHERE v.id = $1`, [visitId]);
      const visit = decorate(rows[0]);

      // Push only after the commit, and without blocking the response.
      notify.scheduleDelivery(queuedNotifications);
      // Live: the shared pending queue just gained a request.
      events.approvalsChanged({ visitId, action: 'created' });
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
async function transition(req, res, next, { from, to, setSql, action, notifyFn }) {
  try {
    const visitId = uuid(req.params.id, 'Visit', { required: true });

    let queuedNotifications = [];
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

      if (notifyFn) queuedNotifications = (await notifyFn(client, visitId)) || [];
      return rows[0].id;
    });

    if (updated) {
      notify.scheduleDelivery(queuedNotifications);
      // Check-in / check-out changed a visit's status — refresh gate screens live.
      events.gateChanged({ visitId, action });
    }

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
    // Tell the host their visitor is inside and heading over.
    notifyFn: async (client, visitId) => {
      const { rows } = await client.query(
        `SELECT v.id, v.host_admin_id, vis.full_name,
                (SELECT count(*) FROM visit_companions c WHERE c.visit_id = v.id)::int AS companion_count
         FROM visits v JOIN visitors vis ON vis.id = v.visitor_id
         WHERE v.id = $1`,
        [visitId]
      );
      return rows.length ? notify.visitCheckedIn(client, rows[0]) : [];
    },
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
