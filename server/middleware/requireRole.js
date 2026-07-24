'use strict';

/**
 * Route guard. Use after requireAuth: requireRole('ADMIN', 'SUPERADMIN').
 */
function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Your role cannot perform this action.' });
    }
    next();
  };
}

module.exports = { requireRole };
