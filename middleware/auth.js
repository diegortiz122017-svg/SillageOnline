'use strict';

const crypto = require('crypto');
const db     = require('../services/db');
const cfg    = require('../config');

// ─── Ephemeral secret fallback ────────────────────────────────────────────────
if (!cfg.SESSION_SECRET || cfg.SESSION_SECRET.length < 32) {
  if (cfg.IS_PROD) {
    console.error('🚨 FATAL: SESSION_SECRET must be set (min 32 chars) in production.');
    process.exit(1);
  }
  console.warn('⚠️  SESSION_SECRET not set — using ephemeral secret. Sessions reset on server restart.');
}

const _SECRET = cfg.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ─── In-memory revocation set (also persisted in DB) ─────────────────────────
const _revoked = new Set();

function _b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function _sign(payload) {
  return crypto.createHmac('sha256', _SECRET).update(payload).digest('hex');
}

// ─── Session CRUD ─────────────────────────────────────────────────────────────
function createSession(user, role = 'admin') {
  const ttl       = role === 'customer' ? cfg.SESSION_TTL_CUSTOMER : cfg.SESSION_TTL_ADMIN;
  const jti       = crypto.randomBytes(16).toString('hex');
  const payload   = { user, role, createdAt: Date.now(), ttl, jti };
  const encoded   = _b64url(JSON.stringify(payload));
  const sig       = _sign(encoded);
  return `${encoded}.${sig}`;
}

function validateSession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;

  const encoded = token.slice(0, dot);
  const sig     = token.slice(dot + 1);

  // Timing-safe signature check
  const expected = _sign(encoded);
  try {
    const sigBuf = Buffer.from(sig,      'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  } catch { return null; }

  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString()); }
  catch { return null; }

  // TTL check
  if (Date.now() - parsed.createdAt > parsed.ttl) return null;

  // Revocation check
  if (_revoked.has(parsed.jti)) return null;

  return parsed;
}

function destroySession(token) {
  if (!token) return;
  const dot = token.lastIndexOf('.');
  try {
    const payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString());
    if (payload.jti) {
      _revoked.add(payload.jti);
      const ttlRemaining = Math.max(0, payload.ttl - (Date.now() - payload.createdAt));
      db.execute(
        `INSERT INTO settings (key_name, value, updated_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
        [`revoked:${payload.jti}`, '1', new Date()]
      ).catch(() => {});
      // Auto-cleanup after TTL expires
      if (ttlRemaining > 0) setTimeout(() => _revoked.delete(payload.jti), ttlRemaining).unref();
    }
  } catch { /* ignore */ }
}

// ─── Restore revocations from DB on startup ───────────────────────────────────
async function restoreRevocations() {
  try {
    const [rows] = await db.execute(
      "SELECT key_name FROM settings WHERE key_name LIKE 'revoked:%'"
    );
    rows.forEach(r => _revoked.add(r.key_name.replace('revoked:', '')));
    if (rows.length) console.log(`✅ Restored ${rows.length} revoked token(s)`);
  } catch(e) { console.warn('Could not restore revocations:', e.message); }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const session = validateSession(req.headers['x-session-token']);
  if (!session || session.role !== 'admin') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.adminSession = session;
  next();
}

function requireCustomer(req, res, next) {
  const token   = req.headers['x-customer-token'];
  const session = validateSession(token);
  if (!session || session.role !== 'customer') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.customerSession = session;
  req.customer = session; // backwards compat — routes use req.customer.user.id
  // Refresh last_login from real activity, not just explicit password logins —
  // throttled to once per 30min per customer (WHERE clause, no extra read) so
  // it doesn't add a write to every authenticated request. Fire-and-forget:
  // never block the response on it.
  if (session.user && session.user.id) {
    db.execute(
      `UPDATE customers SET last_login=NOW() WHERE id=? AND (last_login IS NULL OR last_login < DATE_SUB(NOW(), INTERVAL 30 MINUTE))`,
      [session.user.id]
    ).catch(() => {});
  }
  next();
}

function optionalCustomer(req, res, next) {
  const token   = req.headers['x-customer-token'];
  const session = token ? validateSession(token) : null;
  req.customerSession = (session?.role === 'customer') ? session : null;
  req.customer = req.customerSession; // backwards compat
  next();
}

module.exports = {
  createSession,
  validateSession,
  destroySession,
  restoreRevocations,
  requireAdmin,
  requireCustomer,
  optionalCustomer,
};
