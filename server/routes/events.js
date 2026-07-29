'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { bus, matches } = require('../lib/events');

const router = express.Router();

/**
 * GET /api/events — Server-Sent Events stream for the authenticated user.
 *
 * The client opens this once and leaves it open; the server writes a line the
 * moment anything relevant to this user's role happens. The browser's
 * EventSource reconnects on its own if the connection drops.
 *
 * `X-Accel-Buffering: no` tells nginx not to buffer this response, so events are
 * flushed straight through the shared proxy without any nginx config change. A
 * comment ping every 25s keeps the connection under nginx's 120s read timeout
 * and detects dead sockets.
 */
router.get('/', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // No socket timeout — this response is meant to stay open.
  req.socket.setTimeout(0);
  res.flushHeaders();
  res.write('retry: 5000\n\n'); // ask the browser to reconnect after 5s if dropped
  res.write(': connected\n\n');

  const user = req.user;

  const onEvent = (event) => {
    if (!matches(event, user)) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data || {})}\n\n`);
  };

  bus.on('event', onEvent);

  const keepAlive = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 25000);

  const cleanup = () => {
    clearInterval(keepAlive);
    bus.off('event', onEvent);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
});

module.exports = router;
