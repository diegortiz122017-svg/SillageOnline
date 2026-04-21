'use strict';

// ─── Environment validation ───────────────────────────────────────────────────
const required = ['SESSION_SECRET', 'MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length && process.env.NODE_ENV === 'production') {
  console.error(`🚨 Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── App ──────────────────────────────────────────────────────────────────────
const PORT     = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD  = NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || 'https://sillage-sv.com';

// ─── Auth ─────────────────────────────────────────────────────────────────────
const SESSION_SECRET      = process.env.SESSION_SECRET || null;
const SESSION_TTL_ADMIN   = 8  * 60 * 60 * 1000;   // 8 hours
const SESSION_TTL_CUSTOMER = 60 * 24 * 60 * 60 * 1000; // 60 days

// ─── Database ─────────────────────────────────────────────────────────────────
const DB = {
  host:     process.env.MYSQL_HOST,
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl:      process.env.MYSQLSSL_CA
    ? { ca: process.env.MYSQLSSL_CA, rejectUnauthorized: true, minVersion: 'TLSv1.2' }
    : undefined,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 10000,
};

// ─── Email ────────────────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const FROM_EMAIL     = process.env.FROM_EMAIL || 'noreply@sillage-sv.com';
const EMAIL_HOLA     = process.env.EMAIL_HOLA    || 'hola@sillage-sv.com';
const EMAIL_PEDIDOS  = process.env.EMAIL_PEDIDOS || 'pedidos@sillage-sv.com';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || null; // email to receive new order alerts

// ─── Payments ─────────────────────────────────────────────────────────────────
const WOMPI_CLIENT_ID     = process.env.WOMPI_CLIENT_ID     || null;
const WOMPI_CLIENT_SECRET = process.env.WOMPI_CLIENT_SECRET || null;
const WOMPI_PUBLIC_KEY    = process.env.WOMPI_PUBLIC_KEY    || null; // pub_... from Wompi panel

// ─── AI ───────────────────────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// ─── Admin ────────────────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || null;
const ADMIN_PASS = process.env.ADMIN_PASS || null;

// ─── Cache TTLs ───────────────────────────────────────────────────────────────
const CACHE_TTL_CATALOGUE  = 5  * 60 * 1000;  // 5 min
const CACHE_TTL_INVENTORY  = 30 * 1000;        // 30 sec (changes frequently)
const CACHE_TTL_PRICING    = 60 * 1000;        // 1 min
const CACHE_TTL_TOOL       = 30 * 60 * 1000;  // 30 min (Nez tool results)
const CACHE_TTL_REPLY      = 60 * 60 * 1000;  // 60 min (Nez reply cache)

// ─── Rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW    = 15 * 60 * 1000;  // 15 min
const RATE_LIMIT_MAX       = 100;
const ANON_SESSION_TTL     = 60 * 60 * 1000;  // 60 min
const ANON_WS_LIMIT        = 3;
const ANON_SOMMELIER_MAX   = 2;

// ─── Sommelier ────────────────────────────────────────────────────────────────
const REG_SOMMELIER_LIMIT  = 4;   // daily consult limit for registered users
const ANON_SOMMELIER_LIMIT = 2;   // daily consult limit for anonymous users

// ─── Brand prestige hierarchy (controls Collections order) ───────────────────
// Edit from admin settings in DB — this is the fallback default
const DEFAULT_BRAND_HIERARCHY = [
  'Maison Francis Kurkdjian', 'Creed', 'Tom Ford', 'Initio',
  'Parfums de Marly', 'Le Labo', 'Vilhelm Parfumerie', 'Mancera',
  'Montale', 'Chanel', 'Dior', 'Hermes', 'Jo Malone',
  'Maison Margiela', 'Prada', 'Jean Paul Gaultier',
  'Al Haramain', 'Lattafa', 'Afnan', 'Armaf', 'Ajmal', 'Zimaya', 'Sospiro',
];

module.exports = {
  PORT, NODE_ENV, IS_PROD, BASE_URL,
  SESSION_SECRET, SESSION_TTL_ADMIN, SESSION_TTL_CUSTOMER,
  DB,
  RESEND_API_KEY, FROM_EMAIL, EMAIL_HOLA, EMAIL_PEDIDOS, ADMIN_NOTIFY_EMAIL,
  WOMPI_CLIENT_ID, WOMPI_CLIENT_SECRET, WOMPI_PUBLIC_KEY,
  OPENAI_API_KEY,
  ADMIN_USER, ADMIN_PASS,
  CACHE_TTL_CATALOGUE, CACHE_TTL_INVENTORY, CACHE_TTL_PRICING,
  CACHE_TTL_TOOL, CACHE_TTL_REPLY,
  RATE_LIMIT_WINDOW, RATE_LIMIT_MAX,
  ANON_SESSION_TTL, ANON_WS_LIMIT, ANON_SOMMELIER_MAX,
  REG_SOMMELIER_LIMIT, ANON_SOMMELIER_LIMIT,
  DEFAULT_BRAND_HIERARCHY,
};
