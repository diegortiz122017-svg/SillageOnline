'use strict';

const crypto = require('crypto');
const cfg    = require('../config');

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = new Set([
  cfg.BASE_URL,
  cfg.BASE_URL.replace('https://', 'https://www.'),
]);

function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-session-token,x-customer-token,x-anon-session');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ─── Security headers ─────────────────────────────────────────────────────────
function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://static.cloudflareinsights.com https://checkout.wompi.sv https://teyko.app; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https://res.cloudinary.com https://btcpay.davidcoen.it; " +
    "frame-src https://checkout.wompi.sv; " +
    "connect-src 'self' wss://sillage-sv.com wss: https://api.wompi.sv https://id.wompi.sv https://checkout.wompi.sv https://cloudflareinsights.com https://api.openai.com https://api.teyko.app wss://api.teyko.app https://gentle-rebirth-production.up.railway.app wss://gentle-rebirth-production.up.railway.app; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self' https://checkout.wompi.sv; " +
    "upgrade-insecure-requests;"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (cfg.IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ─── HTTPS redirect ───────────────────────────────────────────────────────────
function httpsRedirect(req, res, next) {
  if (!cfg.IS_PROD) return next();
  if (req.path === '/api/health') return next();
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
}

// ─── Global rate limiter ──────────────────────────────────────────────────────
const _rlStore = new Map();

function rateLimit({ max = cfg.RATE_LIMIT_MAX, window = cfg.RATE_LIMIT_WINDOW } = {}) {
  return (req, res, next) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded
      ? forwarded.split(',').map(s => s.trim()).pop()
      : req.socket.remoteAddress;

    const now   = Date.now();
    const entry = _rlStore.get(ip) || { count: 0, start: now };

    if (now - entry.start > window) {
      entry.count = 0;
      entry.start = now;
    }
    entry.count++;
    _rlStore.set(ip, entry);

    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — please wait.' });
    }
    next();
  };
}

const authLimiter = rateLimit({ max: 10, window: 15 * 60 * 1000 });

setInterval(() => {
  const cutoff = Date.now() - cfg.RATE_LIMIT_WINDOW;
  for (const [ip, entry] of _rlStore) {
    if (entry.start < cutoff) _rlStore.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ─── Request size limit ───────────────────────────────────────────────────────
const bodyLimit = '50kb';

// ─── IP extraction helper ─────────────────────────────────────────────────────
function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded
    ? forwarded.split(',').map(s => s.trim()).pop()
    : req.socket.remoteAddress;
}

// Customer auth limiter — keyed by EMAIL not IP.
const _customerRlStore = new Map();
function customerAuthLimiter(req, res, next) {
  const email  = String((req.body && req.body.email) || '').toLowerCase().trim();
  const key    = email || 'anon';
  const MAX    = 10;
  const WINDOW = 15 * 60 * 1000;
  const now    = Date.now();
  const entry  = _customerRlStore.get(key) || { count: 0, start: now };
  if (now - entry.start > WINDOW) { entry.count = 0; entry.start = now; }
  entry.count++;
  _customerRlStore.set(key, entry);
  if (entry.count > MAX) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  }
  next();
}

module.exports = {
  cors,
  securityHeaders,
  httpsRedirect,
  rateLimit,
  authLimiter,
  customerAuthLimiter,
  bodyLimit,
  getIp,
};
