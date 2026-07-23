const jwt = require('jsonwebtoken');

// Refuse to start in production with default secret
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const DEFAULT_SECRET = 'stableflow_super_secret_payout_ledger';

if (!JWT_SECRET) {
  console.warn('[AUTH] WARNING: ADMIN_JWT_SECRET not set. Using insecure default. Set this env var before deploying.');
}

const EFFECTIVE_JWT_SECRET = JWT_SECRET || DEFAULT_SECRET;

if (process.env.NODE_ENV === 'production' && EFFECTIVE_JWT_SECRET === DEFAULT_SECRET) {
  console.error('[AUTH] FATAL: Cannot use default JWT secret in production. Set ADMIN_JWT_SECRET.');
  process.exit(1);
}

function requireAdmin(req, res, next) {
  let token = null;

  // 1. Check Authorization header (preferred — tokens stay out of logs)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // 2. Check HttpOnly cookie
  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const parts = c.trim().split('=');
      acc[parts[0]] = parts.slice(1).join('=');
      return acc;
    }, {});
    token = cookies['admin_token'];
  }

  if (!token) {
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    req.admin = decoded; // { username, role }
    next();
  } catch (err) {
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'invalid token' });
  }
}

// Role Gating middleware factory
function requireRole(role) {
  return (req, res, next) => {
    requireAdmin(req, res, () => {
      if (req.admin && req.admin.role === role) {
        next();
      } else {
        res.status(403).json({ error: `Forbidden: Requires ${role} role` });
      }
    });
  };
}

module.exports = {
  requireAdmin,
  requireRole,
  JWT_SECRET: EFFECTIVE_JWT_SECRET
};
