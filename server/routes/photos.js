'use strict';

const express = require('express');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { isValidPhotoName, photoPath } = require('../lib/photos');

const router = express.Router();

/**
 * GET /api/photos/:filename
 * Visitor photos are personal data, so they are never exposed as static files.
 * Any authenticated role may view them (security needs to confirm the person at
 * the gate, admins need to see who they are approving).
 */
router.get('/:filename', requireAuth, (req, res) => {
  const { filename } = req.params;

  // Strict allowlist rather than path sanitisation: we generate every legitimate
  // name ourselves, so anything not matching that shape is hostile.
  if (!isValidPhotoName(filename)) {
    return res.status(400).json({ error: 'BAD_FILENAME' });
  }

  const file = photoPath(filename);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  // Photo bytes never change once written, but they must not linger in shared caches.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

module.exports = router;
