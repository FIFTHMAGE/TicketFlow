const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'stableflow_super_secret_payout_ledger';

function requireAdmin(req, res, next) {
  let token = null;

  // 1. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // 2. Check cookies
  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const parts = c.trim().split('=');
      acc[parts[0]] = parts[1];
      return acc;
    }, {});
    token = cookies['admin_token'];
  }

  // 3. Check query param (fallback for initial static page loads)
  if (!token && req.query.token) {
    token = req.query.token;
  }
  
  if (!token) {
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded; // { username, role }
    next();
  } catch (err) {
    if (req.accepts('html')) {
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'invalid token' });
  }
}

// Role Gating
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
  JWT_SECRET
};
