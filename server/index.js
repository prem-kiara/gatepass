'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { pool } = require('./db');
const { ensurePhotoDir } = require('./lib/photos');
const push = require('./lib/push');
const sweeper = require('./lib/sweeper');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();

// Nginx terminates TLS in front of us; without this, req.ip is always 127.0.0.1
// and the login rate limiter would treat every gate as the same client.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'gatepass' });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  }
});

const approvalsRouter = require('./routes/approvals');

app.use('/api/auth', require('./routes/auth'));
app.use('/api/visits', require('./routes/visits'));
app.use('/api/visitors', require('./routes/visitors'));
app.use('/api/approvals', approvalsRouter);
// The decision endpoints are addressed as /api/visits/:id/approve too — the action
// belongs to the visit. Mounted after the visits router so its own routes match first.
app.use('/api/visits', approvalsRouter);
app.use('/api/photos', require('./routes/photos'));
app.use('/api/events', require('./routes/events'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));

app.use('/api', notFound);

// --- Static SPA -----------------------------------------------------------
const distDir = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(distDir)) {
  // Hashed asset filenames can be cached hard; index.html must not be, or a
  // deploy leaves phones running the previous bundle against the new API.
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\/assets\//.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('*', (req, res) =>
    res.status(503).send('Frontend not built. Run `npm run build` in web/.')
  );
}

app.use(errorHandler);

ensurePhotoDir();

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[gatepass] listening on 127.0.0.1:${config.port} (${config.isProd ? 'production' : 'development'})`);
  console.log(`[gatepass] photos: ${config.photoDir}`);
  if (!push.isConfigured()) {
    console.warn('[gatepass] VAPID keys not set — notifications are recorded in-app but no push is sent. Run `npm run vapid`.');
  }
  sweeper.start();
});

// PM2 sends SIGINT on restart; drain connections so an in-flight approval is not
// cut off mid-transaction.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[gatepass] ${signal} received, shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
