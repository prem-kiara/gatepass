'use strict';

const multer = require('multer');

function notFound(req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
}

/** Single error envelope so the frontend can render `message` for anything. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.name === 'ValidationError') {
    return res.status(400).json({ error: 'VALIDATION', message: err.message, field: err.field });
  }

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That photo is too large. Retake it and try again.'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Too many photos in one request.'
        : 'The upload could not be read.';
    return res.status(400).json({ error: 'UPLOAD', message });
  }

  // Postgres unique violation — usually a username taken between check and insert.
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'DUPLICATE', message: 'That record already exists.' });
  }

  // Deliberate client errors thrown deeper in the stack (a rejected passkey, an
  // incomplete push subscription) carry their own status. Without this they were
  // all reported as 500 — which reads as "our bug" for what is really bad input,
  // and buries genuine faults among them in the logs.
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({
      error: err.code || 'REQUEST_REJECTED',
      message: err.message || 'That request could not be completed.',
    });
  }

  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
}

module.exports = { notFound, errorHandler };
