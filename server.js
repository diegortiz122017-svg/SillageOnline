/*
 ═══════════════════════════════════════════════════════
  SILLAGE PARFUMERIE — Production Server v3.1
  Express + WebSocket + MySQL + OpenAI + Wompi

  See config/index.js for all environment variables.
  See .env.example for setup instructions.
 ═══════════════════════════════════════════════════════
*/
'use strict';

const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const crypto      = require('crypto');
const path        = require('path');
const compression = require('compression');
require('./lib/qr'); // self-contained QR bundle (no npm dep)

// ─── Internal modules ─────────────────────────────────
const cfg          = require('./config');
const db           = require('./services/db');
const catalogueSvc = require('./services/catalogue');
const emailSvc     = require('./services/email');
const dteSvc       = require('./services/dte');
const { Cache }    = require('./services/cache');
const security     = require('./middleware/security');
const auth         = require('./middleware/auth');

// ─── Aliases for backwards compatibility within this file ──────────────────
const { getCatalogue, saveCatalogue, deleteProduct, getInventoryMap, invalidateInventory, getPricingMap, invalidatePricing, getActivity, getSetting, setSetting, getBrandHierarchy } = catalogueSvc;
const { calcIntensity } = require('./services/noteIntensity');
const { calcChords }    = require('./services/chords');

// logActivity also broadcasts to admin WebSocket clients
async function logActivity(msg) {
  await catalogueSvc.logActivity(msg);
  if (typeof broadcastAdmin === 'function') {
    broadcastAdmin('activity', { msg, time: new Date().toLocaleTimeString() });
  }
}
const { requireAdmin, requireCustomer, optionalCustomer, createSession, validateSession, destroySession } = auth;
const { authLimiter, customerAuthLimiter, getIp } = security;
const { ADMIN_USER, ADMIN_PASS, PORT, BASE_URL, OPENAI_API_KEY, WOMPI_CLIENT_ID, WOMPI_CLIENT_SECRET, WOMPI_PUBLIC_KEY, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE, EMAIL_HOLA, EMAIL_PEDIDOS, SESSION_TTL_CUSTOMER, SESSION_TTL_ADMIN, RESEND_API_KEY, NODE_ENV, IS_PROD, ANON_SESSION_TTL, ANON_WS_LIMIT, ANON_SOMMELIER_MAX, REG_SOMMELIER_LIMIT, ANON_SOMMELIER_LIMIT, CACHE_TTL_TOOL, CACHE_TTL_REPLY } = cfg;

// ── BTCPay Server ─────────────────────────────────────
const BTCPAY_URL            = process.env.BTCPAY_URL || 'https://btcpay.davidcoen.it';
const BTCPAY_STORE_ID       = process.env.BTCPAY_STORE_ID;
const BTCPAY_API_KEY        = process.env.BTCPAY_API_KEY;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── Environment ──────────────────────────────────────
// ─── Config loaded from config/index.js ─────────────────────────────────────

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('🚨 FATAL: ADMIN_USER and ADMIN_PASS must be set in environment variables.');
  console.error('   Set them in Railway Variables before deploying to production.');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1); // refuse to start in production without credentials
  }
}

// ─── MySQL connection ────────────────────────────────
// ⚠️  SQL INJECTION PREVENTION — ALL user-supplied values MUST use
//   parameterized queries: db.execute('SELECT * FROM t WHERE id=?', [id])
//   NEVER interpolate user values into query strings.
// Database accessed via services/db.js (pool with keep-alive)


async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id             VARCHAR(40) PRIMARY KEY,
      customer       VARCHAR(255) NOT NULL,
      email          VARCHAR(255) NOT NULL,
      address        TEXT,
      items          LONGTEXT NOT NULL,
      total          DECIMAL(10,2) NOT NULL,
      status         VARCHAR(100) DEFAULT 'Procesando',
      payment_status VARCHAR(100) DEFAULT 'Pendiente',
      tracker_step   INT DEFAULT 0,
      customer_id    INT,
      created_at     DATETIME NOT NULL,
      updated_at     DATETIME NOT NULL,
      INDEX idx_created (created_at DESC),
      INDEX idx_customer (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sent_emails (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      to_email    VARCHAR(255) NOT NULL,
      subject     VARCHAR(255) NULL,
      body_html   LONGTEXT     NULL,
      resend_id   VARCHAR(100) NULL,
      status      VARCHAR(20)  NOT NULL,        -- 'sent' | 'error'
      error       TEXT         NULL,
      created_at  DATETIME NOT NULL,
      INDEX idx_created (created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      code        VARCHAR(30)  NOT NULL UNIQUE,
      type        VARCHAR(10)  NOT NULL,           -- 'percent' | 'fixed'
      value       DECIMAL(10,2) NOT NULL,
      active      TINYINT(1)   DEFAULT 1,
      min_order   DECIMAL(10,2) DEFAULT NULL,       -- subtotal mínimo requerido
      max_uses    INT           DEFAULT NULL,       -- NULL = ilimitado
      used_count  INT           DEFAULT 0,
      expires_at  DATETIME      DEFAULT NULL,       -- NULL = sin vencimiento
      created_at  DATETIME NOT NULL,
      updated_at  DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS inventory (
      product_id   INT PRIMARY KEY,
      stock        INT DEFAULT 99,
      low_stock    TINYINT(1) DEFAULT 0,
      out_of_stock TINYINT(1) DEFAULT 0,
      updated_at   DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS pricing (
      product_id INT PRIMARY KEY,
      sale_price VARCHAR(20) DEFAULT '',
      on_sale    TINYINT(1) DEFAULT 0,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS activity (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      message    TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      INDEX idx_created (created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS customers (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(512) NOT NULL,
      phone         VARCHAR(50) DEFAULT NULL,
      address       VARCHAR(500) DEFAULT NULL,
      city          VARCHAR(100) DEFAULT NULL,
      state         VARCHAR(100) DEFAULT NULL,
      postcode      VARCHAR(20)  DEFAULT NULL,
      country       VARCHAR(100) DEFAULT NULL,
      created_at    DATETIME NOT NULL,
      last_login    DATETIME,
      INDEX idx_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS customer_addresses (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      label       VARCHAR(100) NOT NULL DEFAULT 'Mi dirección',
      line        VARCHAR(500) NOT NULL,
      city        VARCHAR(100) NOT NULL,
      state       VARCHAR(100) DEFAULT NULL,
      postcode    VARCHAR(20)  DEFAULT NULL,
      country     VARCHAR(100) NOT NULL DEFAULT 'El Salvador',
      phone       VARCHAR(50)  DEFAULT NULL,
      is_default  TINYINT      NOT NULL DEFAULT 0,
      created_at  DATETIME     NOT NULL,
      INDEX idx_customer (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS catalogue (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      data       LONGTEXT NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS scent_profiles (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT DEFAULT NULL,
      session_id  VARCHAR(100) DEFAULT NULL,
      profile     LONGTEXT NOT NULL,
      created_at  DATETIME NOT NULL,
      updated_at  DATETIME NOT NULL,
      last_used   DATETIME NOT NULL,
      INDEX idx_customer (customer_id),
      INDEX idx_session  (session_id),
      INDEX idx_last_used (last_used)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Add last_used column to existing table if missing
  try { await db.execute('ALTER TABLE scent_profiles ADD COLUMN last_used DATETIME NOT NULL DEFAULT NOW()'); } catch(e) {}
  // Clean up profiles inactive for 90+ days
  try { await db.execute('DELETE FROM scent_profiles WHERE last_used < DATE_SUB(NOW(), INTERVAL 90 DAY)'); } catch(e) {}
  // "Favoritos de Todos" homepage flag — independent of badge
  try { await db.execute('ALTER TABLE products ADD COLUMN home_favorite TINYINT(1) DEFAULT 0'); } catch(e) {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bundles (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      items       LONGTEXT NOT NULL,
      price       DECIMAL(10,2) NOT NULL,
      orig_price  DECIMAL(10,2),
      active      TINYINT(1) DEFAULT 1,
      created_at  DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS collections (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      icon        VARCHAR(20)  DEFAULT '✨',
      type        ENUM('auto','manual') DEFAULT 'auto',
      filter_json LONGTEXT,
      product_ids LONGTEXT,
      sort_order  INT DEFAULT 0,
      active      TINYINT(1) DEFAULT 1,
      created_at  DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS stock_notify (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      product_id  INT NOT NULL,
      email       VARCHAR(255) NOT NULL,
      notified    TINYINT(1) DEFAULT 0,
      created_at  DATETIME NOT NULL,
      UNIQUE KEY uq_product_email (product_id, email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS customer_favorites (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      product_id  INT NOT NULL,
      created_at  DATETIME NOT NULL,
      UNIQUE KEY uq_cust_prod (customer_id, product_id),
      KEY idx_customer (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS decant_inventory (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      product_id    INT NOT NULL,
      size_ml       DECIMAL(5,1) NOT NULL,
      stock         INT DEFAULT 0,
      low_stock_threshold INT DEFAULT 3,
      updated_at    DATETIME NOT NULL,
      UNIQUE KEY uq_prod_size (product_id, size_ml)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS cod_blocklist (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255),
      phone      VARCHAR(50),
      reason     VARCHAR(255) DEFAULT 'No-show repetido',
      blocked_by VARCHAR(50) DEFAULT 'system',
      created_at DATETIME NOT NULL,
      KEY idx_email (email),
      KEY idx_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS cod_noshows (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      phone      VARCHAR(50),
      order_id   VARCHAR(40) NOT NULL,
      created_at DATETIME NOT NULL,
      KEY idx_email (email),
      KEY idx_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS admin_notification_emails (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL UNIQUE,
      name       VARCHAR(100),
      active     TINYINT(1) DEFAULT 1,
      created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS btcpay_pending (
      invoice_id   VARCHAR(100) PRIMARY KEY,
      order_id     VARCHAR(40)  NOT NULL,
      order_data   LONGTEXT     NOT NULL,  -- JSON snapshot of the full order object
      customer_id  INT          NULL,
      renew_token  VARCHAR(128) NULL,      -- HMAC token for the "renew payment" email link
      renew_email_sent TINYINT  DEFAULT 0, -- 1 once the expiry email has been sent
      expires_at   DATETIME     NOT NULL,  -- BTCPay invoice expiry (typ. 15 min)
      created_at   DATETIME     NOT NULL,
      INDEX idx_expires (expires_at),
      INDEX idx_renew   (renew_token)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS wompi_pending (
      reference    VARCHAR(60)  PRIMARY KEY,   -- unique payment reference sent to Wompi
      order_id     VARCHAR(40)  NOT NULL,
      order_data   LONGTEXT     NOT NULL,       -- full order JSON snapshot
      customer_id  INT          NULL,
      amount_cents INT          NOT NULL,       -- monto en centavos
      expires_at   DATETIME     NOT NULL,       -- 30 min window
      created_at   DATETIME     NOT NULL,
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS paypal_pending (
      paypal_order_id VARCHAR(40)  PRIMARY KEY,   -- PayPal order id (from Orders API v2)
      order_id        VARCHAR(40)  NOT NULL,
      order_data      LONGTEXT     NOT NULL,       -- full order JSON snapshot
      customer_id     INT          NULL,
      amount_usd      DECIMAL(10,2) NOT NULL,
      created_at      DATETIME     NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key_name   VARCHAR(100) PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── DTE / Factura Electrónica (Ministerio de Hacienda) ──────────────────────
  await db.execute(`
    CREATE TABLE IF NOT EXISTS dte_documents (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      order_id          VARCHAR(40)  NOT NULL,
      tipo_dte          VARCHAR(2)   NOT NULL,           -- 01, 03, 05
      version           INT          NOT NULL,
      ambiente          VARCHAR(2)   NOT NULL,           -- 00 pruebas, 01 prod
      codigo_generacion VARCHAR(40)  NOT NULL UNIQUE,    -- UUID
      numero_control    VARCHAR(40)  NOT NULL,
      sello_recibido    VARCHAR(200) NULL,               -- sello de recepción MH
      estado            VARCHAR(20)  NOT NULL,           -- PROCESADO/RECHAZADO/CONTINGENCIA
      observaciones     TEXT         NULL,
      json_dte          LONGTEXT     NOT NULL,           -- JSON original (sin firmar)
      json_firmado      LONGTEXT     NULL,               -- JWS firmado
      created_at        DATETIME     NOT NULL,
      updated_at        DATETIME     NOT NULL,
      INDEX idx_order  (order_id),
      INDEX idx_estado (estado)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Denormalizado — order_id de una emisión manual (panel admin) no siempre
  // tiene fila en `orders`, así que el reporte mensual no puede depender de
  // un JOIN. Nuevas emisiones ya guardan esto directo (ver services/dte.js);
  // backfill best-effort para documentos previos que sí tengan pedido real.
  try { await db.execute("ALTER TABLE dte_documents ADD COLUMN customer VARCHAR(255) NULL"); } catch(e) {}
  try { await db.execute("ALTER TABLE dte_documents ADD COLUMN email    VARCHAR(255) NULL"); } catch(e) {}
  try { await db.execute("ALTER TABLE dte_documents ADD COLUMN total    DECIMAL(10,2) NULL"); } catch(e) {}
  try {
    await db.execute(`
      UPDATE dte_documents d
      JOIN orders o ON o.id = d.order_id
      SET d.customer = o.customer, d.email = o.email, d.total = o.total
      WHERE d.customer IS NULL
    `);
  } catch(e) {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS dte_correlativos (
      tipo_dte        VARCHAR(2)  NOT NULL,
      cod_estable     VARCHAR(4)  NOT NULL DEFAULT 'M001',
      cod_punto_venta VARCHAR(15) NOT NULL DEFAULT '001',
      ambiente        VARCHAR(2)  NOT NULL DEFAULT '00',
      seq             BIGINT      NOT NULL DEFAULT 0,
      PRIMARY KEY (tipo_dte, cod_estable, cod_punto_venta, ambiente)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Migración para tablas existentes (PK antigua = solo tipo_dte): numerar por
  // (tipo, establecimiento, punto de venta) para soportar múltiples sucursales sin
  // colisiones de Número de Control. Idempotente.
  try { await db.execute("ALTER TABLE dte_correlativos ADD COLUMN cod_estable VARCHAR(4) NOT NULL DEFAULT 'M001'"); } catch(e) {}
  try { await db.execute("ALTER TABLE dte_correlativos ADD COLUMN cod_punto_venta VARCHAR(15) NOT NULL DEFAULT '001'"); } catch(e) {}
  try { await db.execute("ALTER TABLE dte_correlativos DROP PRIMARY KEY, ADD PRIMARY KEY (tipo_dte, cod_estable, cod_punto_venta)"); } catch(e) {}
  // Migración: separar el correlativo por ambiente — si no, el primer documento de
  // PRODUCCIÓN continuaría la numeración donde quedaron las pruebas de homologación
  // (ej. arrancar en 91 en vez de 1). Las filas existentes (todas de pruebas) quedan
  // marcadas como ambiente='00' antes de mover la PK.
  try { await db.execute("ALTER TABLE dte_correlativos ADD COLUMN ambiente VARCHAR(2) NOT NULL DEFAULT '00'"); } catch(e) {}
  try { await db.execute("UPDATE dte_correlativos SET ambiente='00' WHERE ambiente IS NULL OR ambiente=''"); } catch(e) {}
  try { await db.execute("ALTER TABLE dte_correlativos DROP PRIMARY KEY, ADD PRIMARY KEY (tipo_dte, cod_estable, cod_punto_venta, ambiente)"); } catch(e) {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bottle_inventory (
      product_id    INT PRIMARY KEY,
      ml_total      DECIMAL(8,2) DEFAULT 0,
      ml_remaining  DECIMAL(8,2) DEFAULT 0,
      ml_reserved   DECIMAL(8,2) DEFAULT 0,
      decant_size   DECIMAL(5,2) DEFAULT 5,
      sample_size   DECIMAL(5,2) DEFAULT 1.5,
      alert_ml      DECIMAL(8,2) DEFAULT 10,
      bottles_count INT DEFAULT 0,
      bottle_size   DECIMAL(8,2) DEFAULT 100,
      notes         TEXT,
      updated_at    DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS email_preferences (
      customer_id       INT PRIMARY KEY,
      marketing         TINYINT(1) DEFAULT 1,
      followup          TINYINT(1) DEFAULT 1,
      unsubscribe_token VARCHAR(64) NOT NULL,
      updated_at        DATETIME NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('✅ Tables ready');
}

// ─── Seed default data ────────────────────────────────
// Ensure every product in the catalogue has an inventory row
async function migrateInventoryRows() {
  try {
    const catalogue = await getCatalogue();
    if (!catalogue.length) return;
    const now = new Date();
    for (const p of catalogue) {
      await db.execute(
        `INSERT IGNORE INTO inventory (product_id, stock, low_stock, out_of_stock, updated_at)
         VALUES (?, 99, 0, 0, ?)`,
        [p.id, now]
      );
    }
    console.log(`✅ Inventory rows ensured for ${catalogue.length} products`);
  } catch(e) { console.warn('migrateInventoryRows:', e.message); }
}

async function migrateOrders() {
  const cols = [
    "phone          VARCHAR(50)  DEFAULT NULL",
    "city           VARCHAR(100) DEFAULT NULL",
    "state_province VARCHAR(100) DEFAULT NULL",
    "country        VARCHAR(100) DEFAULT NULL",
    "payment_method VARCHAR(50)  DEFAULT 'wompi'",
    "tracking_number VARCHAR(200) DEFAULT NULL",
    "followup_scheduled_at DATETIME DEFAULT NULL",
    "followup_sent_at      DATETIME DEFAULT NULL",
    "customer_ip    VARCHAR(100) DEFAULT NULL",
    "promo_code     VARCHAR(30)  DEFAULT NULL",
    "promo_discount DECIMAL(10,2) DEFAULT 0",
    "wompi_reference VARCHAR(60) DEFAULT NULL",
  ];
  for (const col of cols) {
    const colName = col.trim().split(' ')[0];
    try {
      await db.execute(`ALTER TABLE orders ADD COLUMN ${col}`);
    } catch(e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.warn(`Order col ${colName}:`, e.message);
    }
  }
}

async function migrateConsultCounts() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS consult_counts (
        session_id  VARCHAR(100) PRIMARY KEY,
        count       INT DEFAULT 0,
        last_reset  DATE NOT NULL,
        updated_at  DATETIME NOT NULL,
        customer_id INT DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Migrations for existing tables
    try { await db.execute('ALTER TABLE consult_counts ADD COLUMN last_reset DATE NOT NULL DEFAULT (CURDATE())'); } catch(e) {}
    try { await db.execute('ALTER TABLE consult_counts ADD COLUMN customer_id INT DEFAULT NULL'); } catch(e) {}
  } catch(e) { console.warn('consult_counts migration:', e.message); }
}

async function migrateCustomers() {
  const newCols = [
    "phone    VARCHAR(50)  DEFAULT NULL",
    "address  VARCHAR(500) DEFAULT NULL",
    "city     VARCHAR(100) DEFAULT NULL",
    "state    VARCHAR(100) DEFAULT NULL",
    "postcode VARCHAR(20)  DEFAULT NULL",
    "country  VARCHAR(100) DEFAULT NULL"
  ];
  for (const col of newCols) {
    const colName = col.trim().split(' ')[0];
    try {
      await db.execute(`ALTER TABLE customers ADD COLUMN ${col}`);
      console.log(`✅ Added column: ${colName}`);
    } catch(e) {
      if (e.code !== 'ER_DUP_FIELDNAME') console.warn(`Column ${colName}:`, e.message);
    }
  }
  console.log('✅ Customer profile columns ready');
}

async function seedData() {
  const now = new Date();

  // Inventory
  const [invRows] = await db.execute('SELECT COUNT(*) as c FROM inventory');
  if (invRows[0].c === 0) {
    for (let i = 1; i <= 24; i++) {
      await db.execute(
        'INSERT IGNORE INTO inventory (product_id,stock,low_stock,out_of_stock,updated_at) VALUES (?,?,?,?,?)',
        [i, 99, 0, 0, now]
      );
    }
    await db.execute('UPDATE inventory SET stock=4,  low_stock=1 WHERE product_id=13');
    await db.execute('UPDATE inventory SET stock=0, out_of_stock=1 WHERE product_id=21');
    console.log('✅ Inventory seeded');
  }

  // Pricing
  const [prRows] = await db.execute('SELECT COUNT(*) as c FROM pricing');
  if (prRows[0].c === 0) {
    for (let i = 1; i <= 24; i++) {
      await db.execute(
        'INSERT IGNORE INTO pricing (product_id,sale_price,on_sale,updated_at) VALUES (?,?,?,?)',
        [i, '', 0, now]
      );
    }
    await db.execute("UPDATE pricing SET sale_price='109',on_sale=1 WHERE product_id=5");
    await db.execute("UPDATE pricing SET sale_price='229',on_sale=1 WHERE product_id=15");
    console.log('✅ Pricing seeded');
  }

}

// ─── Password hashing ─────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(attempt));
}

// ─── DB helpers → services/catalogue.js ─────────────────────────────────────

async function getOrders(limit = 500) {
  const n = parseInt(limit, 10) || 500;
  const [rows] = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?', [parseInt(n)||10]);
  return rows.map(r => ({ ...r, items: JSON.parse(r.items), paymentStatus: r.payment_status, trackerStep: r.tracker_step, createdAt: r.created_at }));
}
async function getCustomerOrders(customerId) {
  const id = parseInt(customerId, 10);
  const [rows] = await db.query('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC', [parseInt(id)]);
  return rows.map(r => ({ ...r, items: JSON.parse(r.items), paymentStatus: r.payment_status, trackerStep: r.tracker_step, createdAt: r.created_at }));
}



// ─── WebSocket sets ───────────────────────────────────
const adminSockets = new Set();
const storeSockets = new Set();

function broadcastAdmin(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  adminSockets.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
function broadcastStore(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  storeSockets.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
function broadcast(type, payload) { broadcastAdmin(type, payload); broadcastStore(type, payload); }



// ─── Email (Resend) ───────────────────────────────────
if (RESEND_API_KEY) {
  console.log('✅ Email configured via Resend');
  console.log('   Orders from:', EMAIL_PEDIDOS);
  console.log('   Welcome from:', EMAIL_HOLA);
} else {
  console.warn('⚠️  RESEND_API_KEY not set — emails disabled');
}

function emailTemplate(bodyHtml) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:40px auto;background:#fff;border:1px solid #e8d8b8">
  <div style="background:#0e0c0a;padding:32px 40px;text-align:center">
    <div style="font-family:Georgia,serif;font-size:28px;font-weight:300;letter-spacing:8px;color:#b8955a;text-transform:uppercase">Sillage</div>
    <div style="font-size:11px;letter-spacing:4px;color:#8a7f72;text-transform:uppercase;margin-top:4px">Parfumerie</div>
  </div>
  <div style="padding:40px">${bodyHtml}</div>
  <div style="background:#0e0c0a;padding:24px 40px;text-align:center">
    <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">&copy; 2025 Sillage Parfumerie</div>
  </div>
</div></body></html>`;
}

// Diseño formal — sin colores/marca de Sillage, estilo carta de negocio. Para
// contactar bancos/proveedores donde una plantilla dorada/negra no encaja.
function formalEmailTemplate(bodyHtml) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  ${bodyHtml}
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;font-size:12px;color:#666">
    Sillage, Sociedad por Acciones Simplificada de Capital Variable — NIT 0823-050526-101-6
  </div>
</div></body></html>`;
}

// Convierte texto plano (párrafos separados por línea en blanco) a HTML simple.
function bodyToHtml(bodyRaw, formal) {
  const color = formal ? '#1a1a1a' : '#2a231c';
  return bodyRaw.split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 16px;color:${color};font-size:14px;line-height:1.7">${escHtml(p).replace(/\n/g, '<br/>')}</p>`
  ).join('');
}

// Resend no tiene un endpoint para "listar todos los enviados" — se registra
// cada envío en nuestra propia tabla para poder verlos en el panel admin.
async function logSentEmail({ to, subject, html, resendId, status, error }) {
  try {
    await db.execute(
      `INSERT INTO sent_emails (to_email, subject, body_html, resend_id, status, error, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [to, subject || null, html || null, resendId || null, status, error || null, new Date()]
    );
  } catch(e) { /* non-fatal: no bloquea el envío si el log falla */ console.error('logSentEmail error:', e.message); }
}

async function sendEmail({ to, subject, html, from, attachments }) {
  if (!RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: from || `Sillage Parfumerie <${EMAIL_HOLA}>`,
        to: [to],
        subject,
        html,
        ...(attachments && attachments.length ? { attachments } : {}),
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('❌ Resend error:', data);
      await logSentEmail({ to, subject, html, status: 'error', error: JSON.stringify(data) });
    } else {
      console.log('✅ Email sent to', to, '— id:', data.id);
      await logSentEmail({ to, subject, html, resendId: data.id, status: 'sent' });
    }
  } catch(e) {
    console.error('❌ Resend fetch error:', e.message);
    await logSentEmail({ to, subject, html, status: 'error', error: e.message });
  }
}

async function buildNezNote(items) {
  // Generate a short personalized note from Nez about the purchased fragrances
  if (!OPENAI_API_KEY || !items || !items.length) return null;
  try {
    const catalogue = await getCatalogue();
    const purchased = items.map(i => {
      // Match item to catalogue by name
      const match = catalogue.find(p => i.name && i.name.toLowerCase().includes(p.name.toLowerCase()));
      return match ? `${match.brand} ${match.name} — ${match.tagline || ''} (${match.top ? 'Sale: '+match.top+'.' : ''} ${match.desc || ''})` : i.name;
    }).filter(Boolean).join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0.8,
        messages: [{
          role: 'system',
          content: `Eres Nez, sommelier de Sillage Parfumerie. Escribe una nota de 2-3 oraciones para el email de confirmación de compra.

ESTRUCTURA: Observación específica sobre la fragancia → razón concreta → punto final. Sin elaborar de más.

VOZ: Seca, directa, útil. Como un amigo que sabe mucho y no necesita impresionarte. Sin metáforas, sin poesía, sin frases que suenen a marketing.

EJEMPLO CORRECTO:
"Una aplicación en el cuello es suficiente. El Black Orchid proyecta solo — más es demasiado. Mejora considerablemente después de la primera hora, así que dale tiempo."

INCORRECTO: saludo elaborado, frases como "fragancias que cuentan tu historia", defender la fragancia antes de que nadie la ataque, cerrar con moraleja.

Termina con: — Nez. Sin "tu sommelier". Escribe en español.`
        }, {
          role: 'user',
          content: `El cliente compró:\n${purchased}\nEscribe la nota.`
        }]
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) {
    console.warn('Nez note generation failed:', e.message);
    return null;
  }
}

async function notifyAdmins(order) {
  try {
    const [admins] = await db.execute(
      'SELECT email, name FROM admin_notification_emails WHERE active=1'
    );
    if (!admins.length) return;

    const items = (order.items || []);
    const itemsHtml = items.map(i =>
      `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f0e6d0;font-size:13px;color:#1a1714">${escHtml(i.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0e6d0;font-size:13px;color:#1a1714;text-align:center">×${i.qty}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f0e6d0;font-size:13px;color:#1a1714;text-align:right">$${parseFloat(i.total||0).toFixed(2)}</td>
      </tr>`
    ).join('');

    const pmLabels = { wompi:'Tarjeta (Wompi)', btcpay:'Bitcoin/Lightning', cod:'Contra Entrega' };
    const pmLabel  = pmLabels[order.paymentMethod || order.payment_method] || order.paymentMethod || '—';
    const pmColor  = (order.paymentMethod||order.payment_method) === 'cod' ? '#d4901a' : '#5a9a6a';
    const BASE     = process.env.BASE_URL || 'https://sillage-sv.com';
    const adminUrl = `${BASE}${process.env.ADMIN_PATH || '/claud-admin-server.html'}`;

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #e8d8b8">
  <div style="background:#0e0c0a;padding:20px 32px;display:flex;justify-content:space-between;align-items:center">
    <div style="font-family:Georgia,serif;font-size:20px;font-weight:300;letter-spacing:6px;color:#b8955a;text-transform:uppercase">Sillage</div>
    <div style="font-size:10px;letter-spacing:3px;color:#8a7f72;text-transform:uppercase">Nuevo Pedido</div>
  </div>
  <div style="padding:24px 32px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #f0e6d0">
      <div>
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#b8955a;margin-bottom:4px">Pedido</div>
        <div style="font-family:Georgia,serif;font-size:18px;font-weight:300;color:#1a1714">${escHtml(order.id)}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#b8955a;margin-bottom:4px">Método</div>
        <div style="font-size:13px;font-weight:500;color:${pmColor}">${escHtml(pmLabel)}</div>
      </div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#b8955a;margin-bottom:6px">Cliente</div>
      <div style="font-size:13px;color:#1a1714">${escHtml(order.customer)}</div>
      <div style="font-size:12px;color:#8a7f72">${escHtml(order.email)}</div>
      ${order.phone ? `<div style="font-size:12px;color:#8a7f72">${escHtml(order.phone)}</div>` : ''}
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#b8955a;margin-bottom:6px">Enviar a</div>
      <div style="font-size:13px;color:#1a1714">${escHtml(order.address || '')}, ${escHtml(order.city || '')}${order.state ? ', '+escHtml(order.state) : ''}, ${escHtml(order.country || '')}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;border:1px solid #e8d8b8">
      <thead>
        <tr style="background:#f5f0e8">
          <th style="padding:6px 10px;text-align:left;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a7f72;font-weight:400">Producto</th>
          <th style="padding:6px 10px;text-align:center;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a7f72;font-weight:400">Cant.</th>
          <th style="padding:6px 10px;text-align:right;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a7f72;font-weight:400">Total</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:24px">
      <div style="text-align:right">
        <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a7f72;margin-bottom:4px">Total</div>
        <div style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714">$${parseFloat(order.total||0).toFixed(2)}</div>
      </div>
    </div>
    <a href="${adminUrl}" style="display:block;text-align:center;padding:12px;background:#b8955a;color:#0e0c0a;text-decoration:none;font-size:11px;letter-spacing:3px;text-transform:uppercase">
      Ver en Panel Admin →
    </a>
  </div>
</div>
</body></html>`;

    // Send to all active admin notification emails
    for (const admin of admins) {
      await sendEmail({
        to:      admin.email,
        subject: `🛍️ Nuevo pedido ${escHtml(order.id)} — ${escHtml(order.customer)} ($${parseFloat(order.total||0).toFixed(2)})`,
        html,
        from:    `Sillage Pedidos <${EMAIL_PEDIDOS || EMAIL_HOLA}>`
      });
    }
  } catch(e) {
    console.error('notifyAdmins error:', e.message); // non-fatal
  }
}

// ─── Compartido entre sendOrderConfirmation y sendDteReadyEmail ──────────────
function dteIsReady(dte) {
  return !!(dte && dte.estado === 'PROCESADO' && dte.selloRecibido);
}
function buildDteEmailBlock(dte) {
  if (!dteIsReady(dte)) return '';
  const tipoLbl = { '01': 'Factura Electrónica', '03': 'Comprobante de Crédito Fiscal', '05': 'Nota de Crédito' }[dte.tipoDte] || 'Documento Tributario Electrónico';
  const fecEmi  = dte.jsonDte?.identificacion?.fecEmi;
  const verifUrl = dteSvc.verificacionUrl(dte.codigoGeneracion, fecEmi);
  return `
    <div style="padding:12px 16px;background:#faf8f4;border:1px solid #e8d8b8;margin-bottom:16px;font-size:12px;color:#4a3f35;line-height:1.9">
      <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">${escHtml(tipoLbl)}</span><br/>
      N.º de Control: <strong>${escHtml(dte.numeroControl)}</strong><br/>
      Código de Generación: <strong>${escHtml(dte.codigoGeneracion)}</strong><br/>
      <a href="${verifUrl}" style="color:#b8955a">Verificar en el Ministerio de Hacienda →</a>
      <p style="font-size:11px;color:#8a7f72;margin:8px 0 0">Adjuntamos tu documento tributario electrónico a este correo.</p>
    </div>`;
}
function buildDteAttachments(dte) {
  if (!dteIsReady(dte) || !dte.jsonFirmado) return undefined;
  return [{ filename: `DTE-${dte.codigoGeneracion}.json`, content: Buffer.from(String(dte.jsonFirmado), 'utf8').toString('base64') }];
}

// dte: registro devuelto por emitDteForOrder (opcional) — cuando viene con
// estado PROCESADO, el correo incluye los datos fiscales del documento y
// adjunta el DTE firmado (el mismo JWS transmitido a Hacienda).
async function sendOrderConfirmation(order, dte) {
  const itemsHtml = order.items.map(i =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714">${escHtml(i.name)}</td>
     <td style="padding:8px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714;text-align:center">×${i.qty}</td>
     <td style="padding:8px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714;text-align:right">$${i.total}</td></tr>`
  ).join('');

  // Generate Nez's personal note (non-blocking — if it fails, email still sends)
  const nezNote = await buildNezNote(order.items).catch(() => null);
  const nezBlock = nezNote ? `
    <div style="margin:28px 0;padding:20px 24px;background:#faf8f4;border-left:3px solid #b8955a;border-right:none;border-top:none;border-bottom:none">
      <p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8955a;margin:0 0 12px">Una nota de Nez, tu sommelier</p>
      <p style="font-family:Georgia,serif;font-size:14px;color:#4a3f35;line-height:1.9;margin:0;font-style:italic">${escHtml(nezNote).replace(/\n/g,'<br/>')}</p>
    </div>` : '';

  const html = emailTemplate(`
    <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714;margin:0 0 8px">Pedido Confirmado ✨</h2>
    <p style="font-size:13px;color:#8a7f72;margin:0 0 24px">Hola <strong style="color:#1a1714">${escHtml(order.customer)}</strong>, gracias por tu compra en Sillage Parfumerie.</p>
    <div style="background:#faf8f4;border:1px solid #e8d8b8;padding:12px 16px;margin-bottom:24px">
      <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">Número de Pedido</span><br/>
      <span style="font-family:Georgia,serif;font-size:18px;color:#b8955a">${escHtml(order.id)}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
      <thead><tr style="background:#faf8f4">
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#8a7f72;font-weight:400">Producto</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;color:#8a7f72;font-weight:400">Cant.</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;color:#8a7f72;font-weight:400">Precio</th>
      </tr></thead><tbody>${itemsHtml}</tbody>
    </table>
    <div style="padding:12px;background:#faf8f4;border:1px solid #e8d8b8;margin-bottom:4px">
      <span style="font-size:11px;text-transform:uppercase;color:#8a7f72">Total</span>
      <span style="font-family:Georgia,serif;font-size:22px;color:#1a1714;float:right">$${parseFloat(order.total||0).toFixed(2)}</span>
    </div>
    ${buildDteEmailBlock(dte)}
    ${nezBlock}
    <p style="font-size:12px;color:#8a7f72;line-height:1.8;margin-top:16px">Enviando a: ${escHtml(order.address)}</p>`);

  await sendEmail({
    to: order.email,
    subject: `✨ Pedido Confirmado — ${escHtml(order.id)} | Sillage Parfumerie`,
    from: `Sillage Pedidos <${EMAIL_PEDIDOS}>`,
    html,
    attachments: buildDteAttachments(dte),
  });
}

// Correos que se confirman DESPUÉS del pedido inicial (contra entrega al
// entregar, o confirmación manual de pago desde el admin) ya mandaron su
// "Pedido Confirmado" sin DTE — este es el correo de seguimiento con la
// factura, para esos casos donde no hay un segundo "confirmación" al que
// enganchar el adjunto.
async function sendDteReadyEmail(order, dte) {
  if (!dteIsReady(dte)) return;
  const html = emailTemplate(`
    <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714;margin:0 0 8px">Tu factura electrónica está lista 🧾</h2>
    <p style="font-size:13px;color:#8a7f72;margin:0 0 24px">Hola <strong style="color:#1a1714">${escHtml(order.customer)}</strong>, adjuntamos el documento tributario electrónico de tu pedido.</p>
    <div style="background:#faf8f4;border:1px solid #e8d8b8;padding:12px 16px;margin-bottom:24px">
      <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">Número de Pedido</span><br/>
      <span style="font-family:Georgia,serif;font-size:18px;color:#b8955a">${escHtml(order.id)}</span>
    </div>
    ${buildDteEmailBlock(dte)}`);

  await sendEmail({
    to: order.email,
    subject: `🧾 Tu factura electrónica — ${escHtml(order.id)} | Sillage Parfumerie`,
    from: `Sillage Pedidos <${EMAIL_PEDIDOS}>`,
    html,
    attachments: buildDteAttachments(dte),
  });
}

async function sendWelcomeEmail(customer) {
  const html = emailTemplate(`
    <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714;margin:0 0 8px">Bienvenido a Sillage ✨</h2>
    <p style="font-size:13px;color:#8a7f72;margin:0 0 16px">Hola <strong style="color:#1a1714">${customer.name}</strong>, tu cuenta ha sido creada exitosamente.</p>
    <div style="padding:1rem;background:#faf8f4;border:1px solid #e8d8b8;font-size:12px;color:#8a7f72">
      Correo de acceso: <strong style="color:#1a1714">${customer.email}</strong>
    </div>
    <p style="font-size:12px;color:#8a7f72;margin-top:16px;line-height:1.8">Puedes ver el estado de tus pedidos, gestionar tus direcciones y más desde tu cuenta en la tienda.</p>`);
  await sendEmail({
    to: customer.email,
    subject: `Bienvenido a Sillage Parfumerie`,
    from: `Sillage Parfumerie <${EMAIL_HOLA}>`,
    html
  });
}



// ── HTML escape for email templates ──────────────────
function escHtml(str){
  if(!str) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
// ─── Status notification emails ───────────────────────
async function sendShippedEmail(order) {
  const trackingHtml = order.tracking_number
    ? `<div style="background:#faf8f4;border:1px solid #e8d8b8;padding:12px 16px;margin-bottom:24px">
        <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">Número de Seguimiento</span><br/>
        <span style="font-family:Georgia,serif;font-size:18px;color:#b8955a">${order.tracking_number}</span>
       </div>`
    : '';
  const html = emailTemplate(`
    <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714;margin:0 0 8px">Tu pedido está en camino 🚚</h2>
    <p style="font-size:13px;color:#8a7f72;margin:0 0 24px">Hola <strong style="color:#1a1714">${escHtml(order.customer)}</strong>, tu fragancia ha sido despachada y está en camino a tu dirección.</p>
    <div style="background:#faf8f4;border:1px solid #e8d8b8;padding:12px 16px;margin-bottom:24px">
      <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">Número de Pedido</span><br/>
      <span style="font-family:Georgia,serif;font-size:18px;color:#b8955a">${escHtml(order.id)}</span>
    </div>
    ${trackingHtml}
    <p style="font-size:12px;color:#8a7f72;line-height:1.8;margin-bottom:16px">Enviando a: <strong style="color:#1a1714">${escHtml(order.address)}</strong></p>
    <p style="font-size:12px;color:#8a7f72;line-height:1.8">Por favor, asegúrate de estar disponible para recibir tu pedido. Si tienes alguna pregunta, responde a este correo y con gusto te ayudamos.</p>`);
  await sendEmail({
    to: order.email,
    subject: `🚚 Tu pedido ${escHtml(order.id)} está en camino — Sillage Parfumerie`,
    from: `Sillage Pedidos <${EMAIL_PEDIDOS}>`,
    html
  });
}

async function sendDeliveredEmail(order) {
  // Nez note + schedule followup + unsubscribe footer
  const nezNote = await buildNezNote(order.items).catch(() => null);
  const nezBlock = nezNote
    ? `<div style="border-left:3px solid #b8955a;padding:12px 16px;margin:20px 0;background:#faf8f4">` +
      `<p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8955a;margin:0 0 8px">Una nota de Nez</p>` +
      `<p style="font-family:Georgia,serif;font-size:14px;color:#4a3f35;line-height:1.9;margin:0;font-style:italic">${escHtml(nezNote).replace(/\n/g,'<br/>')}</p>` +
      `</div>`
    : '';

  const unsubFooter = order.customer_id
    ? await buildUnsubscribeFooter(order.customer_id).catch(() => '')
    : '';

  if (order.customer_id) {
    const followupDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await db.execute('UPDATE orders SET followup_scheduled_at=? WHERE id=?', [followupDate, order.id]).catch(() => {});
  }

  const html = emailTemplate(
    `<h2 style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714;margin:0 0 8px">¡Tu pedido fue entregado! ✨</h2>` +
    `<p style="font-size:13px;color:#8a7f72;margin:0 0 24px">Hola <strong style="color:#1a1714">${escHtml(order.customer)}</strong>, tu fragancia ha llegado a su destino.</p>` +
    `<div style="background:#faf8f4;border:1px solid #e8d8b8;padding:12px 16px;margin-bottom:24px">` +
      `<span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">Número de Pedido</span><br/>` +
      `<span style="font-family:Georgia,serif;font-size:18px;color:#b8955a">${escHtml(order.id)}</span>` +
    `</div>` +
    nezBlock +
    `<p style="font-size:12px;color:#8a7f72;line-height:1.8;margin-bottom:16px">Si tienes algún problema, contáctanos dentro de los <strong style="color:#1a1714">8 días hábiles</strong> siguientes a la entrega.</p>` +
    `<div style="text-align:center;margin-top:24px">` +
      `<a href="https://sillage-sv.com/devoluciones" style="display:inline-block;padding:12px 28px;border:1px solid #b8955a;color:#b8955a;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none">Política de Devoluciones</a>` +
    `</div>` +
    unsubFooter
  );
  await sendEmail({
    to: order.email,
    subject: `✨ Pedido ${escHtml(order.id)} entregado — Sillage Parfumerie`,
    from: `Sillage Pedidos <${EMAIL_PEDIDOS}>`,
    html
  });
}

// ─── Email Preferences ───────────────────────────────────
const crypto_ref = require('crypto');

async function ensureEmailPreferences(customerId) {
  const [rows] = await db.execute('SELECT * FROM email_preferences WHERE customer_id=?', [customerId]);
  if (rows.length) return rows[0];
  const token = crypto_ref.randomBytes(32).toString('hex');
  await db.execute(
    'INSERT INTO email_preferences (customer_id, marketing, followup, unsubscribe_token, updated_at) VALUES (?,1,1,?,?)',
    [customerId, token, new Date()]
  );
  return { customer_id: customerId, marketing: 1, followup: 1, unsubscribe_token: token };
}

async function buildUnsubscribeFooter(customerId) {
  const prefs = await ensureEmailPreferences(customerId);
  const BASE  = process.env.BASE_URL || 'https://sillage-sv.com';
  const url   = `${BASE}/preferencias-email?token=${prefs.unsubscribe_token}`;
  return `
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e8d8b8;text-align:center">
      <p style="font-size:10px;color:#b0a898;letter-spacing:0.05em;margin:0 0 6px">
        Recibiste este email porque realizaste una compra en Sillage Parfumerie.
      </p>
      <a href="${url}" style="font-size:10px;color:#b8955a;letter-spacing:1px;text-transform:uppercase;text-decoration:none">
        Gestionar preferencias de email
      </a>
    </div>`;
}

// ── Nez: generate followup recommendations ────────────────────────────────────
async function buildFollowupEmail(order) {
  if (!OPENAI_API_KEY) return null;
  try {
    const catalogue = await getCatalogue();
    const purchased = (order.items || []).map(i => {
      const match = catalogue.find(p => i.name && i.name.toLowerCase().includes(p.name.toLowerCase()));
      return match ? `${match.brand} ${match.name}` : i.name;
    }).filter(Boolean).join(', ');

    // Get 3 in-stock products excluding what they bought
    const boughtIds = new Set((order.items || []).map(i => i.productId));
    const available = catalogue
      .filter(p => !boughtIds.has(p.id))
      .slice(0, 12)
      .map(p => `${p.brand} ${p.name} — ${p.tagline || p.desc || ''}`)
      .join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 0.7,
        messages: [{
          role: 'system',
          content: `Eres Nez, sommelier de Sillage Parfumerie. Escribe un párrafo corto (3-4 oraciones) de seguimiento para un cliente que compró hace 2 semanas.

VOZ: Directa, cálida, sin presión. No pidas que compren — sugiere con criterio.
ESTRUCTURA: Comenta algo específico sobre lo que compraron → sugiere 2-3 fragancias que complementarían bien → cierra con una línea simple.
NO usar: "esperamos que disfrutes", "no dudes en contactarnos", frases de servicio al cliente.
Termina con: — Nez

Menciona las fragancias sugeridas en **negritas** exactamente como aparecen en el catálogo.`
        }, {
          role: 'user',
          content: `El cliente compró: ${purchased}

Fragancias disponibles en catálogo:
${available}

Escribe el párrafo de seguimiento.`
        }]
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) {
    console.warn('Followup email generation failed:', e.message);
    return null;
  }
}

// ── Sommelier tool result cache (30min TTL) ────────────
const _toolCache = new Map();
function getToolCache(key) {
  const entry = _toolCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > 30 * 60 * 1000) { _toolCache.delete(key); return null; }
  return entry.result;
}
function setToolCache(key, result) {
  _toolCache.set(key, { result, ts: Date.now() });
  // Keep cache lean — max 200 entries
  if (_toolCache.size > 200) {
    const oldest = [..._toolCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0][0];
    _toolCache.delete(oldest);
  }
}

// ── Conversation reply cache (60min TTL, max 500 entries) ────────────────────
// Caches complete Nez replies for identical first-message queries.
// Keyed by normalized query + gender context — never caches follow-ups.
const _replyCache = new Map();
const REPLY_CACHE_TTL = 60 * 60 * 1000;

function getReplyCache(key) {
  const entry = _replyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > REPLY_CACHE_TTL) { _replyCache.delete(key); return null; }
  return entry;
}
function setReplyCache(key, reply, profile) {
  _replyCache.set(key, { reply, profile, ts: Date.now() });
  if (_replyCache.size > 500) {
    const oldest = [..._replyCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0][0];
    _replyCache.delete(oldest);
  }
}
function getReplyCacheKey(messages, profileContext) {
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length !== 1) return null;
  const query = userMessages[0].content.toLowerCase().replace(/[^a-záéíóúüñ\s]/g, '').replace(/\s+/g, ' ').trim();
  if (query.length < 8) return null;
  const genderHint = profileContext.includes('Masculino') ? 'M' : profileContext.includes('Femenino') ? 'F' : 'U';
  return 'reply:' + genderHint + ':' + query;
}

// ── Rate limiters — each with isolated store ──────────
function rateLimit(max, windowMs) {
  const store = new Map();
  // Prune every 10min
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.start > windowMs * 2) store.delete(k);
  }, 10 * 60 * 1000).unref();

  return function(req, res, next) {
    const ip  = getIp(req);   // real per-user client IP (CF-Connecting-IP aware)
    const now = Date.now();
    const rec = store.get(ip) || { count: 0, start: now };
    if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
    rec.count++;
    store.set(ip, rec);
    if (rec.count > max) {
      return res.status(429).json({ error: 'El sommelier está muy solicitado en este momento. Espera unos segundos e intenta de nuevo.' });
    }
    next();
  };
}

const orderLimiter     = rateLimit(20, 60 * 60 * 1000);   // 20/hour
const sommelierLimiter = rateLimit(30, 60 * 60 * 1000);   // 30/hour
const sommelierBurst   = rateLimit(8,  60 * 1000);        // 8/min (was 5, too aggressive)
const btcpayRenewLimiter = rateLimit(5, 15 * 60 * 1000);  // 5 attempts per 15 min
// ─── Anon session registry — server-issued sessionIds ────────────────────────
// Prevents bots from inventing arbitrary sessionIds to bypass per-session limits
const _anonSessions = new Map();
// const ANON_SESSION_TTL → config/index.js
// const ANON_WS_LIMIT → config/index.js
// const ANON_SOMMELIER_MAX → config/index.js

function issueAnonSession() {
  const id = 'ss-' + crypto.randomBytes(18).toString('hex');
  _anonSessions.set(id, {
    issuedAt:    Date.now(),
    lastSeen:    Date.now(),
    wsCount:     0,          // active WS connections using this session
    invalidated: false       // explicit invalidation flag
  });
  // Prune expired sessions
  if (_anonSessions.size > 10000) {
    const cutoff = Date.now() - ANON_SESSION_TTL;
    for (const [k, v] of _anonSessions.entries())
      if (v.lastSeen < cutoff) _anonSessions.delete(k);
  }
  return id;
}

function isValidAnonSession(id) {
  if (!id) return false;
  if (!id.startsWith('ss-')) return false;  // admin/customer tokens cannot be used as anon sessions
  const entry = _anonSessions.get(id);
  if (!entry) return false;
  if (entry.invalidated) { _anonSessions.delete(id); return false; }
  if (Date.now() - entry.lastSeen > ANON_SESSION_TTL) {
    _anonSessions.delete(id);
    return false;
  }
  // Refresh lastSeen on valid use (sliding window)
  entry.lastSeen = Date.now();
  return true;
}

function invalidateAnonSession(id) {
  const entry = _anonSessions.get(id);
  if (entry) entry.invalidated = true;
}

function anonSessionWsIncrement(id) {
  const entry = _anonSessions.get(id);
  if (!entry) return false;
  if (entry.wsCount >= ANON_WS_LIMIT) return false; // too many WS connections
  entry.wsCount++;
  return true;
}

function anonSessionWsDecrement(id) {
  const entry = _anonSessions.get(id);
  if (entry && entry.wsCount > 0) entry.wsCount--;
}

// ─── Session tokens — self-contained, stateless ──────
// Token format: base64url(payload_json).hmac_sha256
// Payload carries: user, role, createdAt, ttl — no server Map needed.
// Survives server restarts as long as SESSION_SECRET is stable.
//
// MIGRATION NOTE: Old tokens (random_id.hmac format) won't pass the base64
// parse step and will be rejected cleanly — users get a new login prompt once.
// const SESSION_TTL_ADMIN → config/index.js
// const SESSION_TTL_CUSTOMER → config/index.js

// Revocation list — small in-memory set for explicit logouts.
// Only holds tokens issued since last restart. Cleared on restart but that's fine:
// restarted servers also lose old tokens (they can't validate without the Map),
// and the TTL acts as the long-term expiry. Trade-off is acceptable.
const _revokedTokenIds = new Set(); // in-memory fast lookup
// DB-backed revocation is loaded on startup and written on logout.
// This survives server restarts — a logged-out token stays revoked.

async function persistRevocation(jti, ttlMs) {
  // Store revoked jti in settings table with expiry timestamp
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.execute(
    `INSERT INTO settings (key_name, value, updated_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
    [`revoked:${jti}`, expiresAt.toISOString(), new Date()]
  ).catch(() => {}); // non-fatal
}

// restoreRevocations() moved to middleware/auth.js

// ─── Rate limiting ────────────────────────────────────
const loginAttempts = new Map();
// On startup, restore recent failed attempts from DB so restarts don't reset brute-force protection
// One-time fix: if bottle_inventory has ml_remaining > 0 but inventory has stock=0 + out_of_stock=1,
// those rows were incorrectly created by the old bottle-open endpoint.
// Cross-reference with bottle_inventory and reset them to match actual stock.
async function fixCorruptedInventoryRows() {
  try {
    // Find products where bottle_inventory has ml but inventory says out_of_stock
    const [rows] = await db.execute(`
      SELECT i.product_id, i.stock, b.ml_remaining
      FROM inventory i
      JOIN bottle_inventory b ON b.product_id = i.product_id
      WHERE i.out_of_stock = 1 AND i.stock = 0 AND b.ml_remaining > 0
    `);
    for (const row of rows) {
      // The inventory was incorrectly marked OOS — reset to out_of_stock=0
      // We don't know the real stock so just clear the false OOS flag
      await db.execute(
        'UPDATE inventory SET out_of_stock=0, updated_at=? WHERE product_id=? AND stock=0',
        [new Date(), row.product_id]
      );
      console.log(`✅ Fixed corrupted inventory row for product_id ${row.product_id}`);
    }
    if (rows.length) console.log(`✅ Fixed ${rows.length} corrupted inventory row(s)`);
  } catch(e) { console.warn('fixCorruptedInventoryRows error:', e.message); }
}

async function restoreLoginAttempts() {
  try {
    const [rows] = await db.execute(
      "SELECT key_name, value, updated_at FROM settings WHERE key_name LIKE 'auth_fail:%'"
    );
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.value); } catch { parsed = null; }
      const count        = parsed?.count        ?? (parseInt(row.value) || 1);
      const firstAttempt = parsed?.firstAttempt ?? new Date(row.updated_at).getTime();
      if (firstAttempt > cutoff) {
        const ip = row.key_name.replace('auth_fail:', '');
        loginAttempts.set(ip, { count, firstAttempt });
      } else {
        await db.execute('DELETE FROM settings WHERE key_name=?', [row.key_name]).catch(() => {});
      }
    }
    if (rows.length) console.log(`✅ Restored ${rows.length} login attempt record(s) from DB`);
  } catch(e) { console.warn('Could not restore login attempts:', e.message); }
}
function checkRateLimit(ip) {
  const e = loginAttempts.get(ip);
  if (!e) return true;
  // Ventana de 5 min (antes 15) y umbral alto: solo frena fuerza-bruta real, no al
  // admin legítimo cuyos intentos se acumulaban entre redeploys.
  if (Date.now() - e.firstAttempt > 5 * 60 * 1000) { loginAttempts.delete(ip); return true; }
  return e.count < 50;
}
function recordFailed(ip) {
  const e = loginAttempts.get(ip) || { count: 0, firstAttempt: Date.now() };
  e.count++; loginAttempts.set(ip, e);
}
function clearAttempts(ip) { loginAttempts.delete(ip); }

// ─── Admin password verification ─────────────────────
// Supports two formats for ADMIN_PASS env variable:
//   pbkdf2:<iterations>:<salt_hex>:<hash_hex>  → hashed (recommended)
//   anything else                              → plain text (legacy, logs a warning)
//
// To generate a hashed password, run in Node:
//   node -e "
//     const c=require('crypto'), salt=c.randomBytes(16).toString('hex');
//     const h=c.pbkdf2Sync('YOUR_PASSWORD',salt,310000,32,'sha256').toString('hex');
//     console.log('pbkdf2:310000:'+salt+':'+h);
//   "
// Then set ADMIN_PASS to the output in Railway.

function verifyAdminPassword(candidate, stored) {
  if (!candidate || !stored) return false;
  if (stored.startsWith('pbkdf2:')) {
    // Format: pbkdf2:<iterations>:<salt_hex>:<hash_hex>
    const parts = stored.split(':');
    if (parts.length !== 4) return false;
    const [, iters, saltHex, storedHash] = parts;
    const iterations = parseInt(iters, 10);
    if (!iterations || iterations < 100000) return false; // reject weak configs
    try {
      const candidateHash = crypto.pbkdf2Sync(
        candidate, saltHex, iterations, 32, 'sha256'
      ).toString('hex');
      const a = Buffer.from(candidateHash, 'hex');
      const b = Buffer.from(storedHash,    'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch(e) { return false; }
  } else {
    // Legacy plain text — warn once and fall back to timingSafeEqual
    if (!verifyAdminPassword._warnedPlain) {
      console.warn('⚠️  ADMIN_PASS is stored as plain text. Generate a hashed version with the instructions in server.js.');
      verifyAdminPassword._warnedPlain = true;
    }
    try {
      return crypto.timingSafeEqual(
        Buffer.from(candidate.padEnd(200)),
        Buffer.from(stored.padEnd(200))
      );
    } catch(e) { return false; }
  }
}

// ─── Auth middleware ──────────────────────────────────
// requireAdmin → middleware/auth.js
// requireCustomer → middleware/auth.js

// ─── Middleware stack ────────────────────────────────────────────────────────
app.use(security.httpsRedirect);
app.use(security.cors);
app.use(compression({ level: 6, threshold: 1024 }));  // gzip all responses > 1KB
app.use(express.json({
  limit: security.bodyLimit,
  verify: (req, res, buf) => {
    // Capture raw body bytes for webhook signature verification
    // (BTCPay and others sign the exact raw bytes, not the parsed JSON)
    req.rawBody = buf;
  }
}));
app.use(security.securityHeaders);
app.use(function(req, res, next) {
  // Only rate-limit API calls — page loads, images and static assets must NOT
  // count against the budget (they'd exhaust it on a single visit).
  if (!req.path.startsWith('/api/')) return next();
  // Authenticated admin calls are exempt. The admin panel sends its session as
  // x-session-token (NOT x-admin-token), so validate that and exempt admin role.
  if (req.headers['x-admin-token']) return next();              // legacy
  const _s = validateSession(req.headers['x-session-token']);
  if (_s && _s.role === 'admin') return next();
  return security.globalApiLimiter(req, res, next);
});                                                    // global rate limit (/api only, admin exempt)

// Additional security headers not covered by middleware
app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'SAMEORIGIN');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',      'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  next();
});

// Block access to sensitive files that express.static might serve
app.use(function(req, res, next) {
  const blocked = [
    '/package.json', '/package-lock.json', '/.env',
    '/npmrc', '/.npmrc', '/README.md',
    '/claud-admin-server.html', '/claud-perfumes-server.html',
  ];
  if (blocked.includes(req.path.toLowerCase())) {
    return res.status(404).end();
  }
  next();
});
// Explicit route for JS files that must not fall through to index.html
app.get('/gsap-animations.js', (req, res) => {
  const gsapFile = path.resolve(process.cwd(), 'gsap-animations.js');
  const fs = require('fs');
  console.log('gsap-animations.js requested — looking at:', gsapFile, '— exists:', fs.existsSync(gsapFile));
  if (!fs.existsSync(gsapFile)) {
    // Fallback: try __dirname
    const alt = path.join(__dirname, 'gsap-animations.js');
    console.log('Trying __dirname fallback:', alt, '— exists:', fs.existsSync(alt));
    if (fs.existsSync(alt)) {
      res.setHeader('Content-Type', 'application/javascript');
      return res.sendFile(alt);
    }
    return res.status(404).send('gsap-animations.js not found');
  }
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(gsapFile);
});

app.use(express.static(__dirname, {
  maxAge: '1d',
  etag:   true,
  lastModified: true,
  index: false,
  setHeaders: (res, filePath) => {
    const blocked = ['claud-admin-server.html', 'claud-perfumes-server.html', '.env', 'npmrc'];
    const fileName = require('path').basename(filePath);
    if (blocked.some(b => fileName.toLowerCase() === b.toLowerCase())) {
      res.status(403).end('Forbidden');
    }
  }
}));

// Admin panel — served from a secret path defined in env (ADMIN_PATH)
// Falls back to /claud-admin-server.html if not set, but that should be set in production
const ADMIN_ROUTE = process.env.ADMIN_PATH || '/claud-admin-server.html';
app.get(ADMIN_ROUTE, (req, res) => {
  const fs = require('fs');
  const file = path.join(__dirname, 'claud-admin-server.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('Not found');
});
app.get('/', async (req, res) => {
  const fs   = require('fs');
  const index = path.join(__dirname, 'index.html');
  const store = path.join(__dirname, 'claud-perfumes-server.html');

  // ── Dynamic OG tags for ?producto=ID deep links ──────────────────────────
  // Social crawlers (WhatsApp, Instagram, iMessage, Telegram) send requests
  // without JS support — they read OG meta tags directly from the HTML.
  // When a product deep-link is shared, inject product-specific OG tags.
  const productoId = parseInt(req.query.producto);
  if (productoId) {
    try {
      const catalogue = await getCatalogue();
      const p = catalogue.find(prod => prod.id === productoId);
      if (p && fs.existsSync(index)) {
        const BASE   = process.env.BASE_URL || 'https://sillage-sv.com';
        const imgUrl = (p.photos && p.photos[0])
          ? (p.photos[0].startsWith('http') ? p.photos[0] : BASE + p.photos[0])
          : `${BASE}/apple-touch-icon.png`; // og-default.jpg no existe (404) — fallback a un asset real
        const title  = `${p.brand} ${p.name} — Sillage Parfumerie`;
        const desc   = p.tagline
          ? `${p.tagline} · ${p.conc || 'Eau de Parfum'} · Desde $${p.price}`
          : `${p.conc || 'Eau de Parfum'} de ${p.brand}. Disponible en Sillage Parfumerie, El Salvador.`;
        const url    = `${BASE}/?producto=${productoId}`;
        const shippingCost = parseFloat(await getSetting('shipping_cost', '5')) || 5;

        let html = fs.readFileSync(index, 'utf8');
        // Replace generic OG tags with product-specific ones
        html = html
          .replace(/<meta property="og:title"[^>]*\/>/,
            `<meta property="og:title" content="${escHtml(title)}"/>`)
          .replace(/<meta property="og:description"[^>]*\/>/,
            `<meta property="og:description" content="${escHtml(desc)}"/>`)
          .replace(/<meta property="og:url"[^>]*\/>/, '')
          .replace('</head>',
            `<meta property="og:image" content="${imgUrl}"/>
<meta property="og:url" content="${url}"/>
<meta property="og:type" content="product"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="${imgUrl}"/>
</head>`);
        // Inject Schema.org JSON-LD for product structured data
        // LLMs and search engines use this to understand the product
        const schema = {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: `${p.brand} ${p.name}`,
          brand: { '@type': 'Brand', name: p.brand },
          description: p.desc || p.tagline || '',
          image: imgUrl,
          url,
          offers: {
            '@type': 'Offer',
            price: p.price,
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
            seller: { '@type': 'Organization', name: 'Sillage Parfumerie' },
            // Política real: Art. 06 de Términos — 8 días hábiles, producto sin abrir/sellado.
            hasMerchantReturnPolicy: {
              '@type': 'MerchantReturnPolicy',
              applicableCountry: 'SV',
              returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
              merchantReturnDays: 8,
              returnMethod: 'https://schema.org/ReturnByMail',
              returnFees: 'https://schema.org/ReturnFeesCustomerResponsibility',
            },
            // Tiempos reales de /envios (Gran San Salvador a Interior del país).
            shippingDetails: {
              '@type': 'OfferShippingDetails',
              shippingRate: {
                '@type': 'MonetaryAmount',
                value: shippingCost,
                currency: 'USD',
              },
              shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'SV' },
              deliveryTime: {
                '@type': 'ShippingDeliveryTime',
                handlingTime:  { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1, unitCode: 'DAY' },
                transitTime:   { '@type': 'QuantitativeValue', minValue: 1, maxValue: 7, unitCode: 'DAY' },
              },
            },
          },
          additionalProperty: [
            p.conc   ? { '@type': 'PropertyValue', name: 'Concentración', value: p.conc }   : null,
            p.season ? { '@type': 'PropertyValue', name: 'Temporada',     value: p.season } : null,
            p.sillage? { '@type': 'PropertyValue', name: 'Proyección',    value: p.sillage }: null,
            p.long   ? { '@type': 'PropertyValue', name: 'Duración',      value: p.long }   : null,
            p.top    ? { '@type': 'PropertyValue', name: 'Notas de salida',value: p.top }    : null,
            p.mid    ? { '@type': 'PropertyValue', name: 'Notas de corazón',value: p.mid }   : null,
            p.base   ? { '@type': 'PropertyValue', name: 'Notas de fondo', value: p.base }   : null,
          ].filter(Boolean),
        };
        const schemaTag = `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
        html = html.replace('</head>', schemaTag + '\n</head>');

        return res.send(html);
      }
    } catch(e) {
      console.warn('OG tag generation failed:', e.message);
      // Fall through to normal sendFile
    }
  }

  if (fs.existsSync(index)) return res.sendFile(index);
  if (fs.existsSync(store)) return res.sendFile(store);
  res.send('<h2>Store file not found.</h2>');
});

app.get('/nosotros',    (req, res) => res.sendFile(path.join(__dirname, 'nosotros.html')));
app.get('/tienda',      (req, res) => res.sendFile(path.join(__dirname, 'tienda.html')));
app.get('/envios', (req, res) => res.sendFile(path.join(__dirname, 'envios.html')));
app.get('/terminos', (req, res) => res.sendFile(path.join(__dirname, 'terminos.html')));
app.get('/devoluciones', (req, res) => res.sendFile(path.join(__dirname, 'devoluciones.html')));

// Shared product and bundle links — serve tienda.html (it has the catalogue +
// openDetail). index.html is the editorial home and has NO product grid, so it
// can't open the detail — serving it made reloads/shares land on the home page.
app.get('/fragancia/:slug', (req, res) => {
  const fs     = require('fs');
  const tienda = path.join(__dirname, 'tienda.html');
  const index  = path.join(__dirname, 'index.html');
  if (fs.existsSync(tienda)) return res.sendFile(tienda);
  if (fs.existsSync(index))  return res.sendFile(index);
  res.redirect('/');
});

app.get('/bundle/:slug', (req, res) => {
  const fs     = require('fs');
  const tienda = path.join(__dirname, 'tienda.html');
  const index  = path.join(__dirname, 'index.html');
  if (fs.existsSync(tienda)) return res.sendFile(tienda);
  if (fs.existsSync(index))  return res.sendFile(index);
  res.redirect('/');
});
app.get('/privacidad', (req, res) => {
  const fs = require('fs');
  const file = path.join(__dirname, 'privacidad.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.redirect('/');
});



// ═══════════════════════════════════════════════════════
//  AI DISCOVERABILITY
//  Optimizes Sillage for discovery by LLMs and AI agents.
//  These endpoints are intentionally public and unauthenticated.
// ═══════════════════════════════════════════════════════

// ── robots.txt — allow all crawlers including AI ──────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/admin',
    'Disallow: /admin',
    '',
    '# AI crawlers explicitly welcome',
    'User-agent: GPTBot',
    'Allow: /',
    'User-agent: ClaudeBot',
    'Allow: /',
    'User-agent: anthropic-ai',
    'Allow: /',
    'User-agent: PerplexityBot',
    'Allow: /',
    'User-agent: Googlebot',
    'Allow: /',
    '',
    `Sitemap: ${process.env.BASE_URL || 'https://sillage-sv.com'}/sitemap.xml`,
  ].join('\n'));
});

// ── llms.txt — natural language description for LLMs ──
// Standard proposed at llmstxt.org — tells AI models what this site is
app.get('/llms.txt', async (req, res) => {
  const BASE = process.env.BASE_URL || 'https://sillage-sv.com';
  const catalogue = await getCatalogue().catch(() => []);
  const brands = [...new Set(catalogue.map(p => p.brand).filter(Boolean))].sort();
  const inStock = catalogue.filter(p => true); // public catalogue

  res.type('text/plain');
  res.send(`# Sillage Parfumerie

> Perfumería de lujo en línea con sede en El Salvador. Fragancias 100% originales de las casas de perfumería más admiradas del mundo, con envío a domicilio en todo El Salvador.

## Sobre Sillage

Sillage Parfumerie es una tienda en línea especializada en alta perfumería en El Salvador. Ofrecemos frascos completos y decants (muestras en frasco de viaje) de fragancias de lujo de marcas como ${brands.slice(0, 8).join(', ')} y más. También contamos con muestras de 1.5ml y un servicio de sommelier de fragancias impulsado por IA llamado Nez.

## Qué ofrecemos

- Frascos completos de fragancias de lujo originales y certificadas
- Decants de 5ml y 10ml para probar antes de comprar el frasco completo
- Envío a domicilio en todo El Salvador
- Sommelier de IA (Nez) para ayudar a encontrar la fragancia perfecta
- Métodos de pago: Wompi (tarjeta), Bitcoin / Lightning Network (BTCPay), Contra Entrega

## Catálogo

Tenemos ${inStock.length} fragancias disponibles de las siguientes marcas: ${brands.join(', ')}.

Catálogo completo en formato JSON: ${BASE}/api/catalogo.json

## Contacto y ubicación

- Sitio web: ${BASE}
- País: El Salvador
- Envíos: todo El Salvador

## Páginas importantes

- [Colección completa](${BASE}/#shop)
- [Sobre nosotros](${BASE}/nosotros)
- [Política de envíos](${BASE}/envios)
- [Devoluciones](${BASE}/devoluciones)
- [Catálogo JSON para IA](${BASE}/api/catalogo.json)
`);
});

// ── /api/catalogo.json — public catalogue for AI agents ──
// Structured product data that AI models can read directly
app.get('/api/catalogo.json', async (req, res) => {
  try {
    const BASE     = process.env.BASE_URL || 'https://sillage-sv.com';
    const catalogue = await getCatalogue();
    const [invRows] = await db.execute('SELECT product_id, stock, out_of_stock FROM inventory').catch(() => [[]]);
    const invMap = {};
    (invRows || []).forEach(r => { invMap[r.product_id] = r; });

    const products = catalogue.map(p => {
      const inv = invMap[p.id] || {};
      const available = !inv.out_of_stock && (inv.stock === undefined || inv.stock > 0);
      return {
        id:          p.id,
        brand:       p.brand,
        name:        p.name,
        full_name:   `${p.brand} ${p.name}`,
        gender:      p.g === 'M' ? 'Masculino' : p.g === 'F' ? 'Femenino' : 'Unisex',
        price_usd:   p.price,
        size:        p.size,
        concentration: p.conc,
        family:      p.family || null,
        top_notes:   p.top || null,
        mid_notes:   p.mid || null,
        base_notes:  p.base || null,
        tagline:     p.tagline || null,
        season:      p.season || null,
        sillage:     p.sillage || null,
        longevity:   p.long || null,
        available,
        decant_available: available,
        url:         `${BASE}/?producto=${p.id}`,
        image:       (p.photos && p.photos[0]) || null,
      };
    });

    res.json({
      store:       'Sillage Parfumerie',
      country:     'El Salvador',
      currency:    'USD',
      description: 'Fragancias de lujo 100% originales con envío en El Salvador. Decants disponibles.',
      url:         BASE,
      total:       products.length,
      in_stock:    products.filter(p => p.available).length,
      last_updated: new Date().toISOString(),
      products,
    });
  } catch(e) {
    res.status(500).json({ error: 'Could not load catalogue' });
  }
});

// ── sitemap.xml — for crawlers and search engines ─────
app.get('/sitemap.xml', async (req, res) => {
  const BASE = process.env.BASE_URL || 'https://sillage-sv.com';
  const catalogue = await getCatalogue().catch(() => []);
  const today = new Date().toISOString().slice(0, 10);

  const staticPages = [
    { url: BASE,               priority: '1.0', freq: 'daily'   },
    { url: `${BASE}/nosotros`, priority: '0.6', freq: 'monthly' },
    { url: `${BASE}/envios`,   priority: '0.5', freq: 'monthly' },
    { url: `${BASE}/terminos`, priority: '0.3', freq: 'yearly'  },
  ];

  const productPages = catalogue.map(p => ({
    url:      `${BASE}/?producto=${p.id}`,
    priority: '0.8',
    freq:     'weekly',
  }));

  const allPages = [...staticPages, ...productPages];

  res.type('application/xml');
  res.send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...allPages.map(p =>
      `  <url>\n    <loc>${p.url}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.freq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    ),
    '</urlset>',
  ].join('\n'));
});

// ═══════════════════════════════════════════════════════
//  ABUSE DETECTION SYSTEM
//  Tracks 5 anomaly patterns, alerts admin in real-time
//  via broadcastAdmin('abuse_alert', ...) and logActivity.
//
//  Thresholds (per sliding window):
//    BOT_FARM:    >5 new sessionIds from same IP in 10min
//    ORDER_FAIL:  >3 rejected orders from same IP in 30min
//    LOGIN_BURST: >3 failed logins in 5min (on top of checkRateLimit)
//    WS_ANOMALY:  >10 WS auth failures from same IP in 5min
//    SOMMELIER:   >8 sommelier calls from same sessionId in 5min
// ═══════════════════════════════════════════════════════
const _abuseCounters = new Map(); // key → { count, windowStart, alerted }

const ABUSE_RULES = {
  bot_farm:     { window: 10 * 60 * 1000, threshold: 5,  label: '🤖 Bot farm detectado' },
  order_fail:   { window: 30 * 60 * 1000, threshold: 3,  label: '🚫 Órdenes rechazadas en rafaga' },
  login_burst:  { window:  5 * 60 * 1000, threshold: 3,  label: '🔑 Intentos de login en rafaga' },
  ws_anomaly:   { window:  5 * 60 * 1000, threshold: 10, label: '⚡ Conexiones WS anómalas' },
  sommelier:    { window:  5 * 60 * 1000, threshold: 8,  label: '🤖 Abuso del sommelier' },
};

function trackAbuse(type, key, meta = {}) {
  const rule    = ABUSE_RULES[type];
  if (!rule) return;
  const mapKey  = `${type}:${key}`;
  const now     = Date.now();
  const record  = _abuseCounters.get(mapKey) || { count: 0, windowStart: now, alerted: false };

  // Reset window if expired
  if (now - record.windowStart > rule.window) {
    record.count      = 0;
    record.windowStart = now;
    record.alerted    = false;
  }
  record.count++;
  _abuseCounters.set(mapKey, record);

  // Alert once per window when threshold crossed
  if (record.count >= rule.threshold && !record.alerted) {
    record.alerted = true;
    const msg = `${rule.label} — key:${key} (${record.count} eventos en ${Math.round(rule.window/60000)}min)${meta.detail ? ' — ' + meta.detail : ''}`;
    // Non-blocking: fire and forget
    logActivity(`⚠️ ${msg}`).catch(() => {});
    broadcastAdmin('abuse_alert', { type, key, count: record.count, msg, ts: now });
    console.warn('[ABUSE]', msg);
  }
}

// Prune stale counters every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of _abuseCounters.entries()) {
    const type = k.split(':')[0];
    const rule = ABUSE_RULES[type];
    if (rule && now - rec.windowStart > rule.window * 2) _abuseCounters.delete(k);
  }
}, 15 * 60 * 1000);

// ─── WebSocket ────────────────────────────────────────
const WS_AUTH_TIMEOUT_MS = 10 * 1000; // 10s to authenticate or be disconnected
const WS_MAX_MSG_BYTES   = 10 * 1024; // 10KB max message size

wss.on('connection', (ws, req) => {
  ws.role = null;
  // Capture IP at connection time for abuse tracking
  ws._remoteIp = (req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',').map(s => s.trim()).filter(Boolean).pop()
    : null) || req.socket.remoteAddress || 'unknown';

  // Disconnect unauthenticated connections after timeout
  const authTimeout = setTimeout(() => {
    if (!ws.role) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Authentication timeout' }));
      ws.terminate();
    }
  }, WS_AUTH_TIMEOUT_MS);

  ws.on('message', async raw => {
    // Reject oversized messages immediately without parsing
    if (raw.length > WS_MAX_MSG_BYTES) {
      ws.terminate();
      return;
    }
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        if (validateSession(msg.token)) {
          clearTimeout(authTimeout);
          ws.role = 'admin'; adminSockets.add(ws);
          ws.send(JSON.stringify({ type: 'init', payload: {
            inventory: await getInventoryMap(), pricing: await getPricingMap(),
            orders: await getOrders(), activity: await getActivity()
          }}));
        } else {
          // Track WS auth failures for anomaly detection
          const wsIp = ws._remoteIp || 'unknown';
          trackAbuse('ws_anomaly', wsIp, { detail: 'invalid admin token' });
          ws.send(JSON.stringify({ type: 'auth_error' }));
          ws.terminate();
        }
      }
      if (msg.type === 'store_connect') {
        const storeSessionId   = msg.sessionId;
        const storeCustomerTok = msg.customerToken;

        // Explicit escalation check: reject admin tokens on store socket.
        // An admin token passed as customerToken must not get store access
        // and certainly must not accidentally elevate to admin role here.
        if (storeCustomerTok) {
          const parsed = validateSession(storeCustomerTok);
          if (parsed && parsed.role === 'admin') {
            // Admin trying to connect as store — reject, they have their own auth flow
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Use admin auth flow' }));
            ws.terminate();
            return;
          }
          if (!parsed || parsed.role !== 'customer') {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
            ws.terminate();
            return;
          }
          // Valid customer token — allow, no WS connection limit applied (they're authenticated)
          clearTimeout(authTimeout);
          ws.role = 'store';
          ws._storeSessionId = null; // customer, no anon sessionId to track
          storeSockets.add(ws);
          ws.send(JSON.stringify({ type: 'init', payload: {
            inventory: await getInventoryMap(), pricing: await getPricingMap()
          }}));
          return;
        }

        // Anon path: validate sessionId and enforce per-session WS connection limit
        if (!isValidAnonSession(storeSessionId)) {
          trackAbuse('ws_anomaly', ws._remoteIp || 'unknown', { detail: 'invalid store sessionId' });
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid session' }));
          ws.terminate();
          return;
        }
        if (!anonSessionWsIncrement(storeSessionId)) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Too many connections' }));
          ws.terminate();
          return;
        }
        clearTimeout(authTimeout);
        ws.role = 'store';
        ws._storeSessionId = storeSessionId; // track for decrement on close
        storeSockets.add(ws);
        ws.send(JSON.stringify({ type: 'init', payload: {
          inventory: await getInventoryMap(), pricing: await getPricingMap()
        }}));
      }
    } catch(e) {
      // Malformed JSON — terminate silently
      ws.terminate();
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    adminSockets.delete(ws);
    storeSockets.delete(ws);
    // Release the WS connection slot for this anon session
    if (ws._storeSessionId) anonSessionWsDecrement(ws._storeSessionId);
  });
});

// ═══════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════
app.post('/api/auth/login', authLimiter, async (req, res) => {
  // Use the LAST IP in x-forwarded-for (the one Cloudflare adds, attacker can't spoof it)
  // or fall back to socket address. Never trust the first/arbitrary entry.
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (forwarded
    ? forwarded.split(',').map(s => s.trim()).filter(Boolean).pop()
    : null) || req.socket.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });

  const { username, password } = req.body;
  let ok = false;
  try {
    // Username comparison stays timing-safe plain text (not a secret worth hashing)
    const userOk = !!(username && ADMIN_USER &&
      crypto.timingSafeEqual(
        Buffer.from(username.padEnd(200)),
        Buffer.from(ADMIN_USER.padEnd(200))
      ));
    // Password: supports pbkdf2 hash or legacy plain text
    ok = userOk && verifyAdminPassword(password, ADMIN_PASS);
  } catch(e) {}

  if (!ok) {
    recordFailed(ip);
    trackAbuse('login_burst', ip);
    // Persist failed attempt to DB so it survives server restarts/redeploys
    const attempt = loginAttempts.get(ip);
    await db.execute(
      `INSERT INTO settings (key_name, value, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
      [`auth_fail:${ip}`, JSON.stringify({ count: attempt?.count || 1, firstAttempt: attempt?.firstAttempt || Date.now() }), new Date()]
    ).catch(() => {}); // non-fatal
    // Never reveal how many attempts remain — removes attacker intel
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }

  clearAttempts(ip);
  // Clear persisted attempts on success
  await db.execute('DELETE FROM settings WHERE key_name=?', [`auth_fail:${ip}`]).catch(() => {});
  const token = createSession(username, 'admin');
  await logActivity('Admin inició sesión');
  res.json({ ok: true, token });
});
// Emergency lockout reset — requires correct password in body, no session needed
app.post('/api/auth/clear-lockout', async (req, res) => {
  const { password } = req.body || {};
  if (!verifyAdminPassword(password, ADMIN_PASS)) {
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }
  loginAttempts.clear();
  await db.execute("DELETE FROM settings WHERE key_name LIKE 'auth_fail:%'").catch(() => {});
  res.json({ ok: true, message: 'Lockout cleared.' });
});
app.post('/api/auth/logout', async (req, res) => {
  destroySession(req.headers['x-session-token']);
  res.json({ ok: true });
});
app.get('/api/auth/verify', (req, res) => {
  const s = validateSession(req.headers['x-session-token']);
  if (!s) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: s.user });
});

// ═══════════════════════════════════════════════════════
//  CUSTOMER AUTH
// ═══════════════════════════════════════════════════════
app.post('/api/customer/register', customerAuthLimiter, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, correo y contraseña son requeridos.' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  const [existing] = await db.execute('SELECT id FROM customers WHERE email=?', [email.toLowerCase()]);
  if (existing.length) return res.status(409).json({ error: 'Este correo ya tiene una cuenta registrada.' });
  const hash = hashPassword(password);
  const [result] = await db.execute(
    'INSERT INTO customers (name,email,password_hash,created_at) VALUES (?,?,?,?)',
    [name, email.toLowerCase(), hash, new Date()]
  );
  const customer = { id: result.insertId, name, email: email.toLowerCase() };
  const token = createSession(customer, 'customer');
  await logActivity(`Nuevo cliente: ${name} (${email})`);
  await initEmailPreferencesForCustomer(customer.id).catch(() => {});
  try { await sendWelcomeEmail(customer); } catch(e) {}

  // Migrate anonymous session data to this new account
  const { sessionId: anonSession } = req.body;
  if (anonSession) {
    try {
      // Migrate scent profiles from anon session
      await db.execute(
        'UPDATE scent_profiles SET customer_id=? WHERE session_id=? AND customer_id IS NULL',
        [customer.id, anonSession]
      );
      // Migrate consult count so registration doesn't reset their daily usage
      await db.execute(
        'UPDATE consult_counts SET customer_id=? WHERE session_id=? AND customer_id IS NULL',
        [customer.id, anonSession]
      );
    } catch(e) { console.warn('Session migration error:', e.message); }
  }

  res.json({ ok: true, token, customer: { id: customer.id, name, email: customer.email } });
});

app.post('/api/customer/login', customerAuthLimiter, async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña requeridos.' });
  const [rows] = await db.execute('SELECT * FROM customers WHERE email=?', [email.toLowerCase()]);
  const customer = rows[0];
  if (!customer || !verifyPassword(password, customer.password_hash)) {
    recordFailed(ip);
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  clearAttempts(ip);
  await db.execute('UPDATE customers SET last_login=? WHERE id=?', [new Date(), customer.id]);
  const token = createSession({ id: customer.id, name: customer.name, email: customer.email }, 'customer');
  res.json({ ok: true, token, customer: { id: customer.id, name: customer.name, email: customer.email } });
});


// ── Password reset ────────────────────────────────────────────────────────────
// Tokens stored in settings table: key=reset:{token}, value=customerId, TTL 1h

app.post('/api/customer/forgot-password', customerAuthLimiter, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  // Always return 200 — never reveal if email exists (prevents enumeration)
  res.json({ ok: true });
  if (!email) return;
  try {
    const [rows] = await db.execute('SELECT id, name FROM customers WHERE email=?', [email]);
    if (!rows.length) return; // silent — user sees success either way
    const customer  = rows[0];
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await db.execute(
      `INSERT INTO settings (key_name, value, updated_at) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
      [`reset:${token}`, String(customer.id), new Date()]
    );
    const BASE     = BASE_URL || 'https://sillage-sv.com';
    const resetUrl = `${BASE}/?reset_token=${token}`;
    await sendEmail({
      to:      email,
      subject: 'Restablecer tu contraseña — Sillage Parfumerie',
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:2rem;background:#0e0c0a;color:#e8dcc8">
          <div style="font-size:0.6rem;letter-spacing:0.3em;text-transform:uppercase;color:#b8955a;margin-bottom:1.5rem">Sillage Parfumerie</div>
          <h2 style="font-weight:300;font-size:1.4rem;margin:0 0 1rem">Hola, ${escHtml(customer.name)}</h2>
          <p style="font-size:0.85rem;line-height:1.8;color:#a09080;margin:0 0 1.5rem">
            Recibimos una solicitud para restablecer la contraseña de tu cuenta.
            Si no fuiste tú, puedes ignorar este correo.
          </p>
          <a href="${resetUrl}" style="display:inline-block;padding:0.8rem 2rem;border:1px solid #b8955a;color:#b8955a;text-decoration:none;font-size:0.65rem;letter-spacing:0.2em;text-transform:uppercase">
            Restablecer Contraseña
          </a>
          <p style="font-size:0.7rem;color:#5a5050;margin-top:1.5rem">Este enlace expira en 1 hora.</p>
        </div>
      `,
    });
    await logActivity(`Solicitud de recuperación de contraseña: ${escHtml(email)}`);
  } catch(e) {
    console.error('Forgot password error:', e.message);
  }
});

app.post('/api/customer/reset-password', customerAuthLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: 'Datos inválidos.' });
  }
  try {
    const [rows] = await db.execute(
      "SELECT key_name, value, updated_at FROM settings WHERE key_name=?",
      [`reset:${token}`]
    );
    if (!rows.length) return res.status(400).json({ error: 'El enlace es inválido o ya fue usado.' });

    const row       = rows[0];
    const issuedAt  = new Date(row.updated_at).getTime();
    if (Date.now() - issuedAt > 60 * 60 * 1000) {
      await db.execute('DELETE FROM settings WHERE key_name=?', [`reset:${token}`]);
      return res.status(400).json({ error: 'El enlace ha expirado. Solicita uno nuevo.' });
    }

    const customerId = parseInt(row.value);
    const newHash    = hashPassword(password);
    await db.execute('UPDATE customers SET password_hash=? WHERE id=?', [newHash, customerId]);
    await db.execute('DELETE FROM settings WHERE key_name=?', [`reset:${token}`]);
    await logActivity(`Contraseña restablecida para cliente ID ${customerId}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('Reset password error:', e.message);
    res.status(500).json({ error: 'Error interno.' });
  }
});

app.post('/api/customer/logout', (req, res) => {
  destroySession(req.headers['x-customer-token']);
  res.json({ ok: true });
});
app.get('/api/customer/verify', (req, res) => {
  const s = validateSession(req.headers['x-customer-token']);
  if (!s || s.role !== 'customer') return res.status(401).json({ ok: false });
  res.json({ ok: true, customer: s.user });
});

// Update customer profile (name, phone, address etc.)
app.patch('/api/customer/profile', requireCustomer, async (req, res) => {
  const { name, phone, address, city, state, postcode, country } = req.body;
  const id = req.customer.user.id;
  await db.execute(
    `UPDATE customers SET
      name     = COALESCE(?, name),
      phone    = COALESCE(?, phone),
      address  = COALESCE(?, address),
      city     = COALESCE(?, city),
      state    = COALESCE(?, state),
      postcode = COALESCE(?, postcode),
      country  = COALESCE(?, country)
     WHERE id = ?`,
    [name||null, phone||null, address||null, city||null,
     state||null, postcode||null, country||null, id]
  );
  // Return updated profile
  const [rows] = await db.execute(
    'SELECT id,name,email,phone,address,city,state,postcode,country FROM customers WHERE id=?', [id]
  );
  const updated = rows[0];
  // Update session with new name
  req.customer.user.name = updated.name;
  res.json({ ok: true, customer: updated });
});

// Get full customer profile
app.get('/api/customer/profile', requireCustomer, async (req, res) => {
  const [rows] = await db.execute(
    'SELECT id,name,email,phone,address,city,state,postcode,country,created_at FROM customers WHERE id=?',
    [req.customer.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
  res.json(rows[0]);
});

// Change customer password
app.patch('/api/customer/password', requireCustomer, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas.' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
  const [rows] = await db.execute('SELECT * FROM customers WHERE id=?', [req.customer.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado.' });
  if (!verifyPassword(currentPassword, rows[0].password_hash))
    return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
  const newHash = hashPassword(newPassword);
  await db.execute('UPDATE customers SET password_hash=? WHERE id=?', [newHash, req.customer.user.id]);
  res.json({ ok: true });
});

// Delete customer account
app.delete('/api/customer/account', requireCustomer, async (req, res) => {
  const id = req.customer.user.id;
  const name  = req.customer.user.name  || 'Cliente';
  const email = req.customer.user.email || '';
  await db.execute('UPDATE orders SET customer_id=NULL WHERE customer_id=?', [id]);
  await db.execute('DELETE FROM customers WHERE id=?', [id]);
  destroySession(req.headers['x-customer-token']);
  await logActivity(`❌ Cuenta eliminada: ${name} (${email})`);
  res.json({ ok: true });
});

// Admin: delete a customer account
app.delete('/api/customers/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [rows] = await db.execute('SELECT name, email FROM customers WHERE id=?', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { name, email } = rows[0];
  await db.execute('UPDATE orders SET customer_id=NULL WHERE customer_id=?', [id]);
  await db.execute('DELETE FROM customers WHERE id=?', [id]);
  await logActivity(`❌ Cuenta eliminada por admin: ${name} (${email})`);
  res.json({ ok: true });
});

app.get('/api/customer/orders', requireCustomer, async (req, res) => {
  const orders = await getCustomerOrders(req.customer.user.id);
  res.json(orders);
});

// GET /api/orders/:id/invoice — serve HTML invoice
app.get('/api/orders/:id/invoice', optionalCustomer, async (req, res) => {
  const orderId = req.params.id;
  let orderRow  = null;

  // Admin access — unrestricted
  const isAdmin = !!req.headers['x-admin-token'];
  if (isAdmin) {
    try {
      const [rows] = await db.execute('SELECT * FROM orders WHERE id=?', [orderId]);
      if (rows.length) orderRow = rows[0];
    } catch(e) {}
    if (!orderRow) return res.status(404).send('Pedido no encontrado.');
  } else {
    // Customer — match by customer_id or email from token
    const customer = req.customer?.user;
    if (!customer) return res.status(403).send('Inicia sesión para ver tu factura.');

    try {
      const [rows] = await db.execute(
        'SELECT * FROM orders WHERE id=? AND (customer_id=? OR LOWER(email)=?)',
        [orderId, customer.id, (customer.email || '').toLowerCase()]
      );
      if (rows.length) orderRow = rows[0];
    } catch(e) { console.error('Invoice auth error:', e.message); }

    if (!orderRow) return res.status(403).send('No autorizado para ver esta factura.');
  }

  const order  = orderRow;
  const items  = JSON.parse(order.items || '[]');
  const total  = parseFloat(order.total || 0).toFixed(2);
  const date   = new Date(order.created_at).toLocaleDateString('es-ES', { day:'numeric', month:'long', year:'numeric' });

  // ── DTE legal data (if a Factura Electrónica was accepted by Hacienda) ──────
  let dte = null, dteQr = '';
  try {
    const dteRows = await dteSvc.getByOrderId(order.id);
    dte = dteRows.find(d => d.estado === 'PROCESADO') || null;
    if (dte && global._QRCode) {
      const fecEmi = new Date(dte.created_at).toISOString().slice(0, 10);
      const url    = dteSvc.verificacionUrl(dte.codigo_generacion, fecEmi);
      dteQr = await new Promise(resolve =>
        global._QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 150 },
          (e, u) => resolve(e ? '' : u))
      );
    }
  } catch(e) { console.error('Invoice DTE lookup error:', e.message); }

  // IVA breakdown: for an accepted DTE the IVA (13%) is embedded in the total.
  const ivaMonto  = dte ? (parseFloat(total) - parseFloat(total) / 1.13) : 0;
  const netoMonto = parseFloat(total) - ivaMonto;

  const dteHeaderBlock = dte ? `
        <div class="dte-legal">
          <div class="dte-legal-row"><span>Documento Tributario Electrónico</span><strong>${dte.tipo_dte === '03' ? 'Comprobante de Crédito Fiscal' : dte.tipo_dte === '05' ? 'Nota de Crédito' : 'Factura (Consumidor Final)'}</strong></div>
          <div class="dte-legal-row"><span>Número de Control</span><strong>${escHtml(dte.numero_control)}</strong></div>
          <div class="dte-legal-row"><span>Código de Generación</span><strong>${escHtml(dte.codigo_generacion)}</strong></div>
          <div class="dte-legal-row"><span>Sello de Recepción</span><strong>${escHtml(dte.sello_recibido || '—')}</strong></div>
          ${dte.ambiente === '00' ? '<div class="dte-ambiente">AMBIENTE DE PRUEBAS — SIN VALIDEZ TRIBUTARIA</div>' : ''}
        </div>` : '';

  const dteQrBlock = (dte && dteQr) ? `
        <div class="dte-qr">
          <img src="${dteQr}" alt="QR verificación MH" width="120" height="120"/>
          <div class="dte-qr-cap">Verifica este documento en<br/>admin.factura.gob.sv</div>
        </div>` : '';

  const ivaRows = dte ? `
        <div class="inv-total-row"><div class="inv-total-box">
          <div class="inv-total-label">Suma de operaciones gravadas</div>
          <div class="inv-subval">$${netoMonto.toFixed(2)}</div>
        </div></div>
        <div class="inv-total-row"><div class="inv-total-box">
          <div class="inv-total-label">IVA 13%</div>
          <div class="inv-subval">$${ivaMonto.toFixed(2)}</div>
        </div></div>` : '';

  const itemRows = items.map(i =>
    `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714;font-size:13px">${escHtml(i.name)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0e6d0;color:#8a7f72;font-size:13px;text-align:center">${i.qty}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714;font-size:13px;text-align:right">$${parseFloat(i.price||0).toFixed(2)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714;font-size:13px;text-align:right">$${parseFloat(i.total||0).toFixed(2)}</td>
    </tr>`
  ).join('');

  const html = `<!DOCTYPE html><html lang="es"><head>
    <meta charset="UTF-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <meta name="email-obfuscation" content="off"/>
    <title>Factura ${escHtml(order.id)} — Sillage Parfumerie</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f0e8;padding:2rem 1rem;color:#1a1714}
      .invoice{max-width:620px;margin:0 auto;background:#fff;border:1px solid #e8d8b8}
      .inv-header{background:#0e0c0a;padding:28px 36px;display:flex;justify-content:space-between;align-items:flex-start}
      .inv-logo{font-family:Georgia,serif;font-size:22px;font-weight:300;letter-spacing:6px;color:#b8955a;text-transform:uppercase}
      .inv-logo-sub{font-size:9px;letter-spacing:3px;color:#8a7f72;text-transform:uppercase;margin-top:3px}
      .inv-label{text-align:right}
      .inv-label-title{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8955a}
      .inv-label-id{font-family:Georgia,serif;font-size:14px;color:#e8dcc8;margin-top:3px}
      .inv-label-date{font-size:11px;color:#8a7f72;margin-top:2px}
      .inv-body{padding:28px 36px}
      .inv-section{margin-bottom:20px}
      .inv-section-title{font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#b8955a;margin-bottom:8px}
      .inv-value{font-size:13px;color:#1a1714;line-height:1.7}
      table{width:100%;border-collapse:collapse}
      thead tr{background:#f5f0e8}
      th{padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8a7f72;font-weight:400}
      th:last-child,th:nth-child(3){text-align:right}
      th:nth-child(2){text-align:center}
      .inv-total-row{display:flex;justify-content:flex-end;padding:16px 0 0}
      .inv-total-box{text-align:right}
      .inv-total-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8a7f72;margin-bottom:4px}
      .inv-total-val{font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714}
      .inv-footer{padding:16px 36px 24px;border-top:1px solid #f0e6d0;font-size:10px;color:#aaa;text-align:center;line-height:1.7}
      @media print{body{background:#fff;padding:0}.inv-footer{display:none}}
      .print-btn{display:block;width:100%;max-width:200px;margin:1.5rem auto 0;padding:10px;background:#b8955a;border:none;color:#0e0c0a;font-family:inherit;font-size:11px;letter-spacing:2px;text-transform:uppercase;cursor:pointer}
      @media print{.print-btn{display:none}}
      .dte-legal{margin-top:14px;padding:12px 0 0;border-top:1px dashed #d8c8a8}
      .dte-legal-row{display:flex;justify-content:space-between;gap:1rem;font-size:10px;color:#8a7f72;padding:3px 0}
      .dte-legal-row strong{color:#1a1714;font-weight:600;text-align:right;word-break:break-all;max-width:62%}
      .dte-ambiente{margin-top:8px;padding:5px 8px;background:#fdf3d8;border:1px solid #e8d8b8;color:#9a7b2a;font-size:9px;letter-spacing:1px;text-align:center;text-transform:uppercase}
      .dte-block{display:flex;justify-content:space-between;align-items:flex-start;gap:1.5rem;margin-top:8px}
      .dte-qr{text-align:center;flex-shrink:0}
      .dte-qr img{border:1px solid #f0e6d0}
      .dte-qr-cap{font-size:8px;color:#aaa;margin-top:4px;line-height:1.4}
      .inv-subval{font-family:Georgia,serif;font-size:14px;color:#5a5249}
    </style>
  </head><body>
    <div class="invoice">
      <div class="inv-header">
        <div><div class="inv-logo">Sillage</div><div class="inv-logo-sub">Parfumerie</div></div>
        <div class="inv-label">
          <div class="inv-label-title">${dte ? (dte.tipo_dte === '03' ? 'Crédito Fiscal' : dte.tipo_dte === '05' ? 'Nota de Crédito' : 'Factura Electrónica') : 'Factura'}</div>
          <div class="inv-label-id">${escHtml(order.id)}</div>
          <div class="inv-label-date">${date}</div>
        </div>
      </div>
      <div class="inv-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:24px">
          <div class="inv-section">
            <div class="inv-section-title">Cliente</div>
            <div class="inv-value">
              ${escHtml(order.customer)}<br/>
              ${escHtml(order.email).replace('@', '&#64;')}<br/>
              ${order.phone ? escHtml(order.phone) : ''}
            </div>
          </div>
          <div class="inv-section">
            <div class="inv-section-title">Enviar a</div>
            <div class="inv-value">
              ${escHtml(order.address || '')}<br/>
              ${escHtml(order.city || '')}${order.state ? ', '+escHtml(order.state) : ''}<br/>
              ${escHtml(order.country || '')}
            </div>
          </div>
        </div>
        <div class="inv-section">
          <div class="inv-section-title">Detalle del Pedido</div>
          <table>
            <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Total</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>
        ${ivaRows}
        <div class="inv-total-row">
          <div class="inv-total-box">
            <div class="inv-total-label">${dte ? 'Total a pagar' : 'Total'}</div>
            <div class="inv-total-val">$${total}</div>
          </div>
        </div>
        ${dte ? `<div class="dte-block">${dteHeaderBlock}${dteQrBlock}</div>` : ''}
      </div>
      <div class="inv-footer">
        Sillage Parfumerie · El Salvador · sillage-sv.com<br/>
        ${dte && cfg.DTE_EMISOR.nit ? 'NIT '+escHtml(cfg.DTE_EMISOR.nit)+(cfg.DTE_EMISOR.nrc?' · NRC '+escHtml(cfg.DTE_EMISOR.nrc):'')+'<br/>' : ''}
        Gracias por tu compra
      </div>
    </div>
    <button class="print-btn" onclick="window.print()">Imprimir</button>
  </body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── DTE / Factura Electrónica admin routes ───────────────────────────────────

// GET /api/admin/orders/:id/dte — list DTE records emitted for an order
app.get('/api/admin/orders/:id/dte', requireAdmin, async (req, res) => {
  try {
    const rows = await dteSvc.getByOrderId(req.params.id);
    res.json(rows.map(r => ({
      id:               r.id,
      tipoDte:          r.tipo_dte,
      estado:           r.estado,
      ambiente:         r.ambiente,
      numeroControl:    r.numero_control,
      codigoGeneracion: r.codigo_generacion,
      selloRecibido:    r.sello_recibido,
      observaciones:    r.observaciones,
      createdAt:        r.created_at,
    })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/orders/:id/dte — manually emit / retry a DTE
// Body: { tipoDte?: '01'|'03'|'05', receptor?: {...}, docRelacionado?: {...} }
app.post('/api/admin/orders/:id/dte', requireAdmin, async (req, res) => {
  if (!cfg.DTE_ENABLED) {
    return res.status(409).json({ error: 'DTE deshabilitado. Configura DTE_ENABLED=true y las credenciales del Ministerio de Hacienda.' });
  }
  const { tipoDte, receptor, docRelacionado } = req.body || {};
  if (tipoDte === '03' && (!receptor || !receptor.nit || !receptor.nrc)) {
    return res.status(400).json({ error: 'El Crédito Fiscal requiere receptor con NIT y NRC.' });
  }
  try {
    const rec = await emitDteForOrder(req.params.id, { tipoDte: tipoDte || '01', receptor, docRelacionado });
    if (!rec) return res.status(404).json({ error: 'Pedido no encontrado o DTE ya emitido.' });
    res.json({
      ok:    rec.estado === 'PROCESADO',
      estado: rec.estado,
      numeroControl:    rec.numeroControl,
      codigoGeneracion: rec.codigoGeneracion,
      selloRecibido:    rec.selloRecibido,
      observaciones:    rec.observaciones,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/dte/test — emite una FACTURA DE PRUEBA (orden ficticia) para
// validar el circuito completo: firmador → Hacienda → sello. No crea un pedido real.
// Genera una orden ficticia ALEATORIA con productos reales del catálogo para
// estresar el JSON (nombres con tildes/ñ, varios ítems, montos y redondeos de IVA
// distintos, métodos de pago variados). Body opcional: { items: N } fija la cantidad
// de ítems para reproducir un caso.
const _DTE_TEST_CLIENTES = [
  'José Peña Martínez', 'María Fernández Ñúñez', 'Andrés Villalobos',
  'Wendy Guzmán Cañas', 'Óscar Iraheta', 'Ángela Domínguez', 'Consumidor Final',
];
const _DTE_TEST_PAGOS = ['wompi', 'btcpay', 'cod'];
async function buildRandomTestOrder(opts = {}) {
  const cat = await getCatalogue().catch(() => []);
  const pool = (cat || []).filter(p => p && parseFloat(p.price) > 0);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  let nItems = opts.items ? Math.max(1, Math.min(6, parseInt(opts.items, 10) || 1))
                          : 1 + Math.floor(Math.random() * 4); // 1-4
  const items = [];
  for (let i = 0; i < nItems; i++) {
    if (pool.length) {
      const p = pick(pool);
      items.push({ name: `${p.brand} ${p.name}`.slice(0, 200), qty: 1 + Math.floor(Math.random() * 3), price: parseFloat(p.price) });
    } else {
      items.push({ name: 'Producto de prueba DTE', qty: 1, price: 11.30 });
    }
  }
  const total = Math.round(items.reduce((s, it) => s + it.qty * it.price, 0) * 100) / 100;
  return {
    id:             'TEST-' + Date.now(),
    customer:       pick(_DTE_TEST_CLIENTES),
    email:          cfg.DTE_EMISOR.correo || 'prueba@sillage-sv.com',
    phone:          null,
    payment_method: pick(_DTE_TEST_PAGOS),
    items:          JSON.stringify(items),
    total,
  };
}

app.post('/api/admin/dte/test', requireAdmin, async (req, res) => {
  if (!cfg.DTE_ENABLED) {
    return res.status(409).json({ error: 'DTE deshabilitado. Configura DTE_ENABLED=true.' });
  }
  try {
    const fakeOrder = await buildRandomTestOrder(req.body || {});
    const rec = await dteSvc.emitForOrder(fakeOrder, { tipoDte: '01' });
    const items = JSON.parse(fakeOrder.items);
    res.json({
      ok:               rec && rec.estado === 'PROCESADO',
      ambiente:         cfg.DTE_AMBIENTE,
      estado:           rec?.estado,
      numeroControl:    rec?.numeroControl,
      codigoGeneracion: rec?.codigoGeneracion,
      selloRecibido:    rec?.selloRecibido,
      observaciones:    rec?.observaciones,
      // Resumen de lo que se generó (para verlo en el panel)
      prueba: {
        customer:      fakeOrder.customer,
        paymentMethod: fakeOrder.payment_method,
        numItems:      items.length,
        total:         fakeOrder.total,
      },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  PRUEBAS DE HOMOLOGACIÓN (MH) — emitir lotes de FC/CCF/NC hasta cumplir las
//  metas obligatorias del ambiente de pruebas antes de pedir autorización.
// ════════════════════════════════════════════════════════════════════════════
const DTE_HOMOLOGACION = [
  { tipoDte: '01', label: 'Factura (Consumidor Final)',     target: 90 },
  { tipoDte: '03', label: 'Comprobante de Crédito Fiscal',  target: 75 },
  { tipoDte: '05', label: 'Nota de Crédito',                target: 50 },
  { tipoDte: 'AN', label: 'Evento de Invalidación',         target: 15 },
  { tipoDte: 'CG', label: 'Evento de Contingencia',         target: 15 },
];

// Motivo de contingencia de prueba (responsable = el emisor).
function buildTestMotivoContingencia() {
  const e = cfg.DTE_EMISOR;
  return {
    nombreResponsable:    e.nombre,
    tipoDocResponsable:   '36',            // 36 = NIT
    numeroDocResponsable: e.nit,
    tipoContingencia:     1,               // CAT-018: 1 = No disponibilidad de sistema del MH
    motivoContingencia:   null,
  };
}

// Motivo de anulación de prueba (responsable/solicita = el emisor).
function buildTestMotivoAnulacion() {
  const e = cfg.DTE_EMISOR;
  return {
    tipoAnulacion:     2,                 // 2 = anulación definitiva sin reemplazo
    motivoAnulacion:   'Anulación de prueba de homologación',
    nombreResponsable: e.nombre,
    tipDocResponsable: '36',              // 36 = NIT
    numDocResponsable: e.nit,
    nombreSolicita:    e.nombre,
    tipDocSolicita:    '36',
    numDocSolicita:    e.nit,
  };
}

// Receptor de prueba (empresa) para CCF/NC — NIT/NRC distintos al emisor (MH rechaza auto-factura).
// NIT 06140101011034 = empresa de prueba estándar de la normativa MH (14 dígitos sin guiones).
function buildTestReceptor() {
  const e = cfg.DTE_EMISOR;
  return {
    nit:           '06140812951023',
    nrc:           '899100',
    nombre:        'EMPRESA RECEPTORA DE PRUEBA, S.A. DE C.V.',
    nombreComercial: 'Empresa de Prueba',
    codActividad:  e.codActividad,   // CAT-019 válido (47722)
    descActividad: e.descActividad,
    departamento:  e.departamento,   // 08 — La Paz (códigos ya validados con el MH)
    municipio:     e.municipio,      // 23 — La Paz Oeste
    distrito:      e.distrito,       // 11 — San Juan Talpa
    complemento:   'Km 40 Carretera al Puerto, San Juan Talpa, La Paz',
    telefono:      '25551234',
    correo:        'receptor-prueba@example.com',
  };
}

async function homologacionCounts() {
  const [rows] = await db.execute(
    "SELECT tipo_dte, COUNT(*) c FROM dte_documents WHERE estado='PROCESADO' AND ambiente=? GROUP BY tipo_dte",
    [cfg.DTE_AMBIENTE]
  ).catch(() => [[]]);
  const map = {};
  (rows || []).forEach(r => { map[r.tipo_dte] = r.c; });
  return DTE_HOMOLOGACION.map(h => ({ ...h, done: map[h.tipoDte] || 0 }));
}

// Último CCF PROCESADO (para que la Nota de Crédito lo referencie).
// IMPORTANTE: la NC debe ajustar montos que correspondan al CCF referenciado — el MH
// rechaza [020] resumen.totalIva si la NC trae una orden aleatoria sin relación con el
// CCF (los montos "no cuadran" con el documento que dice estar ajustando). Por eso aquí
// también reconstruimos los ítems EXACTOS del CCF (precioUni neto → precio con IVA) para
// que la NC de homologación ajuste el mismo importe.
async function latestProcessedCCF() {
  const [rows] = await db.execute(
    "SELECT codigo_generacion, json_dte FROM dte_documents WHERE tipo_dte='03' AND estado='PROCESADO' AND ambiente=? ORDER BY id DESC LIMIT 1",
    [cfg.DTE_AMBIENTE]
  ).catch(() => [[]]);
  if (!rows || !rows.length) return null;
  let fecEmi = new Date().toISOString().slice(0, 10);
  let ccfJson = null;
  try {
    ccfJson = JSON.parse(rows[0].json_dte);
    fecEmi = ccfJson.identificacion.fecEmi || fecEmi;
  } catch(e) {}
  return { codigoGeneracion: rows[0].codigo_generacion, fecEmi, ccfJson };
}

app.get('/api/admin/dte/homologacion', requireAdmin, async (req, res) => {
  try {
    res.json({ ambiente: cfg.DTE_AMBIENTE, items: await homologacionCounts(), latestCcf: await latestProcessedCCF() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dte/homologacion/emit  body: { tipoDte, count? }
// Emite hasta `count` (máx 10) documentos de prueba del tipo indicado.
app.post('/api/admin/dte/homologacion/emit', requireAdmin, async (req, res) => {
  if (!cfg.DTE_ENABLED) return res.status(409).json({ error: 'DTE deshabilitado.' });
  const tipoDte = String((req.body && req.body.tipoDte) || '01');
  if (!DTE_HOMOLOGACION.some(h => h.tipoDte === tipoDte)) {
    return res.status(400).json({ error: 'tipoDte no soportado para homologación (usa 01, 03, 05 o AN).' });
  }
  const count = Math.max(1, Math.min(10, parseInt((req.body && req.body.count), 10) || 1));

  // Evento de Invalidación: emitir una Factura fresca y anularla en el acto.
  if (tipoDte === 'AN') {
    try {
      const results = [];
      for (let i = 0; i < count; i++) {
        const order = await buildRandomTestOrder({});
        const fc = await dteSvc.emitForOrder(order, { tipoDte: '01' });
        if (!fc || fc.estado !== 'PROCESADO') {
          results.push({ estado: 'ERROR', observaciones: 'No se pudo emitir la Factura base para anular: ' + (fc?.observaciones || 'fallo') });
          break;
        }
        const [rows] = await db.execute('SELECT * FROM dte_documents WHERE codigo_generacion=?', [fc.codigoGeneracion]);
        if (!rows || !rows.length) { results.push({ estado: 'ERROR', observaciones: 'No se encontró la Factura recién emitida.' }); break; }
        const rec = await dteSvc.invalidarDte(rows[0], buildTestMotivoAnulacion());
        results.push({ estado: rec?.estado || 'ERROR', numeroControl: rec?.numeroControl || null, observaciones: rec?.observaciones || null });
        if (rec && rec.estado !== 'PROCESADO') break;
      }
      const items = await homologacionCounts();
      const cur = items.find(h => h.tipoDte === 'AN');
      return res.json({
        tipoDte: 'AN', emitted: results.length,
        procesados: results.filter(r => r.estado === 'PROCESADO').length,
        results, done: cur ? cur.done : null, target: cur ? cur.target : null,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // Evento de Contingencia: genera una Factura en modo contingencia y declara el evento.
  if (tipoDte === 'CG') {
    try {
      const results = [];
      for (let i = 0; i < count; i++) {
        const order = await buildRandomTestOrder({});
        const rec = await dteSvc.emitContingencia([order], buildTestMotivoContingencia());
        results.push({ estado: rec?.estado || 'ERROR', numeroControl: rec?.numeroControl || null, observaciones: rec?.observaciones || null });
        if (rec && rec.estado !== 'PROCESADO') break;
      }
      const items = await homologacionCounts();
      const cur = items.find(h => h.tipoDte === 'CG');
      return res.json({
        tipoDte: 'CG', emitted: results.length,
        procesados: results.filter(r => r.estado === 'PROCESADO').length,
        results, done: cur ? cur.done : null, target: cur ? cur.target : null,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  try {
    const results = [];
    for (let i = 0; i < count; i++) {
      const options = { tipoDte };
      if (tipoDte === '03' || tipoDte === '05') {
        const custom = req.body && req.body.receptor;
        options.receptor = (custom && custom.nit && custom.nrc && custom.nombre)
          ? { ...buildTestReceptor(), nit: custom.nit, nrc: custom.nrc, nombre: custom.nombre, nombreComercial: custom.nombre }
          : buildTestReceptor();
      }
      let order = null;
      if (tipoDte === '05') {
        const ccf = await latestProcessedCCF();
        if (!ccf || !ccf.ccfJson) { results.push({ estado: 'ERROR', observaciones: 'No hay un CCF PROCESADO para referenciar. Emite primero un CCF.' }); break; }
        options.docRelacionado = ccf;
        // Copiar los montos EXACTOS del CCF (sin recalcular) — evita [020] por
        // descuadre con lo que el MH tiene registrado para ese CCF.
        options.ccfJsonExacto = ccf.ccfJson;
        order = { id: 'NC-' + Date.now() }; // no se usa: buildNotaCreditoExacta ignora `order`
      } else {
        order = await buildRandomTestOrder({});
      }
      const rec = await dteSvc.emitForOrder(order, options);
      results.push({
        estado:        rec?.estado || 'ERROR',
        numeroControl: rec?.numeroControl || null,
        observaciones: rec?.observaciones || null,
      });
      if (rec && rec.estado !== 'PROCESADO') break; // si uno falla, parar para no repetir el error
    }
    const items = await homologacionCounts();
    const cur = items.find(h => h.tipoDte === tipoDte);
    res.json({
      tipoDte,
      emitted:    results.length,
      procesados: results.filter(r => r.estado === 'PROCESADO').length,
      results,
      done:       cur ? cur.done : null,
      target:     cur ? cur.target : null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dte/emit-manual — emite un DTE con los detalles reales capturados a mano.
// Sirve igual en homologación y en PRODUCCIÓN: el admin escribe cliente, ítems y pago.
//   body: { tipoDte, receptor?:{nit,nrc,nombre}, customer?, email?, phone?,
//           paymentMethod?, items:[{name,qty,price}] }  (price = IVA incluido)
app.post('/api/admin/dte/emit-manual', requireAdmin, async (req, res) => {
  if (!cfg.DTE_ENABLED) return res.status(409).json({ error: 'DTE deshabilitado.' });
  const b = req.body || {};
  const tipoDte = String(b.tipoDte || '03');
  if (!['01', '03', '05'].includes(tipoDte)) {
    return res.status(400).json({ error: 'tipoDte no soportado (usa 01, 03 o 05).' });
  }

  // Normalizar e validar ítems
  const rawItems = Array.isArray(b.items) ? b.items : [];
  const items = rawItems
    .map(it => ({
      name:  String(it.name || it.descripcion || '').trim().slice(0, 200),
      qty:   Math.max(1, parseInt(it.qty, 10) || 0),
      price: Math.round((parseFloat(it.price) || 0) * 100) / 100,
    }))
    .filter(it => it.name && it.qty > 0 && it.price > 0);
  if (!items.length) {
    return res.status(400).json({ error: 'Agrega al menos un ítem con descripción, cantidad y precio.' });
  }
  const total = Math.round(items.reduce((s, it) => s + it.qty * it.price, 0) * 100) / 100;

  const order = {
    id:             String(b.orderId || ('MAN-' + Date.now())),
    customer:       String(b.customer || 'Consumidor Final').slice(0, 250),
    email:          String(b.email || cfg.DTE_EMISOR.correo || '').slice(0, 100) || null,
    phone:          b.phone ? String(b.phone).slice(0, 30) : null,
    payment_method: String(b.paymentMethod || 'cod'),
    items:          JSON.stringify(items),
    total,
  };

  try {
    const options = { tipoDte };
    if (tipoDte === '03' || tipoDte === '05') {
      const r = b.receptor || {};
      // El esquema oficial del MH exige TODOS estos campos en el receptor de un
      // CCF/NC. Antes se rellenaban con un "receptor de prueba" hardcodeado
      // (teléfono/correo/dirección falsos) cuando el admin no los daba — un DTE
      // real terminaba con datos de una empresa ficticia. Ahora son obligatorios.
      const required = ['nit', 'nrc', 'nombre', 'telefono', 'complemento', 'departamento', 'municipio', 'distrito', 'codActividad', 'descActividad'];
      const missing  = required.filter(k => !String(r[k] || '').trim());
      if (missing.length) {
        return res.status(400).json({ error: `CCF/NC requiere los datos completos del receptor. Falta: ${missing.join(', ')}.` });
      }
      options.receptor = {
        nit: r.nit, nrc: r.nrc, nombre: r.nombre, nombreComercial: r.nombre,
        telefono: r.telefono, complemento: r.complemento,
        departamento: r.departamento, municipio: r.municipio, distrito: r.distrito,
        codActividad: r.codActividad, descActividad: r.descActividad,
        correo: r.correo || null, // buildReceptorCCF cae a order.email si viene vacío
      };
    }
    if (tipoDte === '05') {
      const ccf = await latestProcessedCCF();
      if (!ccf) return res.status(409).json({ error: 'No hay un CCF PROCESADO para referenciar. Emite un CCF primero.' });
      options.docRelacionado = ccf;
    }
    const rec = await dteSvc.emitForOrder(order, options);
    res.json({
      ok:            rec && rec.estado === 'PROCESADO',
      estado:        rec?.estado || 'ERROR',
      numeroControl: rec?.numeroControl || null,
      selloRecibido: rec?.selloRecibido || null,
      observaciones: rec?.observaciones || null,
      total,
      numItems:      items.length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/dte/contingencia/pending — estado de caída del MH + documentos pendientes.
app.get('/api/admin/dte/contingencia/pending', requireAdmin, async (req, res) => {
  try {
    const docs = await dteSvc.pendingContingenciaDocs();
    res.json({
      mh: dteSvc.mhDownStatus(),
      pendientes: docs.map(d => ({
        id: d.id, orderId: d.order_id, tipoDte: d.tipo_dte,
        numeroControl: d.numero_control, codigoGeneracion: d.codigo_generacion, createdAt: d.created_at,
      })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dte/contingencia/declarar — declara el evento por los pendientes y los transmite.
app.post('/api/admin/dte/contingencia/declarar', requireAdmin, async (req, res) => {
  if (!cfg.DTE_ENABLED) return res.status(409).json({ error: 'DTE deshabilitado.' });
  try {
    const motivo = {
      ...buildTestMotivoContingencia(),
      motivoContingencia: (req.body && req.body.motivo) || 'Restablecimiento tras no disponibilidad del MH',
    };
    const result = await dteSvc.declararYTransmitirPendientes(motivo);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/dte/invalidables — DTEs PROCESADOS que se pueden anular (ambiente actual).
app.get('/api/admin/dte/invalidables', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT id, order_id, tipo_dte, numero_control, codigo_generacion, created_at
         FROM dte_documents
        WHERE estado='PROCESADO' AND ambiente=? AND tipo_dte NOT IN ('AN','CG')
        ORDER BY id DESC LIMIT 100`,
      [cfg.DTE_AMBIENTE]
    );
    res.json((rows || []).map(r => ({
      id: r.id, orderId: r.order_id, tipoDte: r.tipo_dte,
      numeroControl: r.numero_control, codigoGeneracion: r.codigo_generacion, createdAt: r.created_at,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dte/invalidar — anula un DTE PROCESADO específico.
//   body: { dteId, tipoAnulacion?, motivoAnulacion?, codigoGeneracionR? }
app.post('/api/admin/dte/invalidar', requireAdmin, async (req, res) => {
  if (!cfg.DTE_ENABLED) return res.status(409).json({ error: 'DTE deshabilitado.' });
  const dteId = parseInt((req.body && req.body.dteId), 10);
  if (!dteId) return res.status(400).json({ error: 'Falta dteId.' });
  try {
    const [rows] = await db.execute('SELECT * FROM dte_documents WHERE id=?', [dteId]);
    if (!rows || !rows.length) return res.status(404).json({ error: 'DTE no encontrado.' });
    const doc = rows[0];
    if (doc.estado !== 'PROCESADO' || !doc.sello_recibido) {
      return res.status(409).json({ error: 'Solo se puede invalidar un DTE PROCESADO con sello.' });
    }
    const motivo = {
      ...buildTestMotivoAnulacion(),
      tipoAnulacion:   parseInt((req.body && req.body.tipoAnulacion), 10) || 2,
      motivoAnulacion: (req.body && req.body.motivoAnulacion) || 'Anulación solicitada por el emisor',
      codigoGeneracionR: (req.body && req.body.codigoGeneracionR) || null,
    };
    const rec = await dteSvc.invalidarDte(doc, motivo);
    res.json({
      ok:            rec && rec.estado === 'PROCESADO',
      estado:        rec?.estado || 'ERROR',
      selloRecibido: rec?.selloRecibido || null,
      observaciones: rec?.observaciones || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/dte/status — configuración + conteos + correlativos (no contacta al MH)
app.get('/api/admin/dte/status', requireAdmin, async (req, res) => {
  try {
    const [counts] = await db.execute('SELECT estado, COUNT(*) c FROM dte_documents GROUP BY estado').catch(() => [[]]);
    const [corr]   = await db.execute('SELECT tipo_dte, cod_estable, cod_punto_venta, ambiente, seq FROM dte_correlativos ORDER BY ambiente, tipo_dte, cod_estable, cod_punto_venta').catch(() => [[]]);
    const byEstado = {};
    (counts || []).forEach(r => { byEstado[r.estado] = r.c; });
    res.json({
      enabled:    cfg.DTE_ENABLED,
      ambiente:   cfg.DTE_AMBIENTE,          // 00 pruebas / 01 producción
      mhBase:     cfg.DTE_MH_BASE,
      apiUser:    cfg.DTE_API_USER,
      apiPwdSet:  !!cfg.DTE_API_PWD,
      certPwdSet: !!cfg.DTE_CERT_PWD,
      firmadorUrl: cfg.DTE_FIRMADOR_URL,
      mhDown:     dteSvc.mhDownStatus(),
      emisor: {
        nombre:          cfg.DTE_EMISOR.nombre,
        nombreComercial: cfg.DTE_EMISOR.nombreComercial,
        nit:             cfg.DTE_EMISOR.nit,
        nrc:             cfg.DTE_EMISOR.nrc,
        actividad:       cfg.DTE_EMISOR.descActividad,
        direccion:       cfg.DTE_EMISOR.complemento,
        correo:          cfg.DTE_EMISOR.correo,
      },
      counts:       byEstado,
      correlativos: corr || [],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/dte/documents?estado=&limit= — lista de DTEs emitidos
app.get('/api/admin/dte/documents', requireAdmin, async (req, res) => {
  try {
    const estado = req.query.estado;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    let sql = 'SELECT id, order_id, tipo_dte, ambiente, estado, numero_control, codigo_generacion, sello_recibido, observaciones, created_at FROM dte_documents';
    const params = [];
    if (estado) { sql += ' WHERE estado=?'; params.push(estado); }
    sql += ' ORDER BY id DESC LIMIT ' + limit;
    const [rows] = await db.execute(sql, params);
    res.json((rows || []).map(r => {
      const fecEmi = (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)).slice(0, 10);
      return {
        id:               r.id,
        orderId:          r.order_id,
        tipoDte:          r.tipo_dte,
        ambiente:         r.ambiente,
        estado:           r.estado,
        numeroControl:    r.numero_control,
        codigoGeneracion: r.codigo_generacion,
        selloRecibido:    r.sello_recibido,
        observaciones:    r.observaciones,
        createdAt:        r.created_at,
        verificacionUrl:  r.codigo_generacion ? dteSvc.verificacionUrl(r.codigo_generacion, fecEmi) : null,
      };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dte/ping — diagnóstico de conectividad (firmador + auth MH)
app.post('/api/admin/dte/ping', requireAdmin, async (req, res) => {
  try {
    res.json(await dteSvc.checkConnectivity());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/dte/documents/:id/json — JSON del DTE (sin firmar + firmado/JWS).
// ?download=1 fuerza descarga como archivo.
app.get('/api/admin/dte/documents/:id/json', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, order_id, tipo_dte, numero_control, codigo_generacion, estado, json_dte, json_firmado FROM dte_documents WHERE id=?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'DTE no encontrado' });
    const r = rows[0];
    let jsonDte;
    try { jsonDte = JSON.parse(r.json_dte); } catch(e) { jsonDte = r.json_dte; }
    const payload = {
      id:               r.id,
      orderId:          r.order_id,
      tipoDte:          r.tipo_dte,
      numeroControl:    r.numero_control,
      codigoGeneracion: r.codigo_generacion,
      estado:           r.estado,
      jsonDte,
      jsonFirmado:      r.json_firmado || null,
    };
    if (req.query.download) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dte-${r.numero_control || r.id}.json"`);
      return res.send(JSON.stringify(payload, null, 2));
    }
    res.json(payload);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/orders/:id/dte/json — JSON del DTE más reciente de un pedido.
app.get('/api/admin/orders/:id/dte/json', requireAdmin, async (req, res) => {
  try {
    const rows = await dteSvc.getByOrderId(req.params.id);
    if (!rows.length) return res.status(404).json({ error: 'El pedido no tiene DTE emitido' });
    const r = rows[0]; // más reciente (getByOrderId ordena DESC)
    let jsonDte;
    try { jsonDte = JSON.parse(r.json_dte); } catch(e) { jsonDte = r.json_dte; }
    res.json({
      id: r.id, orderId: r.order_id, tipoDte: r.tipo_dte, estado: r.estado,
      numeroControl: r.numero_control, codigoGeneracion: r.codigo_generacion,
      jsonDte, jsonFirmado: r.json_firmado || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Customer addresses CRUD ──────────────────────────────────────────────────

// GET /api/customer/addresses — list all addresses for the logged-in customer
app.get('/api/customer/addresses', requireCustomer, async (req, res) => {
  const id = req.customer.user.id;
  const [rows] = await db.execute(
    'SELECT id,label,line,city,state,postcode,country,phone,is_default FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC, id ASC',
    [id]
  );
  res.json(rows);
});

// POST /api/customer/addresses — add a new address
app.post('/api/customer/addresses', requireCustomer, async (req, res) => {
  const id      = req.customer.user.id;
  const { label, line, city, state, postcode, country, phone, is_default } = req.body;
  if (!line || !city) return res.status(400).json({ error: 'Dirección y ciudad son requeridas.' });

  const n = new Date();

  // Duplicate check — same line + city + country (case-insensitive) for this customer
  const normLine    = String(line).trim().toLowerCase();
  const normCity    = String(city).trim().toLowerCase();
  const normCountry = String(country || 'El Salvador').trim().toLowerCase();
  const [dupes] = await db.execute(
    `SELECT id FROM customer_addresses
     WHERE customer_id=?
       AND LOWER(TRIM(line))=?
       AND LOWER(TRIM(city))=?
       AND LOWER(TRIM(country))=?
     LIMIT 1`,
    [id, normLine, normCity, normCountry]
  );
  if (dupes.length) {
    return res.status(409).json({ error: 'Ya tienes una dirección guardada en esa ubicación.' });
  }

  // If new address is default, unset all others first
  if (is_default) {
    await db.execute('UPDATE customer_addresses SET is_default=0 WHERE customer_id=?', [id]);
  }
  // If this is the first address, make it default automatically
  const [existing] = await db.execute('SELECT COUNT(*) as cnt FROM customer_addresses WHERE customer_id=?', [id]);
  const makeDefault = is_default || existing[0].cnt === 0 ? 1 : 0;

  const [result] = await db.execute(
    `INSERT INTO customer_addresses (customer_id,label,line,city,state,postcode,country,phone,is_default,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id,
     String(label||'Mi dirección').slice(0,100),
     String(line).slice(0,500),
     String(city).slice(0,100),
     state  ? String(state).slice(0,100)  : null,
     postcode ? String(postcode).slice(0,20) : null,
     String(country||'El Salvador').slice(0,100),
     phone  ? String(phone).slice(0,50)   : null,
     makeDefault, n]
  );
  const [addr] = await db.execute(
    'SELECT id,label,line,city,state,postcode,country,phone,is_default FROM customer_addresses WHERE id=?',
    [result.insertId]
  );
  res.json({ ok: true, address: addr[0] });
});

// DELETE /api/customer/addresses/:addrId — delete an address
app.delete('/api/customer/addresses/:addrId', requireCustomer, async (req, res) => {
  const customerId = req.customer.user.id;
  const addrId     = parseInt(req.params.addrId);
  if (!addrId) return res.status(400).json({ error: 'ID inválido' });

  const [rows] = await db.execute(
    'SELECT id, is_default FROM customer_addresses WHERE id=? AND customer_id=?',
    [addrId, customerId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Dirección no encontrada' });

  await db.execute('DELETE FROM customer_addresses WHERE id=?', [addrId]);

  // If deleted address was default, promote the oldest remaining one
  if (rows[0].is_default) {
    await db.execute(
      'UPDATE customer_addresses SET is_default=1 WHERE customer_id=? ORDER BY id ASC LIMIT 1',
      [customerId]
    );
  }
  res.json({ ok: true });
});

// PATCH /api/customer/addresses/:addrId/default — set as default
app.patch('/api/customer/addresses/:addrId/default', requireCustomer, async (req, res) => {
  const customerId = req.customer.user.id;
  const addrId     = parseInt(req.params.addrId);
  if (!addrId) return res.status(400).json({ error: 'ID inválido' });

  const [rows] = await db.execute(
    'SELECT id FROM customer_addresses WHERE id=? AND customer_id=?', [addrId, customerId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Dirección no encontrada' });

  await db.execute('UPDATE customer_addresses SET is_default=0 WHERE customer_id=?', [customerId]);
  await db.execute('UPDATE customer_addresses SET is_default=1 WHERE id=?', [addrId]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
//  PUBLIC STORE ROUTES
// ═══════════════════════════════════════════════════════
app.get('/api/health',    (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/inventory', async (req, res) => res.json(await getInventoryMap()));
app.get('/api/pricing',   async (req, res) => res.json(await getPricingMap()));
// GET /api/session/init — issues a server-signed anonymous session ID
// Frontend must call this first; sessions not issued by the server are rejected
// Rate limited: max 5 new sessions per IP per hour to prevent session farming.
// Reusing an existing session (?existing=) never counts against this, so a
// normal repeat visitor (localStorage intact) never hits it — only genuinely
// new sessions do. 5/hour still leaves headroom for a real shopper bouncing
// through Meta's in-app browser (which sometimes drops localStorage between
// opens), while raising the cost for a farm requesting dozens per IP.
const _sessionInitTracker = new Map();
const SESSION_INIT_MAX    = 5;
const SESSION_INIT_WINDOW = 60 * 60 * 1000; // 1 hour

app.get('/api/session/init', (req, res) => {
  // If client already has a valid session, reuse it (no rate limit on reuse)
  const existing = req.query.existing;
  if (existing && isValidAnonSession(existing)) {
    return res.json({ sessionId: existing, reused: true });
  }

  // Rate limit new session issuance by IP
  const ip = (req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',').map(s => s.trim()).filter(Boolean).pop()
    : null) || req.socket.remoteAddress || 'unknown';
  // Solo para contexto visual en el log de actividad del admin — NUNCA se usa
  // para relajar la verificación, el User-Agent lo controla el cliente y
  // cualquier bot puede falsificarlo con solo copiar el de un navegador real.
  const ua = String(req.headers['user-agent'] || 'sin User-Agent').slice(0, 120);

  const now    = Date.now();
  const record = _sessionInitTracker.get(ip) || { count: 0, start: now };
  if (now - record.start > SESSION_INIT_WINDOW) { record.count = 0; record.start = now; }
  record.count++;
  _sessionInitTracker.set(ip, record);

  if (record.count > SESSION_INIT_MAX) {
    trackAbuse('bot_farm', ip, { detail: `${record.count} new sessions requested — UA: ${ua}` });
    return res.status(429).json({ error: 'Too many session requests. Try again later.' });
  }

  // Track every new session issuance (not reuse) for bot farm detection
  trackAbuse('bot_farm', ip, { detail: `UA: ${ua}` });
  const sessionId = issueAnonSession();
  res.json({ sessionId });
});

// Prune session init tracker every hour
setInterval(() => {
  const cutoff = Date.now() - SESSION_INIT_WINDOW;
  for (const [ip, rec] of _sessionInitTracker.entries())
    if (rec.start < cutoff) _sessionInitTracker.delete(ip);
}, 60 * 60 * 1000);

// ── BTCPay pending cleanup ────────────────────────────
// Delete expired pending orders every 30 min (invoice expired, user never paid)
setInterval(async () => {
  try {
    const [r] = await db.execute('DELETE FROM btcpay_pending WHERE expires_at < NOW()');
    if (r.affectedRows > 0)
      console.log(`BTCPay cleanup: removed ${r.affectedRows} expired pending order(s)`);
  } catch(e) { /* ignore */ }
}, 30 * 60 * 1000);

app.get('/api/catalogue', async (req, res) => res.json(await getCatalogue()));

// ════════════════════════════════════════════════════════════════════════════
//  CÓDIGOS DE DESCUENTO (promo codes)
// ════════════════════════════════════════════════════════════════════════════
// Valida un código contra la DB y calcula el descuento para un subtotal dado.
// Reutilizado por el endpoint público /promo/validate y por la creación real
// del pedido (nunca se confía en el descuento que mande el cliente).
async function validatePromoCode(rawCode, subtotal) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Ingresa un código.' };
  const [rows] = await db.execute('SELECT * FROM promo_codes WHERE code=?', [code]);
  if (!rows.length) return { ok: false, error: 'Código no válido.' };
  const p = rows[0];
  if (!p.active) return { ok: false, error: 'Este código ya no está activo.' };
  if (p.expires_at && new Date(p.expires_at) < new Date()) return { ok: false, error: 'Este código ha expirado.' };
  if (p.max_uses != null && p.used_count >= p.max_uses) return { ok: false, error: 'Este código alcanzó su límite de usos.' };
  if (p.min_order != null && subtotal < parseFloat(p.min_order)) {
    return { ok: false, error: `Este código requiere un pedido mínimo de $${parseFloat(p.min_order).toFixed(2)}.` };
  }
  const value = parseFloat(p.value);
  let discount = p.type === 'percent'
    ? Math.round(subtotal * value / 100 * 100) / 100
    : Math.min(value, subtotal);
  discount = Math.max(0, Math.round(discount * 100) / 100);
  return { ok: true, id: p.id, code: p.code, type: p.type, value, discount };
}

// Público — usado por el checkout mientras el cliente escribe el código.
// El frontend (tienda.html applyPromo) manda `cartTotal` y espera {ok:true,...}
// en éxito o {ok:false,error} en fallo — replicado exacto aquí.
app.post('/api/promo/validate', async (req, res) => {
  const subtotal = Math.max(0, parseFloat(req.body.cartTotal ?? req.body.subtotal) || 0);
  const result = await validatePromoCode(req.body.code, subtotal).catch(() => ({ ok: false, error: 'Error al validar el código.' }));
  if (!result.ok) return res.json({ ok: false, error: result.error });
  res.json({ ok: true, code: result.code, type: result.type, value: result.value, discount: result.discount });
});

// ── Admin: CRUD de códigos de descuento ───────────────────────────────────────
app.get('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM promo_codes ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
  const type = (b.type === 'fixed') ? 'fixed' : 'percent';
  const value = parseFloat(b.value);
  if (!code) return res.status(400).json({ error: 'El código es requerido.' });
  if (!value || value <= 0 || (type === 'percent' && value > 100)) {
    return res.status(400).json({ error: type === 'percent' ? 'El porcentaje debe ser entre 1 y 100.' : 'El monto debe ser mayor a 0.' });
  }
  const n = new Date();
  try {
    await db.execute(
      `INSERT INTO promo_codes (code, type, value, active, min_order, max_uses, expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [code, type, value, b.active === false ? 0 : 1,
       b.minOrder ? parseFloat(b.minOrder) : null,
       b.maxUses ? parseInt(b.maxUses, 10) : null,
       b.expiresAt ? new Date(b.expiresAt) : null,
       n, n]
    );
    await logActivity(`Código de descuento creado: ${code}`);
    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Ese código ya existe.' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/promo-codes/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const type = (b.type === 'fixed') ? 'fixed' : 'percent';
  const value = parseFloat(b.value);
  if (!value || value <= 0 || (type === 'percent' && value > 100)) {
    return res.status(400).json({ error: type === 'percent' ? 'El porcentaje debe ser entre 1 y 100.' : 'El monto debe ser mayor a 0.' });
  }
  await db.execute(
    `UPDATE promo_codes SET type=?, value=?, active=?, min_order=?, max_uses=?, expires_at=?, updated_at=? WHERE id=?`,
    [type, value, b.active === false ? 0 : 1,
     b.minOrder ? parseFloat(b.minOrder) : null,
     b.maxUses ? parseInt(b.maxUses, 10) : null,
     b.expiresAt ? new Date(b.expiresAt) : null,
     new Date(), parseInt(req.params.id, 10)]
  );
  res.json({ ok: true });
});

app.delete('/api/admin/promo-codes/:id', requireAdmin, async (req, res) => {
  await db.execute('DELETE FROM promo_codes WHERE id=?', [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
});

// ── Admin: redactar y enviar emails + ver historial de envíos (vía Resend) ────
app.get('/api/admin/emails', requireAdmin, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM sent_emails ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

// design: 'branded' (dorado/negro Sillage) | 'formal' (carta de negocio, sin marca)
app.post('/api/admin/emails/send', requireAdmin, async (req, res) => {
  if (!RESEND_API_KEY) return res.status(503).json({ error: 'Resend no está configurado (falta RESEND_API_KEY).' });
  const to      = String(req.body.to || '').trim();
  const subject = String(req.body.subject || '').trim().slice(0, 255);
  const bodyRaw = String(req.body.body || '').trim();
  const design  = req.body.design === 'formal' ? 'formal' : 'branded';
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRe.test(to)) return res.status(400).json({ error: 'Correo de destino inválido.' });
  if (!subject) return res.status(400).json({ error: 'El asunto es requerido.' });
  if (!bodyRaw) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });

  const bodyHtml = bodyToHtml(bodyRaw, design === 'formal');
  const html = design === 'formal' ? formalEmailTemplate(bodyHtml) : emailTemplate(bodyHtml);
  await sendEmail({ to, subject, html });
  await logActivity(`Email manual enviado a ${to} — "${subject}"`);
  res.json({ ok: true });
});

// Vista previa — arma el HTML sin enviar nada, para revisar antes de mandar.
app.post('/api/admin/emails/preview', requireAdmin, (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const bodyRaw = String(req.body.body || '').trim();
  const design  = req.body.design === 'formal' ? 'formal' : 'branded';
  if (!bodyRaw) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });
  const bodyHtml = bodyToHtml(bodyRaw, design === 'formal');
  const html = design === 'formal' ? formalEmailTemplate(bodyHtml) : emailTemplate(bodyHtml);
  res.json({ ok: true, html, subject });
});

// ── Helper: deduct inventory and broadcast ────────────
// ── DTE: emit a Factura Electrónica for a paid order ─────────────────────────
// Gated by cfg.DTE_ENABLED (no-op when off). Never throws into the caller —
// failures are persisted as CONTINGENCIA for later retry from the admin panel.
async function emitDteForOrder(orderId, options = {}) {
  if (!cfg.DTE_ENABLED) return null;
  try {
    // Don't emit twice for the same order/tipo.
    const existing = await dteSvc.getByOrderId(orderId);
    const tipo = options.tipoDte || '01';
    if (existing.some(d => d.tipo_dte === tipo && d.estado === 'PROCESADO')) return null;

    const [rows] = await db.execute('SELECT * FROM orders WHERE id=?', [orderId]);
    if (!rows.length) return null;

    const rec = await dteSvc.emitForOrder(rows[0], options);
    if (rec) {
      await logActivity(
        rec.estado === 'PROCESADO'
          ? `DTE ${rec.tipoDte} emitido para pedido ${orderId} — ${rec.numeroControl}`
          : `DTE ${rec.tipoDte} pedido ${orderId} en ${rec.estado}: ${rec.observaciones || ''}`
      );
      broadcastAdmin('dte_update', {
        orderId, tipoDte: rec.tipoDte, estado: rec.estado,
        numeroControl: rec.numeroControl, selloRecibido: rec.selloRecibido,
      });
    }
    return rec;
  } catch (e) {
    console.error(`emitDteForOrder(${orderId}) error:`, e.message);
    return null;
  }
}

async function deductInventory(items) {
  const n = new Date();
  for (const item of items) {
    const pid  = parseInt(item.productId);
    const qty  = parseInt(item.qty) || 1;
    const type = (item.type || 'full').toLowerCase();

    // Deduct from main inventory (bottles)
    await db.execute(
      `UPDATE inventory SET
        stock        = GREATEST(0, stock - ?),
        low_stock    = CASE WHEN GREATEST(0, stock - ?) <= 5 AND GREATEST(0, stock - ?) > 0 THEN 1 ELSE low_stock END,
        out_of_stock = CASE WHEN GREATEST(0, stock - ?) = 0 THEN 1 ELSE 0 END,
        updated_at   = ? WHERE product_id = ?`,
      [qty, qty, qty, qty, n, pid]
    );

    // Deduct from decant_inventory for decant items
    if (type === 'decant' || type === 'decant5' || type === 'sample') {
      const sizeStr = String(item.size || '');
      const sizeMatch = sizeStr.match(/([\d.]+)\s*ml/i);
      const sizeMl = sizeMatch ? parseFloat(sizeMatch[1]) : (type === 'decant5' ? 5 : 10);
      await db.execute(
        `UPDATE decant_inventory SET
          stock      = GREATEST(0, stock - ?),
          updated_at = ?
         WHERE product_id=? AND size_ml=? AND stock > 0`,
        [qty, n, pid, sizeMl]
      ).catch(() => {}); // non-fatal if no record exists
    }
  }
  broadcast('inventory', await getInventoryMap());
}

// ── Helper: deduct ml from bottle inventory ──────────
// Called whenever a decant or sample sale is confirmed (same triggers as deductInventory)
// item.type: 'decant' | 'bottle' | 'sample'
// item.size:  string like "5ml", "10ml", "1.5ml" — we parse the number
async function deductBottleInventory(items) {
  const n        = new Date();
  const catalogue = await getCatalogue();

  for (const item of items) {
    const pid = parseInt(item.productId, 10);
    if (!pid) continue;

    const qty  = parseInt(item.qty) || 1;
    const type = (item.type || 'decant').toLowerCase();
    let   ml   = 0;

    if (type === 'bottle' || type === 'full') {
      // Full bottle sale: deduct the configured bottle_size from the record
      const [rows] = await db.execute('SELECT bottle_size FROM bottle_inventory WHERE product_id=?', [pid]);
      if (rows.length) ml = parseFloat(rows[0].bottle_size) * qty;
    } else {
      // Decant or sample: priority order for ml value:
      // 1. item.size contains "Xml" explicitly (e.g. "10ml" from frontend)
      const sizeStr = String(item.size || '');
      const sizeMatch = sizeStr.match(/([\d.]+)\s*ml/i);
      if (sizeMatch) {
        ml = parseFloat(sizeMatch[1]) * qty;
      }

      // 2. Catalogue decantSizeMl field (set by admin per fragrance)
      if (!ml) {
        const prod = catalogue.find(p => p.id === pid);
        if (prod && prod.decantSizeMl) ml = parseFloat(prod.decantSizeMl) * qty;
      }

      // 3. bottle_inventory.decant_size / sample_size (configured in rastreador)
      if (!ml) {
        const [rows] = await db.execute('SELECT decant_size, sample_size FROM bottle_inventory WHERE product_id=?', [pid]);
        if (rows.length) {
          ml = (type === 'sample' ? parseFloat(rows[0].sample_size) : parseFloat(rows[0].decant_size)) * qty;
        }
      }

      // 4. Last resort default: 10ml for decants, 1.5ml for samples
      if (!ml) ml = (type === 'sample' ? 1.5 : 10) * qty;
    }

    if (!ml) continue;

    await db.execute(`
      UPDATE bottle_inventory SET
        ml_remaining = GREATEST(0, ml_remaining - ?),
        updated_at   = ?
      WHERE product_id = ?
    `, [ml, n, pid]);
  }
  // Broadcast updated bottle inventory to admin
  const [rows] = await db.execute('SELECT * FROM bottle_inventory');
  const map = {};
  rows.forEach(r => { map[r.product_id] = r; });
  broadcastAdmin('bottle_inventory', map);
}

app.post('/api/orders', orderLimiter, async (req, res) => {
  const n = new Date();
  const customerToken  = req.headers['x-customer-token'];
  const customerSession = customerToken ? validateSession(customerToken) : null;
  const customerId     = (customerSession && customerSession.role === 'customer') ? customerSession.user.id : null;
  const paymentMethod  = req.body.paymentMethod || 'wompi';

  // ── COD-specific abuse prevention ────────────────────────────────────────
  if (paymentMethod === 'cod') {
    const rawPhone = String(req.body.phone || '').trim();
    const rawEmail = String(req.body.email || '').toLowerCase().trim();
    const clientIp = (req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',').map(s => s.trim()).filter(Boolean)[0]
      : req.ip) || 'unknown';

    // 1. Phone required for COD
    if (!rawPhone) {
      return res.status(400).json({ error: 'El número de teléfono es requerido para pago contra entrega.' });
    }

    // 2. Valid phone — at least 7 digits regardless of country format
    const phoneDigits = rawPhone.replace(/\D/g, '');
    if (phoneDigits.length < 7) {
      return res.status(400).json({ error: 'Ingresa un número de teléfono válido.' });
    }
    const svPhone = phoneDigits; // used for blocklist matching below
    // Normalize to +503-XXXX-XXXX before saving
    req.body.phone = '+503-' + svPhone.slice(0,4) + '-' + svPhone.slice(4);

    // 3. Minimum order value for COD
    const COD_MIN = parseFloat(await getSetting('cod_min_order', '25')) || 25;
    const clientTotal = parseFloat(req.body.total || 0);
    if (clientTotal < COD_MIN) {
      return res.status(400).json({ error: `El pedido mínimo para pago contra entrega es $${COD_MIN}.` });
    }

    // 4. Check blocklist (email or phone — match by digits to avoid format mismatch)
    const normalizedPhone = '+503-' + svPhone.slice(-8, -4) + '-' + svPhone.slice(-4);
    const [blocked] = await db.execute(
      `SELECT id, reason FROM cod_blocklist
       WHERE email=?
         OR REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+',''),'(','') LIKE ?
       LIMIT 1`,
      [rawEmail, '%' + svPhone.slice(-8) + '%']
    );
    if (blocked.length) {
      return res.status(403).json({
        error: 'No es posible realizar pedidos contra entrega desde esta cuenta. Por favor usa otro método de pago o contáctanos.'
      });
    }

    // 5. Max 2 pending COD orders per email or phone
    const [pendingCOD] = await db.execute(
      `SELECT COUNT(*) as cnt FROM orders
       WHERE payment_method='cod'
         AND status NOT IN ('Entregado','Cancelado','No Entregado')
         AND (LOWER(email)=? OR REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+','') LIKE ?)`,
      [rawEmail, '%' + svPhone.slice(-8) + '%']
    );
    if ((pendingCOD[0]?.cnt || 0) >= 2) {
      return res.status(400).json({
        error: 'Ya tienes 2 pedidos contra entrega pendientes. Espera a que sean entregados antes de hacer otro.'
      });
    }

    // 6. IP rate limit — max 2 COD orders per IP in 24h
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentByIp] = await db.execute(
      `SELECT COUNT(*) as cnt FROM orders
       WHERE payment_method='cod' AND created_at > ? AND customer_ip=?`,
      [yesterday, clientIp]
    );
    if ((recentByIp[0]?.cnt || 0) >= 2) {
      return res.status(429).json({
        error: 'Límite de pedidos contra entrega alcanzado. Intenta de nuevo mañana o usa otro método de pago.'
      });
    }

    // Store IP on the order for tracking (added to INSERT below via req.codClientIp)
    req.codClientIp = clientIp;
    req.normalizedPhone = normalizedPhone;
  }

  // ── Validate required fields ──────────────────────────────────────────────
  const rawEmail = String(req.body.email || '').toLowerCase().trim();
  const emailRe  = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!rawEmail || !emailRe.test(rawEmail)) {
    return res.status(400).json({ error: 'Correo electrónico inválido.' });
  }
  if (!req.body.customer || !String(req.body.customer).trim()) {
    return res.status(400).json({ error: 'Nombre requerido.' });
  }
  const rawItems = req.body.items;
  if (!Array.isArray(rawItems) || !rawItems.length) {
    return res.status(400).json({ error: 'El pedido no tiene productos.' });
  }

  // ── Verify total server-side (prevents price tampering from client) ───────
  let promoResult = null;
  try {
    const catalogue  = await getCatalogue();
    const invMap     = await getInventoryMap();
    const priceMap   = await getPricingMap();
    let   serverTotal = 0;
    // Group bundle items to validate bundle price as a unit
    const bundleGroups = {}; // bundleId → { items, bundleName }
    const standaloneItems = [];
    for (const item of rawItems) {
      if (item.bundleId) {
        if (!bundleGroups[item.bundleId]) bundleGroups[item.bundleId] = { items: [], bundleName: item.bundleName };
        bundleGroups[item.bundleId].items.push(item);
      } else {
        standaloneItems.push(item);
      }
    }

    // Validate bundle totals against DB bundle prices
    for (const [bundleId, group] of Object.entries(bundleGroups)) {
      const firstItem = group.items[0];
      const qty = parseInt(firstItem.qty, 10) || 1;
      // Sum client prices for this bundle group
      const clientBundleTotal = group.items.reduce((s, i) => s + parseFloat(i.price || 0) * parseInt(i.qty, 10), 0);
      // Validate against DB bundle price
      const bundleDefId = firstItem.bundleId?.split('_')[1]; // bundleId format: bundle_<defId>_<ts>
      if (bundleDefId) {
        const [bRows] = await db.execute('SELECT price FROM bundles WHERE id=? AND active=1', [parseInt(bundleDefId)]);
        if (bRows.length) {
          const dbBundlePrice = parseFloat(bRows[0].price) * qty;
          if (Math.abs(clientBundleTotal - dbBundlePrice) > 0.02) {
            console.warn(`Bundle price mismatch — client:$${clientBundleTotal} db:$${dbBundlePrice}`);
            return res.status(400).json({ error: 'El precio del bundle no coincide. Por favor recarga la página.' });
          }
          serverTotal += dbBundlePrice;
          continue;
        }
      }
      // Bundle not found in DB — fall back to accepting client price with abuse tracking
      serverTotal += clientBundleTotal;
    }

    // Validate standalone items
    const decantsEnabled = (await getSetting('decants_enabled', '1')) !== '0';
    for (const item of standaloneItems) {
      const pid  = parseInt(item.productId, 10);
      const qty  = parseInt(item.qty, 10) || 1;
      const type = (item.type || 'full').toLowerCase(); // 'full' | 'decant' | 'decant5' | 'bottle' | 'sample'
      const prod = catalogue.find(p => p.id === pid);
      if (!prod) return res.status(400).json({ error: `Producto no encontrado: ${pid}` });
      if (invMap[pid]?.outOfStock) return res.status(400).json({ error: `Producto agotado: ${prod.brand} ${prod.name}` });
      if (!decantsEnabled && (type === 'decant' || type === 'decant5' || type === 'sample')) {
        return res.status(400).json({ error: 'La venta de decants está temporalmente desactivada. Solo se aceptan frascos completos.' });
      }
      const pr           = priceMap[pid] || {};
      const fullPrice    = (pr.onSale && pr.salePrice) ? parseFloat(pr.salePrice) : parseFloat(prod.price);

      let unitPrice;
      if (type === 'decant' || type === 'decant5' || type === 'sample') {
        const sizeStr = String(item.size || '');
        const is5ml   = sizeStr.includes('5ml') || sizeStr === '5';
        const sizeMl  = is5ml ? 5 : 10;

        // Check decant inventory
        const [decantRows] = await db.execute(
          'SELECT stock FROM decant_inventory WHERE product_id=? AND size_ml=?',
          [pid, sizeMl]
        );
        if (decantRows.length && decantRows[0].stock !== null) {
          const availableDecants = parseInt(decantRows[0].stock);
          if (availableDecants < qty) {
            return res.status(400).json({
              error: availableDecants === 0
                ? `Decant ${sizeMl}ml de ${prod.brand} ${prod.name} está agotado.`
                : `Solo quedan ${availableDecants} decant${availableDecants > 1 ? 's' : ''} de ${sizeMl}ml de ${prod.brand} ${prod.name}.`
            });
          }
        }

        const price10 = prod.decantPrice ? parseFloat(prod.decantPrice) : Math.round(fullPrice * 0.30);
        const price5  = prod.decantPrice5 ? parseFloat(prod.decantPrice5) : Math.round(price10 * 0.55);
        const catalogDecantPrice = is5ml ? price5 : price10;
        const clientUnitPrice = parseFloat(item.unitPrice || 0);
        if (clientUnitPrice > 0 && Math.abs(clientUnitPrice - catalogDecantPrice) <= 1.00) {
          unitPrice = clientUnitPrice;
        } else {
          unitPrice = catalogDecantPrice;
        }
      } else {
        unitPrice = parseFloat(item.unitPrice || fullPrice);
        if (unitPrice < 0.50) unitPrice = fullPrice;
      }

      serverTotal += unitPrice * qty;
    }
    // El envío gratis se evalúa sobre el subtotal de ÍTEMS antes del descuento
    // (igual que el frontend: getShipping() usa cartSum(), no el total con
    // descuento aplicado) — si se evaluara después, un descuento que baje el
    // subtotal por debajo del umbral generaría "total no coincide".
    const shippingCost      = parseFloat(await getSetting('shipping_cost', '5')) || 5;
    const shippingThreshold = parseFloat(await getSetting('shipping_threshold', '50')) || 50;
    const shipping = serverTotal < shippingThreshold ? shippingCost : 0;

    // ── Código de descuento — validado server-side, nunca se confía en lo que
    // mande el cliente. Se aplica sobre el subtotal de ítems (antes de envío).
    if (req.body.promoCode) {
      promoResult = await validatePromoCode(req.body.promoCode, serverTotal);
      if (!promoResult.ok) return res.status(400).json({ error: promoResult.error });
      serverTotal = Math.max(0, Math.round((serverTotal - promoResult.discount) * 100) / 100);
    }

    serverTotal = Math.round((serverTotal + shipping) * 100) / 100;

    const clientTotal = Math.round(parseFloat(req.body.total || 0) * 100) / 100;
    if (Math.abs(serverTotal - clientTotal) > 0.02) {
      console.warn(`Order total mismatch — client:$${clientTotal} server:$${serverTotal}`);
      const failIp = (req.headers['x-forwarded-for']
        ? req.headers['x-forwarded-for'].split(',').map(s => s.trim()).filter(Boolean).pop()
        : null) || req.socket.remoteAddress || 'unknown';
      trackAbuse('order_fail', failIp, { detail: `total mismatch $${clientTotal} vs $${serverTotal}` });
      return res.status(400).json({ error: 'El total del pedido no coincide. Por favor recarga la página e intenta de nuevo.' });
    }
    // Use server-calculated total from here on
    req.body.total = serverTotal;
  } catch(e) {
    console.error('Order total validation error:', e.message);
    return res.status(500).json({ error: 'Error al validar el pedido.' });
  }

  // Payment status depends on method:
  // wompi → Pendiente  (awaiting Wompi webhook confirmation)
  // chivo → Pendiente  (awaiting manual verification)
  // cod   → Pendiente  (pay on delivery)
  const paymentStatus = 'Pendiente';

  const order = {
    id:            'SLG-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2,4).toUpperCase(),
    customer:      String(req.body.customer   || '').slice(0, 200).replace(/[<>]/g, ''),
    email:         rawEmail.slice(0, 200),
    phone:         req.body.phone ? String(req.body.phone).slice(0, 30).replace(/[^0-9+\-\s()]/g, '') : null,
    address:       String(req.body.fullAddress || req.body.address || '').slice(0, 500).replace(/[<>]/g, ''),
    city:          req.body.city    ? String(req.body.city).slice(0,   100).replace(/[<>]/g, '') : null,
    state:         req.body.state   ? String(req.body.state).slice(0,  100).replace(/[<>]/g, '') : null,
    country:       req.body.country ? String(req.body.country).slice(0,100).replace(/[<>]/g, '') : null,
    items:         req.body.items       || [],
    total:         req.body.total,
    paymentMethod,
    status:        'Procesando',
    paymentStatus,
    trackerStep:   1,
    promoCode:     promoResult && promoResult.ok ? promoResult.code : null,
    promoDiscount: promoResult && promoResult.ok ? promoResult.discount : 0,
  };

  await db.execute(
    `INSERT INTO orders (id,customer,email,phone,address,city,state_province,country,items,total,status,payment_status,payment_method,tracker_step,customer_id,customer_ip,promo_code,promo_discount,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [order.id, order.customer, order.email, order.phone, order.address,
     order.city, order.state, order.country,
     JSON.stringify(order.items), order.total,
     order.status, order.paymentStatus, order.paymentMethod,
     parseInt(order.trackerStep), customerId ? parseInt(customerId) : null,
     req.codClientIp || null, order.promoCode, order.promoDiscount, n, n]
  );

  if (promoResult && promoResult.ok) {
    await db.execute('UPDATE promo_codes SET used_count = used_count + 1, updated_at=? WHERE id=?', [n, promoResult.id]).catch(() => {});
  }

  // Save shipping info to customer profile if logged in
  if (customerId) {
    const { address: addr, city, state, postcode, country, phone } = req.body;
    await db.execute(
      `UPDATE customers SET
        name     = ?,
        phone    = COALESCE(?, phone),
        address  = COALESCE(?, address),
        city     = COALESCE(?, city),
        state    = COALESCE(?, state),
        postcode = COALESCE(?, postcode),
        country  = COALESCE(?, country)
       WHERE id = ?`,
      [order.customer, phone||null, addr||null, city||null,
       state||null, postcode||null, country||null, parseInt(customerId)]
    );
  }

  // ── Inventory: only deduct immediately for COD ────────
  // For Wompi/Chivo: deduct AFTER payment confirmed via webhook
  // For COD: deduct unit stock now, but ml deduction waits until admin marks Procesando
  if (paymentMethod === 'cod') {
    await deductInventory(order.items);
    // NOTE: deductBottleInventory intentionally NOT called here for COD
    // It fires when admin moves order to Procesando (see PATCH /api/orders/:id)
    // Reset registered user's daily consult limit on confirmed purchase
    if (customerId) {
      await db.execute(
        'UPDATE consult_counts SET count=0, last_reset=? WHERE customer_id=?',
        [new Date().toISOString().slice(0,10), customerId]
      ).catch(() => {});
    }
  }

  // ── BTCPay: defer order creation until payment confirmed ──────────────────
  // Don't insert into orders, don't email, don't notify admin yet.
  // Store everything in btcpay_pending — webhook will create the real order.
  if (paymentMethod === 'btcpay') {
    if (!BTCPAY_STORE_ID || !BTCPAY_API_KEY) {
      return res.status(503).json({ error: 'BTCPay no configurado' });
    }
    let btcpayResult;
    try {
      btcpayResult = await createBTCPayInvoice(order);
    } catch(e) {
      console.error('BTCPay invoice creation error:', e.message);
      return res.status(502).json({ error: 'No se pudo crear el invoice de Bitcoin. Intenta de nuevo.' });
    }

    // Store pending order — expires 20 min from now (BTCPay default is 15 min)
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    await db.execute(
      `INSERT INTO btcpay_pending (invoice_id, order_id, order_data, customer_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE order_data=VALUES(order_data), expires_at=VALUES(expires_at)`,
      [btcpayResult.invoiceId, order.id, JSON.stringify({ ...order, customerId }), customerId || null, expiresAt, n]
    );

    console.log(`BTCPay pending order ${order.id} — invoice ${btcpayResult.invoiceId}`);
    return res.json({ ok: true, order, btcpayUrl: btcpayResult.checkoutLink, btcpayInvoiceId: btcpayResult.invoiceId });
  }

  // ── Wompi: defer order creation until webhook confirms payment ───────────────
  if (paymentMethod === 'wompi') {
    if (!WOMPI_CLIENT_ID || !WOMPI_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Wompi no configurado' });
    }
    let wompiResult;
    try {
      wompiResult = await createWompiLink(order);
    } catch(e) {
      console.error('Wompi link creation error:', e.message);
      return res.status(502).json({ error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await db.execute(
      `INSERT INTO wompi_pending (reference, order_id, order_data, customer_id, amount_cents, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE order_data=VALUES(order_data), expires_at=VALUES(expires_at)`,
      [wompiResult.reference, order.id, JSON.stringify({ ...order, customerId }),
       customerId || null, wompiResult.amountCents, expiresAt, n]
    );
    console.log(`Wompi pending order ${order.id} — ref ${wompiResult.reference}`);
    return res.json({
      ok:            true,
      order,
      wompiUrl:      wompiResult.url,
      wompiRef:      wompiResult.reference,
      amountCents:   wompiResult.amountCents,
      btcpayUrl:     null,
      btcpayInvoiceId: null,
    });
  }

  // ── COD: insert order normally ────────────────────────────────────────────────
  broadcastAdmin('new_order', order);
  await logActivity(`Nuevo pedido ${escHtml(order.id)} de ${escHtml(order.customer)} — $${parseFloat(order.total||0).toFixed(2)}`);
  try { await sendOrderConfirmation(order); } catch(e) {}
  try { await notifyAdmins(order); } catch(e) {}
  res.json({ ok: true, order, wompiUrl: null, btcpayUrl: null, btcpayInvoiceId: null });
});


// ═══════════════════════════════════════════════════════
//  WOMPI INTEGRATION
//  Uses Wompi El Salvador API with embedded widget.
//  Order is only created in DB after payment is confirmed via webhook.
// ═══════════════════════════════════════════════════════

// Cached OAuth token for Wompi API calls
let _wompiToken     = null;
let _wompiTokenExp  = 0;

async function getWompiToken() {
  if (_wompiToken && Date.now() < _wompiTokenExp - 60000) return _wompiToken;
  const resp = await fetch('https://id.wompi.sv/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     WOMPI_CLIENT_ID,
      client_secret: WOMPI_CLIENT_SECRET,
      audience:      'wompi_api',
    }),
  });
  if (!resp.ok) throw new Error(`Wompi auth failed: ${resp.status}`);
  const data = await resp.json();
  _wompiToken    = data.access_token;
  _wompiTokenExp = Date.now() + (data.expires_in * 1000);
  return _wompiToken;
}

// Creates a Wompi payment link and stores the order in wompi_pending.
// Returns { reference, url } — reference is sent to the widget, url is the fallback redirect.
async function createWompiLink(order) {
  if (!WOMPI_CLIENT_ID || !WOMPI_CLIENT_SECRET) throw new Error('Wompi not configured');
  const BASE      = BASE_URL || 'https://sillage-sv.com';
  const token     = await getWompiToken();
  const amountCents = Math.round(parseFloat(order.total) * 100);
  // reference must be unique and <= 60 chars
  const reference = `SLG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2,4).toUpperCase()}`;

  const body = {
    idComercio:        reference,
    nombre:            `Sillage Parfumerie — Pedido ${order.id}`,
    descripcion:       order.items.map(i => `${i.name} x${i.qty}`).join(', ').slice(0, 200),
    monto:             amountCents,
    urlRedirect:       `${BASE}/?wompi_ref=${reference}`,
    urlWebhook:        `${BASE}/api/wompi/webhook`,
    configuracion: {
      urlWebhook:                 `${BASE}/api/wompi/webhook`,
      notificarTransaccionCliente: true,
    },
    formasPago: { tarjetaCreditoDebito: true },
  };

  const resp = await fetch('https://api.wompi.sv/EnlacePago', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Wompi EnlacePago failed: ${err}`);
  }
  const data = await resp.json();
  // data.data.urlEnlacePago is the checkout URL
  return { reference, url: data?.data?.urlEnlacePago || null, amountCents };
}

// GET /api/wompi/public-key — exposes only the public key to the frontend
// The widget needs this; the secret never leaves the server.
app.get('/api/wompi/public-key', (req, res) => {
  if (!WOMPI_PUBLIC_KEY) return res.status(503).json({ error: 'Wompi not configured' });
  res.json({ publicKey: WOMPI_PUBLIC_KEY });
});

// POST /api/wompi/webhook — Wompi calls this when a transaction succeeds
app.post('/api/wompi/webhook', express.json(), async (req, res) => {
  // Validate webhook signature: SHA-256(body_json + WOMPI_CLIENT_SECRET)
  if (!WOMPI_CLIENT_SECRET) {
    console.error('Wompi webhook: WOMPI_CLIENT_SECRET not set — rejecting');
    return res.sendStatus(401);
  }

  const receivedHash = req.headers['x-wompi-signature'] || req.body?.hash;
  if (!receivedHash) {
    console.warn('Wompi webhook: no signature — rejected');
    return res.sendStatus(400);
  }

  // Wompi signs: SHA256(transactionId + status + amount + secret)
  const tx = req.body?.transaccion || req.body?.transaction || {};
  const hashInput = `${tx.id || ''}${tx.estado || tx.status || ''}${tx.monto || tx.amount || ''}${WOMPI_CLIENT_SECRET}`;
  const expected  = crypto.createHash('sha256').update(hashInput).digest('hex');

  if (receivedHash.toLowerCase() !== expected.toLowerCase()) {
    console.warn('Wompi webhook: signature mismatch — rejected');
    return res.sendStatus(400);
  }

  res.sendStatus(200); // ack immediately

  const reference = tx.idComercio || tx.reference || req.body?.idComercio;
  const status    = (tx.estado || tx.status || '').toUpperCase();
  const isProd    = req.body?.esProductiva !== false;

  // Las transacciones de PRUEBA de Wompi (esProductiva:false) se ignoran por defecto.
  // Para probar el flujo completo (pedido→pago→DTE) con pagos sandbox, poner
  // WOMPI_ACCEPT_TEST=true en el entorno (quitar al pasar a producción real).
  const acceptTest = process.env.WOMPI_ACCEPT_TEST === 'true';
  if (!isProd && !acceptTest) { console.log(`Wompi webhook: test transaction for ${reference} — ignored (set WOMPI_ACCEPT_TEST=true to accept)`); return; }
  if (status !== 'APROBADA' && status !== 'APPROVED') { console.log(`Wompi webhook: ${reference} status ${status} — not approved, skipping`); return; }
  if (!reference) { console.warn('Wompi webhook: no reference'); return; }

  try {
    // Load pending order
    const [rows] = await db.execute('SELECT * FROM wompi_pending WHERE reference=?', [reference]);
    if (!rows.length) {
      console.warn(`Wompi webhook: no pending order for reference ${reference}`);
      return;
    }
    const pending  = rows[0];
    const orderObj = JSON.parse(pending.order_data);
    const items    = orderObj.items || [];
    const custId   = pending.customer_id;
    const now      = new Date();

    // Idempotency: only skip if the order is ALREADY PAID (true duplicate webhook).
    // The checkout inserts the order row with payment_status='Pendiente', so "exists"
    // alone does NOT mean processed — that old check made the webhook skip every real
    // order (never marked Pagado, never deducted stock, never emitted the DTE).
    const [exists] = await db.execute('SELECT id, payment_status FROM orders WHERE id=?', [orderObj.id]);
    if (exists.length && exists[0].payment_status === 'Pagado') {
      console.log(`Wompi webhook: order ${orderObj.id} already paid — skipping duplicate`);
      return;
    }

    if (exists.length) {
      // Order row created at checkout (Pendiente) → confirm payment on it
      await db.execute(
        `UPDATE orders SET status='Procesando', payment_status='Pagado', payment_method='wompi', wompi_reference=?, updated_at=? WHERE id=?`,
        [reference, now, orderObj.id]
      );
    } else {
      // Create the real order (deferred-creation path)
      await db.execute(
        `INSERT INTO orders
           (id,customer,email,phone,address,city,state_province,country,
            items,total,status,payment_status,payment_method,tracker_step,
            customer_id,wompi_reference,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [orderObj.id, orderObj.customer, orderObj.email, orderObj.phone,
         orderObj.address, orderObj.city, orderObj.state, orderObj.country,
         JSON.stringify(items), orderObj.total,
         'Procesando', 'Pagado', 'wompi', 1,
         custId || null, reference, pending.created_at, now]
      );
    }

    await deductInventory(items);
    await deductBottleInventory(items);

    if (custId) {
      await db.execute(
        'UPDATE consult_counts SET count=0, last_reset=? WHERE customer_id=?',
        [now.toISOString().slice(0,10), custId]
      ).catch(() => {});
    }

    await db.execute('DELETE FROM wompi_pending WHERE reference=?', [reference]);

    const fullOrder = { ...orderObj, status: 'Procesando', paymentStatus: 'Pagado', payment_method: 'wompi' };
    broadcastAdmin('new_order', fullOrder);
    await logActivity(`Pago Wompi confirmado — pedido ${orderObj.id} de ${orderObj.customer} — $${parseFloat(orderObj.total||0).toFixed(2)}`);
    let wompiDte = null;
    try { wompiDte = await emitDteForOrder(orderObj.id); } catch(e) { console.error('Wompi DTE error:', e.message); }
    try { await sendOrderConfirmation(fullOrder, wompiDte); } catch(e) { console.error('Wompi confirm email error:', e.message); }
    try { await notifyAdmins(fullOrder); } catch(e) {}
    console.log(`Wompi order created on payment: ${orderObj.id} — ref ${reference}`);
  } catch(e) {
    console.error('Wompi webhook processing error:', e.message);
  }
});

// GET /api/wompi/status?ref=<reference> — polled by frontend on redirect fallback
// Returns whether the webhook has already processed the payment
// Devuelve el pedido completo una vez pagado — para que la pantalla de éxito
// se pueda armar después de un redirect completo (no solo un toast).
app.get('/api/wompi/status', async (req, res) => {
  const ref = req.query.ref;
  if (!ref || ref.length > 80) return res.status(400).json({ error: 'Invalid ref' });
  try {
    // If pending record still exists → not paid yet
    const [pending] = await db.execute(
      'SELECT reference FROM wompi_pending WHERE reference=?', [ref]
    );
    if (pending.length) return res.json({ status: 'pending' });

    const [rows] = await db.execute(
      'SELECT id, customer, email, items, total, payment_status FROM orders WHERE wompi_reference=?', [ref]
    );
    if (!rows.length || rows[0].payment_status !== 'Pagado') return res.json({ status: 'pending' });
    const o = rows[0];
    res.json({
      status: 'paid',
      order: { id: o.id, customer: o.customer, email: o.email, total: o.total, items: JSON.parse(o.items || '[]') },
    });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Cleanup job: remove expired wompi_pending records every 30 min
setInterval(async () => {
  try {
    const [r] = await db.execute('DELETE FROM wompi_pending WHERE expires_at < NOW()');
    if (r.affectedRows > 0) console.log(`Wompi cleanup: removed ${r.affectedRows} expired pending order(s)`);
  } catch(e) { /* ignore */ }
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════
//  PAYPAL INTEGRATION
//  Tarjeta de crédito/débito vía PayPal Smart Buttons (Orders API v2).
//  Igual que Wompi: el pedido solo se crea/marca Pagado cuando el SERVIDOR
//  confirma la captura contra la API de PayPal — nunca se confía en el cliente.
// ═══════════════════════════════════════════════════════

// Recalcula el total del pedido igual que /api/orders (bundles, ítems, decants,
// envío, código de promo) — nunca se confía en el total que mande el cliente.
// Devuelve { ok:true, total, promoResult } o { ok:false, status, error }.
async function computeServerTotal(rawItems, promoCode, clientTotal) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    return { ok: false, status: 400, error: 'El pedido no tiene productos.' };
  }
  try {
    const catalogue = await getCatalogue();
    const invMap    = await getInventoryMap();
    const priceMap  = await getPricingMap();
    let   serverTotal = 0;

    const bundleGroups = {};
    const standaloneItems = [];
    for (const item of rawItems) {
      if (item.bundleId) {
        if (!bundleGroups[item.bundleId]) bundleGroups[item.bundleId] = { items: [], bundleName: item.bundleName };
        bundleGroups[item.bundleId].items.push(item);
      } else {
        standaloneItems.push(item);
      }
    }

    for (const [bundleId, group] of Object.entries(bundleGroups)) {
      const firstItem = group.items[0];
      const qty = parseInt(firstItem.qty, 10) || 1;
      const clientBundleTotal = group.items.reduce((s, i) => s + parseFloat(i.price || 0) * parseInt(i.qty, 10), 0);
      const bundleDefId = firstItem.bundleId?.split('_')[1];
      if (bundleDefId) {
        const [bRows] = await db.execute('SELECT price FROM bundles WHERE id=? AND active=1', [parseInt(bundleDefId)]);
        if (bRows.length) {
          const dbBundlePrice = parseFloat(bRows[0].price) * qty;
          if (Math.abs(clientBundleTotal - dbBundlePrice) > 0.02) {
            return { ok: false, status: 400, error: 'El precio del bundle no coincide. Por favor recarga la página.' };
          }
          serverTotal += dbBundlePrice;
          continue;
        }
      }
      serverTotal += clientBundleTotal;
    }

    const decantsEnabled = (await getSetting('decants_enabled', '1')) !== '0';
    for (const item of standaloneItems) {
      const pid  = parseInt(item.productId, 10);
      const qty  = parseInt(item.qty, 10) || 1;
      const type = (item.type || 'full').toLowerCase();
      const prod = catalogue.find(p => p.id === pid);
      if (!prod) return { ok: false, status: 400, error: `Producto no encontrado: ${pid}` };
      if (invMap[pid]?.outOfStock) return { ok: false, status: 400, error: `Producto agotado: ${prod.brand} ${prod.name}` };
      if (!decantsEnabled && (type === 'decant' || type === 'decant5' || type === 'sample')) {
        return { ok: false, status: 400, error: 'La venta de decants está temporalmente desactivada. Solo se aceptan frascos completos.' };
      }
      const pr        = priceMap[pid] || {};
      const fullPrice = (pr.onSale && pr.salePrice) ? parseFloat(pr.salePrice) : parseFloat(prod.price);

      let unitPrice;
      if (type === 'decant' || type === 'decant5' || type === 'sample') {
        const sizeStr = String(item.size || '');
        const is5ml   = sizeStr.includes('5ml') || sizeStr === '5';
        const sizeMl  = is5ml ? 5 : 10;
        const [decantRows] = await db.execute(
          'SELECT stock FROM decant_inventory WHERE product_id=? AND size_ml=?', [pid, sizeMl]
        );
        if (decantRows.length && decantRows[0].stock !== null) {
          const availableDecants = parseInt(decantRows[0].stock);
          if (availableDecants < qty) {
            return { ok: false, status: 400, error: availableDecants === 0
              ? `Decant ${sizeMl}ml de ${prod.brand} ${prod.name} está agotado.`
              : `Solo quedan ${availableDecants} decant${availableDecants > 1 ? 's' : ''} de ${sizeMl}ml de ${prod.brand} ${prod.name}.` };
          }
        }
        const price10 = prod.decantPrice ? parseFloat(prod.decantPrice) : Math.round(fullPrice * 0.30);
        const price5  = prod.decantPrice5 ? parseFloat(prod.decantPrice5) : Math.round(price10 * 0.55);
        const catalogDecantPrice = is5ml ? price5 : price10;
        const clientUnitPrice = parseFloat(item.unitPrice || 0);
        unitPrice = (clientUnitPrice > 0 && Math.abs(clientUnitPrice - catalogDecantPrice) <= 1.00) ? clientUnitPrice : catalogDecantPrice;
      } else {
        unitPrice = parseFloat(item.unitPrice || fullPrice);
        if (unitPrice < 0.50) unitPrice = fullPrice;
      }
      serverTotal += unitPrice * qty;
    }

    const shippingCost      = parseFloat(await getSetting('shipping_cost', '5')) || 5;
    const shippingThreshold = parseFloat(await getSetting('shipping_threshold', '50')) || 50;
    const shipping = serverTotal < shippingThreshold ? shippingCost : 0;

    let promoResult = null;
    if (promoCode) {
      promoResult = await validatePromoCode(promoCode, serverTotal);
      if (!promoResult.ok) return { ok: false, status: 400, error: promoResult.error };
      serverTotal = Math.max(0, Math.round((serverTotal - promoResult.discount) * 100) / 100);
    }

    serverTotal = Math.round((serverTotal + shipping) * 100) / 100;

    const clientTotalRounded = Math.round(parseFloat(clientTotal || 0) * 100) / 100;
    if (Math.abs(serverTotal - clientTotalRounded) > 0.02) {
      return { ok: false, status: 400, error: 'El total del pedido no coincide. Por favor recarga la página e intenta de nuevo.' };
    }

    return { ok: true, total: serverTotal, promoResult };
  } catch(e) {
    console.error('computeServerTotal error:', e.message);
    return { ok: false, status: 500, error: 'Error al validar el pedido.' };
  }
}

let _paypalToken    = null;
let _paypalTokenExp = 0;
async function getPaypalToken() {
  if (_paypalToken && Date.now() < _paypalTokenExp - 60000) return _paypalToken;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('PayPal not configured');
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) throw new Error(`PayPal auth failed: ${resp.status}`);
  const data = await resp.json();
  _paypalToken    = data.access_token;
  _paypalTokenExp = Date.now() + (data.expires_in * 1000);
  return _paypalToken;
}

// GET /api/paypal/config — expone solo el Client ID público (nunca el secret).
app.get('/api/paypal/config', (req, res) => {
  if (!PAYPAL_CLIENT_ID) return res.status(503).json({ error: 'PayPal no configurado' });
  res.json({ clientId: PAYPAL_CLIENT_ID });
});

// POST /api/paypal/create-order — valida el total server-side y crea la orden en PayPal.
// El pedido de Sillage AÚN no se crea aquí — solo se guarda un snapshot pendiente,
// igual que wompi_pending, hasta que /capture-order confirme el pago.
app.post('/api/paypal/create-order', orderLimiter, async (req, res) => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) return res.status(503).json({ error: 'PayPal no configurado' });

  const rawEmail = String(req.body.email || '').toLowerCase().trim();
  const emailRe  = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!rawEmail || !emailRe.test(rawEmail)) return res.status(400).json({ error: 'Correo electrónico inválido.' });
  if (!req.body.customer || !String(req.body.customer).trim()) return res.status(400).json({ error: 'Nombre requerido.' });

  const validated = await computeServerTotal(req.body.items, req.body.promoCode, req.body.total);
  if (!validated.ok) return res.status(validated.status).json({ error: validated.error });

  const customerToken   = req.headers['x-customer-token'];
  const customerSession = customerToken ? validateSession(customerToken) : null;
  const customerId      = (customerSession && customerSession.role === 'customer') ? customerSession.user.id : null;

  const orderId = 'SLG-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2,4).toUpperCase();
  const orderSnapshot = {
    id:            orderId,
    customer:      String(req.body.customer || '').slice(0, 200).replace(/[<>]/g, ''),
    email:         rawEmail.slice(0, 200),
    phone:         req.body.phone ? String(req.body.phone).slice(0, 30).replace(/[^0-9+\-\s()]/g, '') : null,
    address:       String(req.body.fullAddress || req.body.address || '').slice(0, 500).replace(/[<>]/g, ''),
    city:          req.body.city    ? String(req.body.city).slice(0,   100).replace(/[<>]/g, '') : null,
    state:         req.body.state   ? String(req.body.state).slice(0,  100).replace(/[<>]/g, '') : null,
    country:       req.body.country ? String(req.body.country).slice(0,100).replace(/[<>]/g, '') : null,
    items:         req.body.items || [],
    total:         validated.total,
    promoCode:     validated.promoResult && validated.promoResult.ok ? validated.promoResult.code : null,
    promoDiscount: validated.promoResult && validated.promoResult.ok ? validated.promoResult.discount : 0,
  };

  try {
    const token = await getPaypalToken();
    const resp  = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: orderId,
          description:  `Sillage Parfumerie — Pedido ${orderId}`.slice(0, 127),
          amount: { currency_code: 'USD', value: validated.total.toFixed(2) },
        }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('PayPal create order failed:', err);
      return res.status(502).json({ error: 'No se pudo iniciar el pago con PayPal. Intenta de nuevo.' });
    }
    const data = await resp.json();
    await db.execute(
      `INSERT INTO paypal_pending (paypal_order_id, order_id, order_data, customer_id, amount_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.id, orderId, JSON.stringify(orderSnapshot), customerId || null, validated.total, new Date()]
    );
    res.json({ ok: true, paypalOrderId: data.id });
  } catch(e) {
    console.error('PayPal create-order error:', e.message);
    res.status(500).json({ error: 'No se pudo iniciar el pago.' });
  }
});

// POST /api/paypal/capture-order/:id — captura el pago contra la API de PayPal.
// Solo si PayPal confirma estado COMPLETED se crea el pedido real y se dispara
// todo el pipeline post-pago (inventario, DTE, email, promo) — igual que Wompi.
app.post('/api/paypal/capture-order/:id', async (req, res) => {
  const paypalOrderId = String(req.params.id || '').slice(0, 60);
  if (!paypalOrderId) return res.status(400).json({ error: 'Falta el ID de la orden.' });

  try {
    const [rows] = await db.execute('SELECT * FROM paypal_pending WHERE paypal_order_id=?', [paypalOrderId]);
    if (!rows.length) return res.status(404).json({ error: 'Orden de pago no encontrada o ya procesada.' });
    const pending  = rows[0];
    const orderObj = JSON.parse(pending.order_data);

    // Idempotencia: si ya se creó y quedó Pagado, no reprocesar (doble clic / reintento del cliente).
    const [exists] = await db.execute('SELECT id, payment_status FROM orders WHERE id=?', [orderObj.id]);
    if (exists.length && exists[0].payment_status === 'Pagado') {
      return res.json({ ok: true, order: orderObj, alreadyProcessed: true });
    }

    const token = await getPaypalToken();
    const resp  = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    });
    const capture = await resp.json();
    const status  = capture?.status || capture?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (!resp.ok || status !== 'COMPLETED') {
      console.warn('PayPal capture not completed:', JSON.stringify(capture));
      return res.status(402).json({ error: 'El pago no pudo completarse. Intenta de nuevo o usa otro método.' });
    }

    const now = new Date();
    if (exists.length) {
      await db.execute(
        `UPDATE orders SET status='Procesando', payment_status='Pagado', payment_method='paypal', updated_at=? WHERE id=?`,
        [now, orderObj.id]
      );
    } else {
      await db.execute(
        `INSERT INTO orders (id,customer,email,phone,address,city,state_province,country,items,total,status,payment_status,payment_method,tracker_step,customer_id,promo_code,promo_discount,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [orderObj.id, orderObj.customer, orderObj.email, orderObj.phone, orderObj.address,
         orderObj.city, orderObj.state, orderObj.country, JSON.stringify(orderObj.items), orderObj.total,
         'Procesando', 'Pagado', 'paypal', 1, pending.customer_id || null,
         orderObj.promoCode || null, orderObj.promoDiscount || 0, pending.created_at, now]
      );
      if (orderObj.promoCode) {
        await db.execute('UPDATE promo_codes SET used_count = used_count + 1, updated_at=? WHERE code=?', [now, orderObj.promoCode]).catch(() => {});
      }
    }

    await deductInventory(orderObj.items);
    await deductBottleInventory(orderObj.items);
    if (pending.customer_id) {
      await db.execute('UPDATE consult_counts SET count=0, last_reset=? WHERE customer_id=?',
        [now.toISOString().slice(0,10), pending.customer_id]).catch(() => {});
    }
    await db.execute('DELETE FROM paypal_pending WHERE paypal_order_id=?', [paypalOrderId]);

    const fullOrder = { ...orderObj, status: 'Procesando', paymentStatus: 'Pagado', payment_method: 'paypal' };
    broadcastAdmin('new_order', fullOrder);
    await logActivity(`Pago PayPal confirmado — pedido ${orderObj.id} de ${orderObj.customer} — $${parseFloat(orderObj.total||0).toFixed(2)}`);
    let paypalDte = null;
    try { paypalDte = await emitDteForOrder(orderObj.id); } catch(e) { console.error('PayPal DTE error:', e.message); }
    try { await sendOrderConfirmation(fullOrder, paypalDte); } catch(e) { console.error('PayPal confirm email error:', e.message); }
    try { await notifyAdmins(fullOrder); } catch(e) {}

    res.json({ ok: true, order: fullOrder });
  } catch(e) {
    console.error('PayPal capture-order error:', e.message);
    res.status(500).json({ error: 'No se pudo confirmar el pago. Contáctanos si el cargo aparece en tu cuenta.' });
  }
});

// Cleanup: remove paypal_pending rows older than 2h (abandoned checkouts)
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [r] = await db.execute('DELETE FROM paypal_pending WHERE created_at < ?', [cutoff]);
    if (r.affectedRows > 0) console.log(`PayPal cleanup: removed ${r.affectedRows} expired pending order(s)`);
  } catch(e) { /* ignore */ }
}, 30 * 60 * 1000);

// ═══════════════════════════════════════════════════════
//  BTCPAY SERVER INTEGRATION
//  Replaces Chivo Wallet. Uses BTCPay Greenfield API.
//  Supports Bitcoin on-chain and Lightning Network.
//  Compatible with Chivo Wallet (Lightning) and any BTC wallet.
// ═══════════════════════════════════════════════════════

async function createBTCPayInvoice(order) {
  if (!BTCPAY_STORE_ID || !BTCPAY_API_KEY) {
    throw new Error('BTCPay not configured');
  }
  const BASE = BASE_URL || 'https://sillage-sv.com';
  const body = {
    amount:       String(parseFloat(order.total).toFixed(2)),
    currency:     'USD',
    orderId:      order.id,
    buyerEmail:   order.email,
    buyerName:    order.customer,
    metadata: {
      orderId:    order.id,
      buyerName:  order.customer,
      buyerEmail: order.email,
    },
    checkout: {
      speedPolicy:        'MediumSpeed', // 1 confirmation for on-chain
      paymentMethods:     ['BTC', 'BTC-LightningNetwork'],
      defaultPaymentMethod: 'BTC-LightningNetwork', // prefer Lightning
      redirectURL:        `${BASE}/?btcpay_order=${order.id}`,
      redirectAutomatically: true,
    },
  };

  const resp = await fetch(`${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `token ${BTCPAY_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`BTCPay invoice creation failed: ${err}`);
  }
  const invoice = await resp.json();
  return { checkoutLink: invoice.checkoutLink, invoiceId: invoice.id };
}

// POST /api/btcpay/create-invoice — create a BTCPay invoice before order confirmation
// Used to show QR code in checkout before user places the order
app.post('/api/btcpay/create-invoice', async (req, res) => {
  const { amount, orderId } = req.body;
  if (!amount || isNaN(parseFloat(amount))) {
    return res.status(400).json({ error: 'Monto inválido' });
  }
  if (!BTCPAY_STORE_ID || !BTCPAY_API_KEY) {
    return res.status(503).json({ error: 'BTCPay no configurado' });
  }
  try {
    const BASE = BASE_URL || 'https://sillage-sv.com';
    const resp = await fetch(`${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `token ${BTCPAY_API_KEY}`,
      },
      body: JSON.stringify({
        amount:   String(parseFloat(amount).toFixed(2)),
        currency: 'USD',
        metadata: { pendingOrderId: orderId || 'pending' },
        checkout: {
          speedPolicy:          'MediumSpeed',
          paymentMethods:       ['BTC-LightningNetwork', 'BTC'],
          defaultPaymentMethod: 'BTC-LightningNetwork',
          redirectURL:          `${BASE}/`,
          redirectAutomatically: false,
          requiresRefundEmail:  false,
        },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      return res.status(502).json({ error: 'Error al crear invoice BTCPay', detail: err });
    }
    const invoice = await resp.json();

    // Fetch payment methods to get Lightning invoice string and on-chain address
    const pmResp = await fetch(
      `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${invoice.id}/payment-methods`,
      { headers: { 'Authorization': `token ${BTCPAY_API_KEY}` } }
    );
    let lightningInvoice = null;
    let btcAddress = null;
    if (pmResp.ok) {
      const methods = await pmResp.json();
      const lightning = methods.find(m => m.paymentMethodId === 'BTC-LightningNetwork' || m.paymentMethod === 'BTC-LightningNetwork');
      const onchain   = methods.find(m => m.paymentMethodId === 'BTC' || m.paymentMethod === 'BTC-CHAIN');
      if (lightning) lightningInvoice = lightning.destination || lightning.paymentLink;
      if (onchain)   btcAddress       = onchain.destination;
    }

    res.json({
      ok:              true,
      invoiceId:       invoice.id,
      checkoutLink:    invoice.checkoutLink,
      lightningInvoice,
      btcAddress,
      amount:          parseFloat(amount).toFixed(2),
    });
  } catch(e) {
    console.error('BTCPay create-invoice error:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/btcpay/webhook — receives payment events from BTCPay
app.post('/api/btcpay/webhook', async (req, res) => {
  // Verify HMAC signature
  const sig = req.headers['btcpay-sig'];
  if (!BTCPAY_WEBHOOK_SECRET) {
    console.error('BTCPay webhook received but BTCPAY_WEBHOOK_SECRET not configured');
    return res.sendStatus(200); // ack to avoid BTCPay retries
  }
  if (!sig) {
    console.warn('BTCPay webhook without signature — rejected');
    return res.sendStatus(400);
  }

  const crypto = require('crypto');
  // Use raw body bytes for HMAC — req.rawBody is captured by the global express.json verify callback
  // This ensures we sign exactly what BTCPay sent, not a re-serialized version
  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error('BTCPay webhook: raw body not available — check express.json verify callback');
    return res.sendStatus(500);
  }
  const expected = 'sha256=' + crypto
    .createHmac('sha256', BTCPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig);
    expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn('BTCPay webhook signature mismatch — rejected');
      return res.sendStatus(400);
    }
  } catch(e) {
    return res.sendStatus(400);
  }

  // req.body is already parsed by global express.json
  const event = req.body;
  if (!event || typeof event !== 'object') return res.sendStatus(400);

  res.sendStatus(200); // ack immediately

  const { type, invoiceId, metadata } = event;
  if (!invoiceId) return;

  // ── InvoiceExpired: send renewal email if pending order exists ───────────────
  if (type === 'InvoiceExpired') {
    try {
      const [rows] = await db.execute(
        'SELECT * FROM btcpay_pending WHERE invoice_id=? AND renew_email_sent=0', [invoiceId]
      );
      if (!rows.length) return; // already sent or no pending order
      const pending  = rows[0];
      const orderObj = JSON.parse(pending.order_data);

      // Generate a signed renew token: HMAC-SHA256(invoiceId + orderId + secret)
      const BASE          = BASE_URL || 'https://sillage-sv.com';
      const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback-secret';
      const renewToken    = crypto
        .createHmac('sha256', SESSION_SECRET)
        .update(`btcpay-renew:${invoiceId}:${pending.order_id}`)
        .digest('hex');

      // Extend the pending record TTL by 24h so it survives until user clicks
      const newExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.execute(
        'UPDATE btcpay_pending SET renew_token=?, renew_email_sent=1, expires_at=? WHERE invoice_id=?',
        [renewToken, newExpiry, invoiceId]
      );

      const renewUrl  = `${BASE}/?btcpay_renew=${renewToken}`;
      const itemsHtml = orderObj.items.map(i =>
        `<tr>
          <td style="padding:7px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714">${escHtml(i.name)}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714;text-align:center">×${i.qty}</td>
          <td style="padding:7px 12px;border-bottom:1px solid #f0e6d0;color:#1a1714;text-align:right">$${i.total}</td>
        </tr>`
      ).join('');

      const html = emailTemplate(`
        <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#1a1714;margin:0 0 8px">Tu pago expiró</h2>
        <p style="font-size:13px;color:#8a7f72;margin:0 0 24px">
          Hola <strong style="color:#1a1714">${escHtml(orderObj.customer)}</strong>,
          el tiempo para completar tu pago Bitcoin venció, pero tu pedido sigue reservado.
          Puedes retomar el pago cuando estés listo — el link es válido por 48 horas.
        </p>
        <div style="background:#faf8f4;border:1px solid #e8d8b8;padding:12px 16px;margin-bottom:20px">
          <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">Pedido</span><br/>
          <span style="font-family:Georgia,serif;font-size:16px;color:#b8955a">${escHtml(pending.order_id)}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
          <thead><tr style="background:#faf8f4">
            <th style="padding:7px 12px;text-align:left;font-size:10px;color:#8a7f72;font-weight:400">Producto</th>
            <th style="padding:7px 12px;text-align:center;font-size:10px;color:#8a7f72;font-weight:400">Cant.</th>
            <th style="padding:7px 12px;text-align:right;font-size:10px;color:#8a7f72;font-weight:400">Precio</th>
          </tr></thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="padding:12px;background:#faf8f4;border:1px solid #e8d8b8;margin-bottom:28px">
          <span style="font-size:11px;text-transform:uppercase;color:#8a7f72">Total</span>
          <span style="font-family:Georgia,serif;font-size:20px;color:#1a1714;float:right">$${parseFloat(orderObj.total||0).toFixed(2)}</span>
        </div>
        <a href="${renewUrl}"
           style="display:block;text-align:center;padding:14px 24px;background:#0e0c0a;
                  color:#b8955a;text-decoration:none;font-size:11px;letter-spacing:3px;
                  text-transform:uppercase;border:1px solid #b8955a">
          Completar mi pago →
        </a>
        <p style="font-size:11px;color:#8a7f72;margin-top:16px;line-height:1.7;text-align:center">
          Este link expira en 48 horas.<br/>
          Si tienes problemas, responde este correo y te ayudamos.
        </p>`);

      await sendEmail({
        to:      orderObj.email,
        subject: `Tu pago está pendiente — ${escHtml(pending.order_id)} | Sillage`,
        from:    `Sillage Pedidos <${EMAIL_PEDIDOS}>`,
        html,
      });

      console.log(`BTCPay renewal email sent for order ${pending.order_id} (invoice ${invoiceId})`);
    } catch(e) {
      console.error('BTCPay expiry email error:', e.message);
    }
    return;
  }

  // Only process settled/confirmed payment events
  const paidEvents = ['InvoiceSettled', 'InvoicePaymentSettled', 'InvoiceProcessing'];
  if (!paidEvents.includes(type)) return;

  try {
    // ── Load from btcpay_pending first ────────────────────────────────────────
    const [pendingRows] = await db.execute(
      'SELECT * FROM btcpay_pending WHERE invoice_id=?', [invoiceId]
    );

    const now = new Date();

    if (pendingRows.length) {
      // ── Happy path: pending order found — create the real order ──────────────
      const pending  = pendingRows[0];
      const orderObj = JSON.parse(pending.order_data);
      const items    = orderObj.items || [];
      const custId   = pending.customer_id;

      // Idempotency: only skip if the order is ALREADY PAID (true duplicate).
      // The checkout inserts the order row with payment_status='Pendiente', so
      // "exists" alone does NOT mean processed (old check skipped every real order).
      const [existingOrder] = await db.execute(
        'SELECT id, payment_status FROM orders WHERE id=?', [orderObj.id]
      );
      if (existingOrder.length && existingOrder[0].payment_status === 'Pagado') {
        console.log(`BTCPay webhook: order ${orderObj.id} already paid — cleaning up pending and skipping`);
        await db.execute('DELETE FROM btcpay_pending WHERE invoice_id=?', [invoiceId]);
        return;
      }

      if (existingOrder.length) {
        // Order row created at checkout (Pendiente) → confirm payment on it
        await db.execute(
          `UPDATE orders SET status='Procesando', payment_status='Pagado', payment_method='btcpay', updated_at=? WHERE id=?`,
          [now, orderObj.id]
        );
      } else {
        // Deferred-creation path. INSERT IGNORE as safety net against races.
        const [insertResult] = await db.execute(
          `INSERT IGNORE INTO orders
             (id,customer,email,phone,address,city,state_province,country,
              items,total,status,payment_status,payment_method,tracker_step,
              customer_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [orderObj.id, orderObj.customer, orderObj.email, orderObj.phone,
           orderObj.address, orderObj.city, orderObj.state, orderObj.country,
           JSON.stringify(items), orderObj.total,
           'Procesando', 'Pagado', 'btcpay', 1,
           custId || null, pending.created_at, now]
        );
        if (insertResult.affectedRows === 0) {
          console.log(`BTCPay webhook: INSERT IGNORE skipped duplicate order ${orderObj.id}`);
          await db.execute('DELETE FROM btcpay_pending WHERE invoice_id=?', [invoiceId]);
          return;
        }
      }

      await deductInventory(items);
      await deductBottleInventory(items);

      // Reset daily consult limit for registered users
      if (custId) {
        await db.execute(
          'UPDATE consult_counts SET count=0, last_reset=? WHERE customer_id=?',
          [now.toISOString().slice(0,10), custId]
        ).catch(() => {});
      }

      // Clean up pending record
      await db.execute('DELETE FROM btcpay_pending WHERE invoice_id=?', [invoiceId]);

      // Notify admin + send confirmation email
      const fullOrder = { ...orderObj, status: 'Procesando', paymentStatus: 'Pagado', payment_method: 'btcpay' };
      broadcastAdmin('new_order', fullOrder);
      await logActivity(`Pago BTCPay confirmado (${type}) — pedido ${orderObj.id} de ${orderObj.customer} — $${parseFloat(orderObj.total||0).toFixed(2)}`);
      let btcpayDte = null;
      try { btcpayDte = await emitDteForOrder(orderObj.id); } catch(e) { console.error('BTCPay DTE error:', e.message); }
      try { await sendOrderConfirmation(fullOrder, btcpayDte); } catch(e) { console.error('BTCPay confirmation email error:', e.message); }
      try { await notifyAdmins(fullOrder); } catch(e) {}
      console.log(`BTCPay order created on payment: ${orderObj.id} — invoice ${invoiceId}`);

    } else {
      // ── Fallback: pending record missing (expired or duplicate webhook) ──────
      // Check if order already exists in orders table (e.g. from a previous webhook)
      const orderId = metadata?.orderId || event.orderId;
      if (!orderId) { console.warn(`BTCPay webhook: no pending record and no orderId for invoice ${invoiceId}`); return; }

      const [orderRows] = await db.execute('SELECT * FROM orders WHERE id=?', [orderId]);
      if (orderRows.length) {
        // Order exists but may not be marked paid yet
        if (orderRows[0].payment_status !== 'Pagado') {
          await db.execute(
            'UPDATE orders SET payment_status=?, status=?, updated_at=? WHERE id=?',
            ['Pagado', 'Procesando', now, orderId]
          );
          const items = JSON.parse(orderRows[0].items || '[]');
          await deductInventory(items);
          await deductBottleInventory(items);
          broadcastAdmin('order_update', { id: orderId, status: 'Procesando', paymentStatus: 'Pagado' });
          await logActivity(`Pago BTCPay confirmado (fallback) para pedido ${orderId}`);
          try {
            const fallbackDte = await emitDteForOrder(orderId);
            await sendDteReadyEmail(orderRows[0], fallbackDte);
          } catch(e) { console.error('BTCPay DTE (fallback) error:', e.message); }
        }
      } else {
        console.warn(`BTCPay webhook: invoice ${invoiceId} settled but no pending record found — possible expiry`);
      }
    }
  } catch(e) {
    console.error('BTCPay webhook processing error:', e.message);
  }
});

// In-memory cache for QR data — keyed by invoiceId, expires after 30 min
const _btcQrCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of _btcQrCache) if (v.cachedAt < cutoff) _btcQrCache.delete(k);
}, 10 * 60 * 1000);

// ── BTCPay: payment methods (BTC address + Lightning invoice + QR) ──────────
// GET /api/btcpay/invoice/:invoiceId/payment-methods
// Returns on-chain BTC address, Lightning invoice, and QR code URLs.
// Keeps the BTCPay API key server-side only.
app.get('/api/btcpay/invoice/:invoiceId/payment-methods', async (req, res) => {
  const { invoiceId } = req.params;
  if (!invoiceId || !/^[A-Za-z0-9_-]+$/.test(invoiceId)) {
    return res.status(400).json({ error: 'Invalid invoiceId' });
  }
  if (!BTCPAY_URL || !BTCPAY_STORE_ID || !BTCPAY_API_KEY) {
    return res.status(503).json({ error: 'BTCPay not configured' });
  }
  try {
    const r = await fetch(
      `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${invoiceId}/payment-methods`,
      { headers: { 'Authorization': `token ${BTCPAY_API_KEY}` } }
    );
    if (!r.ok) {
      const txt = await r.text();
      console.error('BTCPay payment-methods error:', txt);
      return res.status(502).json({ error: 'BTCPay unavailable' });
    }
    const methods = await r.json();
    // Log raw for debugging — remove once confirmed working
    console.log('BTCPay payment-methods raw:', JSON.stringify(methods));

    // BTCPay Greenfield API v1 uses paymentMethodId (not paymentMethod) as the key field.
    // Known values: "BTC-LN" (Lightning), "BTC-CHAIN" (on-chain).
    // Match by substring to handle any future variants.
    const getId = m => m.paymentMethodId || m.paymentMethod || '';
    const isLN  = m => /LN$/i.test(getId(m))  || /lightning/i.test(getId(m));
    const isBTC = m => /CHAIN$/i.test(getId(m)) || (!isLN(m) && /btc/i.test(getId(m)));
    const ln    = methods.find(isLN);
    const btc   = methods.find(isBTC);

    // QR served by invoiceId + method — avoids long query strings on mobile
    const out = {
      btc: btc ? {
        address:     btc.destination,
        paymentLink: btc.paymentLink,
        amount:      btc.amount,
        rate:        btc.rate,
        qr:          `/api/btcpay/qr/${encodeURIComponent(invoiceId)}?method=btc`,
      } : null,
      lightning: ln ? {
        invoice:     ln.destination,
        paymentLink: ln.paymentLink,
        amount:      ln.amount,
        qr:          `/api/btcpay/qr/${encodeURIComponent(invoiceId)}?method=lightning`,
      } : null,
      _raw: (!btc && !ln) ? methods : undefined,
    };
    // Cache payment data for QR endpoint (keyed by invoiceId)
    _btcQrCache.set(invoiceId, { btc, ln, cachedAt: Date.now() });
    res.json(out);
  } catch(e) {
    console.error('BTCPay payment-methods fetch error:', e.message);
    res.status(502).json({ error: 'BTCPay unavailable' });
  }
});

// ── BTCPay: QR generation (self-contained, no external calls) ───────────────
// GET /api/btcpay/qr/:invoiceId?method=lightning|btc
// Generates QR PNG from cached payment data — short URL, no mobile encoding issues.
app.get('/api/btcpay/qr/:invoiceId', (req, res) => {
  const { invoiceId } = req.params;
  const method = req.query.method || 'lightning';
  if (!invoiceId || !/^[A-Za-z0-9_-]+$/.test(invoiceId)) {
    return res.status(400).send('Invalid invoiceId');
  }

  const cached = _btcQrCache.get(invoiceId);
  if (!cached) return res.status(404).send('Invoice not found or expired');

  const entry = method === 'btc' ? cached.btc : cached.ln;
  if (!entry) return res.status(404).send('Payment method not available');

  // Lightning: uppercase for alphanumeric QR mode (denser, faster scan)
  const qrData = method === 'lightning'
    ? (entry.paymentLink || entry.destination).toUpperCase()
    : (entry.paymentLink || entry.destination);

  if (!global._QRCode) return res.status(503).send('QR generator not ready');

  global._QRCode.toBuffer(qrData, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 300,
    color: { dark: '#000000', light: '#ffffff' },
  }, (err, buf) => {
    if (err) { console.error('QR error:', err.message); return res.status(500).send('QR failed'); }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  });
});

// ── BTCPay: renew expired invoice ────────────────────────────────────────────
// GET /api/btcpay/renew?token=<renew_token>
// Validates the token, creates a new invoice for the same order, returns invoiceId.
app.get('/api/btcpay/renew', btcpayRenewLimiter, async (req, res) => {
  const { token } = req.query;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Token inválido' });
  }

  const [rows] = await db.execute(
    'SELECT * FROM btcpay_pending WHERE renew_token=? LIMIT 1', [token]
  ).catch(() => [[]]);

  if (!rows.length) {
    return res.status(404).json({ error: 'El link de pago ya no es válido o expiró.' });
  }

  const pending  = rows[0];
  const orderObj = JSON.parse(pending.order_data);

  // Check the 24h window hasn't passed
  if (new Date(pending.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Este link ya expiró. Realiza tu pedido nuevamente.' });
  }

  if (!BTCPAY_STORE_ID || !BTCPAY_API_KEY) {
    return res.status(503).json({ error: 'BTCPay no configurado' });
  }

  try {
    // Create a fresh invoice for the same order
    const btcpayResult = await createBTCPayInvoice(orderObj);

    // Update btcpay_pending with new invoiceId and new 15-min expiry
    const newExpiry = new Date(Date.now() + 20 * 60 * 1000);
    await db.execute(
      `UPDATE btcpay_pending
          SET invoice_id=?, renew_token=NULL, renew_email_sent=0, expires_at=?
        WHERE renew_token=?`,
      [btcpayResult.invoiceId, newExpiry, token]
    );

    console.log(`BTCPay invoice renewed: ${pending.invoice_id} → ${btcpayResult.invoiceId} for order ${pending.order_id}`);
    res.json({
      ok:             true,
      btcpayInvoiceId: btcpayResult.invoiceId,
      orderId:         pending.order_id,
    });
  } catch(e) {
    console.error('BTCPay renew error:', e.message);
    res.status(502).json({ error: 'No se pudo generar un nuevo invoice. Intenta de nuevo.' });
  }
});

// ── BTCPay: invoice status polling ───────────────────────────────────────────
// GET /api/btcpay/invoice/:invoiceId/status
// Returns {status, orderId} — frontend polls this until paid.
app.get('/api/btcpay/invoice/:invoiceId/status', async (req, res) => {
  const { invoiceId } = req.params;
  if (!invoiceId || !/^[A-Za-z0-9_-]+$/.test(invoiceId)) {
    return res.status(400).json({ error: 'Invalid invoiceId' });
  }
  if (!BTCPAY_URL || !BTCPAY_STORE_ID || !BTCPAY_API_KEY) {
    return res.status(503).json({ error: 'BTCPay not configured' });
  }
  try {
    const r = await fetch(
      `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${invoiceId}`,
      { headers: { 'Authorization': `token ${BTCPAY_API_KEY}` } }
    );
    if (!r.ok) return res.status(502).json({ error: 'BTCPay unavailable' });
    const invoice = await r.json();
    // status: New | Processing | Settled | Invalid | Expired
    res.json({
      status:   invoice.status,
      orderId:  invoice.metadata?.orderId || invoice.orderId || null,
      currency: invoice.currency,
      amount:   invoice.amount,
    });
  } catch(e) {
    console.error('BTCPay status fetch error:', e.message);
    res.status(502).json({ error: 'BTCPay unavailable' });
  }
});

// ═══════════════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════════════
app.post('/api/inventory', requireAdmin, async (req, res) => {
  const n         = new Date();
  const catalogue = await getCatalogue();

  for (const [pid, val] of Object.entries(req.body)) {
    const pidInt   = parseInt(pid);
    const newStock = parseInt(val.stock ?? 99);

    // Read previous stock to detect new bottles added
    const [prev] = await db.execute(
      'SELECT stock FROM inventory WHERE product_id=?', [pidInt]
    );
    const prevStock   = prev.length ? parseInt(prev[0].stock) : 0;
    const addedUnits  = Math.max(0, newStock - prevStock);

    await db.execute(
      `INSERT INTO inventory (product_id,stock,low_stock,out_of_stock,updated_at) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE stock=VALUES(stock),low_stock=VALUES(low_stock),out_of_stock=VALUES(out_of_stock),updated_at=VALUES(updated_at)`,
      [pidInt, newStock, val.lowStock ? 1 : 0, val.outOfStock ? 1 : 0, n]
    );

    // Auto-open bottles in rastreador when:
    // - New units were added (addedUnits > 0), AND
    // - New total stock > 2 (threshold to avoid opening for very low stock)
    if (addedUnits > 0 && newStock > 2) {
      const prod      = catalogue.find(p => p.id === pidInt);
      const sizeStr   = prod ? String(prod.size || '') : '';
      const sizeMatch = sizeStr.match(/([\d.]+)\s*ml/i);
      const bottleSize= sizeMatch ? parseFloat(sizeMatch[1]) : 100;
      const mlToAdd   = bottleSize * addedUnits;
      const alertMl   = Math.max(10, bottleSize * 0.15);

      // Upsert: create record if new, add ml if existing
      await db.execute(`
        INSERT INTO bottle_inventory
          (product_id, ml_total, ml_remaining, ml_reserved, decant_size, sample_size,
           alert_ml, bottles_count, bottle_size, notes, updated_at)
        VALUES (?, ?, ?, 0, 10, 1.5, ?, ?, ?, '', ?)
        ON DUPLICATE KEY UPDATE
          ml_total      = ml_total + VALUES(ml_total),
          ml_remaining  = ml_remaining + VALUES(ml_remaining),
          bottles_count = bottles_count + VALUES(bottles_count),
          bottle_size   = VALUES(bottle_size),
          alert_ml      = GREATEST(alert_ml, VALUES(alert_ml)),
          updated_at    = VALUES(updated_at)
      `, [pidInt, mlToAdd, mlToAdd, alertMl, addedUnits, bottleSize, n]);

      if (prod) {
        await logActivity(
          `Rastreador: +${mlToAdd}ml (${addedUnits} botella${addedUnits > 1 ? 's' : ''} × ${bottleSize}ml) — ${prod.brand} ${prod.name}`
        );
      }
    }
  }

  invalidateInventory(); // clear cache before broadcasting
  broadcast('inventory', await getInventoryMap());
  await logActivity('Inventario actualizado');

  // Send stock notification emails for products that just came back in stock
  try {
    const catalogue = await getCatalogue();
    for (const [pid, val] of Object.entries(req.body)) {
      const pidInt = parseInt(pid);
      if (!val.outOfStock && parseInt(val.stock) > 0) {
        // Product is now in stock — check for pending notifications
        const [pending] = await db.execute(
          'SELECT id, email FROM stock_notify WHERE product_id=? AND notified=0',
          [pidInt]
        );
        if (!pending.length) continue;

        const prod = catalogue.find(p => p.id === pidInt);
        if (!prod) continue;

        for (const row of pending) {
          await sendEmail({
            to: row.email,
            subject: `${prod.brand} ${prod.name} ya está disponible — Sillage`,
            html: `
              <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;background:#faf8f4;padding:2.5rem 2rem">
                <div style="font-family:Georgia,serif;font-size:1.6rem;font-weight:300;letter-spacing:0.3em;color:#b8955a;margin-bottom:1.5rem">Sillage</div>
                <h2 style="font-family:Georgia,serif;font-size:1.5rem;font-weight:300;color:#1a1714;margin:0 0 0.8rem">
                  ${prod.brand} ${prod.name} está disponible
                </h2>
                <p style="font-size:0.88rem;color:#5a5248;line-height:1.8;margin:0 0 1.5rem">
                  Nos avisaste que querías saber cuando volviera. Ya está disponible en nuestra tienda.
                </p>
                <p style="font-size:0.8rem;color:#8a7f72;font-style:italic;line-height:1.7;margin:0 0 1.8rem">
                  "${prod.tagline || prod.desc || ''}"
                </p>
                <a href="https://sillage-sv.com/?producto=${prod.id}"
                   style="display:inline-block;padding:0.85rem 2rem;background:#b8955a;color:#0e0c0a;text-decoration:none;font-size:0.72rem;letter-spacing:0.2em;text-transform:uppercase">
                  Ver fragancia →
                </a>
                <p style="font-size:0.65rem;color:#aaa;margin-top:2rem;line-height:1.6">
                  Recibiste este correo porque solicitaste una notificación de disponibilidad en Sillage Parfumerie.
                </p>
              </div>
            `
          });
          // Mark as notified
          await db.execute('UPDATE stock_notify SET notified=1 WHERE id=?', [row.id]);
        }
        await logActivity(`Notificaciones de stock enviadas: ${prod.brand} ${prod.name} (${pending.length} correo${pending.length > 1 ? 's' : ''})`);
      }
    }
  } catch(e) {
    console.error('Stock notify email error:', e.message); // non-fatal
  }

  res.json({ ok: true });
});

// ── CUSTOMER FAVORITES (DB-backed) ───────────────────────────────────────────

// GET /api/customer/favorites
app.get('/api/customer/favorites', requireCustomer, async (req, res) => {
  const id = req.customer.user.id;
  const [rows] = await db.execute(
    'SELECT product_id FROM customer_favorites WHERE customer_id=? ORDER BY created_at DESC',
    [id]
  );
  res.json(rows.map(r => r.product_id));
});

// POST /api/customer/favorites — add or remove (toggle)
app.post('/api/customer/favorites', requireCustomer, async (req, res) => {
  const id  = req.customer.user.id;
  const pid = parseInt(req.body.productId);
  if (!pid) return res.status(400).json({ error: 'productId requerido.' });

  const [existing] = await db.execute(
    'SELECT id FROM customer_favorites WHERE customer_id=? AND product_id=?', [id, pid]
  );
  if (existing.length) {
    await db.execute('DELETE FROM customer_favorites WHERE customer_id=? AND product_id=?', [id, pid]);
    res.json({ ok: true, action: 'removed' });
  } else {
    await db.execute(
      'INSERT INTO customer_favorites (customer_id, product_id, created_at) VALUES (?,?,?)',
      [id, pid, new Date()]
    );
    res.json({ ok: true, action: 'added' });
  }
});

// POST /api/customer/favorites/sync — bulk sync from localStorage on login
app.post('/api/customer/favorites/sync', requireCustomer, async (req, res) => {
  const id   = req.customer.user.id;
  const pids = (req.body.productIds || []).map(Number).filter(Boolean);
  if (!pids.length) return res.json({ ok: true, synced: 0 });

  let synced = 0;
  for (const pid of pids) {
    try {
      await db.execute(
        'INSERT IGNORE INTO customer_favorites (customer_id, product_id, created_at) VALUES (?,?,?)',
        [id, pid, new Date()]
      );
      synced++;
    } catch(e) { /* ignore dupes */ }
  }
  res.json({ ok: true, synced });
});

// ── DECANT INVENTORY ──────────────────────────────────────────────────────────

// GET /api/decant-inventory — public, returns stock for all products
app.get('/api/decant-inventory', async (req, res) => {
  const [rows] = await db.execute('SELECT product_id, size_ml, stock, low_stock_threshold FROM decant_inventory');
  // Return as { productId: { '10': { stock, low }, '5': { stock, low } } }
  const result = {};
  for (const r of rows) {
    if (!result[r.product_id]) result[r.product_id] = {};
    result[r.product_id][String(parseFloat(r.size_ml))] = {
      stock: r.stock,
      low:   r.stock > 0 && r.stock <= r.low_stock_threshold,
      out:   r.stock === 0
    };
  }
  res.json(result);
});

// GET /api/decant-inventory/all — admin, full details
app.get('/api/decant-inventory/all', requireAdmin, async (req, res) => {
  const [rows] = await db.execute(
    'SELECT * FROM decant_inventory ORDER BY product_id, size_ml'
  );
  res.json(rows);
});

// POST /api/decant-inventory — admin: upsert stock for a product+size
app.post('/api/decant-inventory', requireAdmin, async (req, res) => {
  const { productId, sizeMl, stock, lowStockThreshold } = req.body;
  if (!productId || !sizeMl) return res.status(400).json({ error: 'productId y sizeMl requeridos.' });
  await db.execute(
    `INSERT INTO decant_inventory (product_id, size_ml, stock, low_stock_threshold, updated_at)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE stock=VALUES(stock), low_stock_threshold=VALUES(low_stock_threshold), updated_at=VALUES(updated_at)`,
    [parseInt(productId), parseFloat(sizeMl), parseInt(stock)||0, parseInt(lowStockThreshold)||3, new Date()]
  );
  await logActivity(`Decant inventory actualizado — producto ${productId} ${sizeMl}ml: ${stock} uds`);
  res.json({ ok: true });
});

// PATCH /api/decant-inventory/batch — admin: save multiple at once
app.patch('/api/decant-inventory/batch', requireAdmin, async (req, res) => {
  const { items } = req.body; // [{ productId, sizeMl, stock, lowStockThreshold }]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser un array.' });
  const n = new Date();
  for (const item of items) {
    await db.execute(
      `INSERT INTO decant_inventory (product_id, size_ml, stock, low_stock_threshold, updated_at)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE stock=VALUES(stock), low_stock_threshold=VALUES(low_stock_threshold), updated_at=VALUES(updated_at)`,
      [parseInt(item.productId), parseFloat(item.sizeMl), parseInt(item.stock)||0, parseInt(item.lowStockThreshold)||3, n]
    );
  }
  await logActivity(`Decant inventory batch actualizado — ${items.length} registros`);
  res.json({ ok: true });
});

// POST /api/stock-notify — save email notification request for OOS product
app.post('/api/stock-notify', async (req, res) => {
  const { productId, email } = req.body;
  if (!productId || !email) return res.status(400).json({ error: 'Faltan datos.' });
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!re.test(email)) return res.status(400).json({ error: 'Correo inválido.' });
  try {
    await db.execute(
      'INSERT INTO stock_notify (product_id, email, notified, created_at) VALUES (?,?,0,?) ON DUPLICATE KEY UPDATE notified=0, created_at=VALUES(created_at)',
      [parseInt(productId), email.toLowerCase().trim(), new Date()]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Error al guardar.' });
  }
});

app.post('/api/pricing', requireAdmin, async (req, res) => {
  const n = new Date();
  for (const [pid, val] of Object.entries(req.body)) {
    await db.execute(
      `INSERT INTO pricing (product_id,sale_price,on_sale,updated_at) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE sale_price=VALUES(sale_price),on_sale=VALUES(on_sale),updated_at=VALUES(updated_at)`,
      [parseInt(pid), val.salePrice || '', val.onSale ? 1 : 0, n]
    );
  }
  invalidatePricing(); // limpiar caché (60s) — si no, el broadcast y la tienda siguen sirviendo el precio/oferta viejo
  broadcast('pricing', await getPricingMap());
  await logActivity('Precios actualizados');
  res.json({ ok: true });
});

app.get('/api/orders',   requireAdmin, async (req, res) => res.json(await getOrders()));
app.get('/api/activity', requireAdmin, async (req, res) => res.json(await getActivity()));

app.get('/api/orders/export', requireAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT id,customer,email,phone,address,city,state_province,country,items,total,status,payment_status,payment_method,tracker_step,customer_id,created_at,updated_at FROM orders ORDER BY created_at DESC');
  const lines = ['ID,Cliente,Email,Dirección,Total,Estado,Pago,Fecha'];
  rows.forEach(r => lines.push([r.id, r.customer, r.email, `"${r.address}"`, r.total, r.status, r.payment_status, r.created_at].join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sillage-orders.csv"');
  res.send(lines.join('\n'));
});

// GET /api/admin/dte/export?month=YYYY-MM — reporte CSV de DTEs emitidos en el mes.
// Por defecto usa el mes en curso. Solo incluye documentos del ambiente activo
// (DTE_AMBIENTE) para no mezclar pruebas de homologación con producción.
app.get('/api/admin/dte/export', requireAdmin, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const [rows] = await db.execute(
      `SELECT tipo_dte, numero_control, codigo_generacion, sello_recibido, estado, created_at,
              order_id, customer, email, total
         FROM dte_documents
        WHERE ambiente = ? AND DATE_FORMAT(created_at, '%Y-%m') = ?
        ORDER BY created_at ASC`,
      [cfg.DTE_AMBIENTE, month]
    );
    const tipoLbl = { '01': 'Factura', '03': 'CCF', '05': 'Nota de Crédito', 'AN': 'Anulación', 'CG': 'Contingencia' };
    const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['Fecha,Tipo,N. Control,Codigo Generacion,Estado,Sello Recibido,Pedido,Cliente,Correo,Total'];
    rows.forEach(r => lines.push([
      r.created_at, tipoLbl[r.tipo_dte] || r.tipo_dte, r.numero_control, r.codigo_generacion,
      r.estado, r.sello_recibido || '', r.order_id, r.customer || '', r.email || '',
      r.total != null ? parseFloat(r.total).toFixed(2) : '',
    ].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sillage-dte-${month}.csv"`);
    res.send('﻿' + lines.join('\n')); // BOM — para que Excel abra bien los acentos
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id', requireAdmin, async (req, res) => {
  const { status, trackerStep, trackingNumber, paymentStatus } = req.body;
  const [existing] = await db.execute('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: 'Pedido no encontrado' });
  const prevStatus  = existing[0].status;
  const prevPayment = existing[0].payment_status;
  await db.execute(
    `UPDATE orders SET
      status          = COALESCE(?,status),
      tracker_step    = COALESCE(?,tracker_step),
      tracking_number = COALESCE(?,tracking_number),
      payment_status  = COALESCE(?,payment_status),
      updated_at      = ?
     WHERE id=?`,
    [status || null, trackerStep ?? null, trackingNumber || null, paymentStatus || null, new Date(), req.params.id]
  );

  // Confirmación de pago manual (admin) → emite el DTE (opción A, sin esperar webhook).
  // Útil cuando el webhook de Wompi/BTCPay no llega o para pruebas. Dedup-guarded.
  let manualPagoDte = null;
  if (paymentStatus === 'Pagado' && prevPayment !== 'Pagado') {
    broadcastAdmin('order_update', { id: req.params.id, paymentStatus: 'Pagado' });
    await logActivity(`Pago confirmado manualmente para pedido ${escHtml(req.params.id)}`);
    try { manualPagoDte = await emitDteForOrder(req.params.id); } catch(e) { console.error('DTE (pago manual) error:', e.message); }
  }
  const [updated] = await db.execute('SELECT * FROM orders WHERE id=?', [req.params.id]);
  const order = {
    ...updated[0],
    items:   JSON.parse(updated[0].items || '[]'),
    address: updated[0].address,
    tracking_number: updated[0].tracking_number
  };
  // El "Pedido Confirmado" ya se mandó sin DTE (se emite hasta que se confirma
  // el pago) — este es el correo de seguimiento con la factura adjunta.
  if (manualPagoDte) { try { await sendDteReadyEmail(order, manualPagoDte); } catch(e) { console.error('DTE ready email (pago manual) error:', e.message); } }
  broadcastAdmin('order_update', { id: order.id, status: order.status, trackerStep: order.tracker_step });
  await logActivity(`Pedido ${escHtml(order.id)} → ${order.status}`);

  // ── Bottle ml deduction on status change ─────────────
  if (status && status !== prevStatus) {
    const isCOD   = order.payment_method === 'cod';
    const isChivo = order.payment_method === 'chivo';

    // COD → Procesando: admin confirmed the order, deduct ml now
    if (isCOD && status === 'Procesando') {
      await deductBottleInventory(order.items);
      await logActivity(`ml deducidos (COD confirmado) para pedido ${escHtml(order.id)}`);
    }

    // BTCPay: webhook auto-confirms. If admin manually moves to Procesando
    // (e.g. on-chain payment still pending), also deduct inventory.
    const isBTCPay = order.payment_method === 'btcpay';
    if (isBTCPay && status === 'Procesando' && order.payment_status !== 'Pagado') {
      await deductBottleInventory(order.items);
      await db.execute('UPDATE orders SET payment_status=?, updated_at=? WHERE id=?', ['Pagado', new Date(), req.params.id]);
      order.payment_status = 'Pagado';
      broadcastAdmin('order_update', { id: order.id, status: order.status, paymentStatus: 'Pagado', trackerStep: order.tracker_step });
      await logActivity(`Pago BTCPay confirmado manualmente para pedido ${escHtml(order.id)}`);
      try {
        const btcpayManualDte = await emitDteForOrder(order.id);
        await sendDteReadyEmail(order, btcpayManualDte);
      } catch(e) { console.error('DTE (BTCPay manual) error:', e.message); }
    }

    // COD → Entregado: mark as Pagado (payment collected on delivery)
    if (isCOD && status === 'Entregado') {
      await db.execute('UPDATE orders SET payment_status=?, updated_at=? WHERE id=?', ['Pagado', new Date(), req.params.id]);
      order.payment_status = 'Pagado';
      broadcastAdmin('order_update', { id: order.id, status: order.status, paymentStatus: 'Pagado', trackerStep: order.tracker_step });
      await logActivity(`Pago COD confirmado para pedido ${escHtml(order.id)}`);
      try {
        const codDte = await emitDteForOrder(order.id);
        await sendDteReadyEmail(order, codDte);
      } catch(e) { console.error('DTE (COD) error:', e.message); }
    }

    // COD → No Entregado: track no-show and auto-block after threshold
    if (isCOD && status === 'No Entregado') {
      const noShowEmail = order.email?.toLowerCase()?.trim();
      const noShowPhone = order.phone?.trim();

      // Record the no-show
      await db.execute(
        'INSERT INTO cod_noshows (email, phone, order_id, created_at) VALUES (?,?,?,?)',
        [noShowEmail || null, noShowPhone || null, order.id, new Date()]
      );

      // Count total no-shows for this contact
      const [nsCounts] = await db.execute(
        'SELECT COUNT(*) as cnt FROM cod_noshows WHERE email=? OR phone=?',
        [noShowEmail || '', noShowPhone || '']
      );
      const noShowCount = nsCounts[0]?.cnt || 0;

      const COD_NOSHOW_LIMIT = parseInt(await getSetting('cod_noshow_limit', '2')) || 2;

      if (noShowCount >= COD_NOSHOW_LIMIT) {
        // Auto-block this contact
        await db.execute(
          `INSERT INTO cod_blocklist (email, phone, reason, blocked_by, created_at)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE reason=VALUES(reason), created_at=VALUES(created_at)`,
          [noShowEmail || null, noShowPhone || null,
           `Auto-bloqueado: ${noShowCount} no-shows`, 'system', new Date()]
        );
        await logActivity(`COD auto-bloqueado: ${noShowEmail} (${noShowCount} no-shows)`);
      }

      await logActivity(`No entregado: pedido ${escHtml(order.id)} — no-shows acumulados: ${noShowCount}`);
    }
  }

  // Send status notification emails
  if (status && status !== prevStatus) {
    try {
      if (status === 'Enviado')   await sendShippedEmail(order);
      if (status === 'Entregado') await sendDeliveredEmail(order);
    } catch(e) { console.error('Status email failed:', e.message); }
  }

  res.json({ ok: true });
});

app.get('/api/customers', requireAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT id,name,email,phone,address,city,country,created_at,last_login FROM customers ORDER BY created_at DESC');
  res.json(rows);
});



// ─── Gemini Sommelier ─────────────────────────────────

// POST /api/sommelier/chat
// Body: { messages: [{role, content}], catalogue: [...], sessionId: "xxx" }
app.post('/api/sommelier/chat', sommelierBurst, sommelierLimiter, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'Sommelier not configured' });

  const { messages = [], sessionId } = req.body;
  // Track sommelier usage per session for abuse detection
  if (sessionId) trackAbuse('sommelier', sessionId);

  // ── Input validation — reject malformed / oversized requests ─────────────
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request' });
  // Count only user messages — limit to 5 inputs per conversation
  const userMsgCount = messages.filter(m => m.role === 'user').length;
  if (userMsgCount > 5) return res.status(400).json({
    error: 'conversation_limit',
    message: 'Has llegado al límite de esta consulta. Inicia una nueva conversación para continuar.'
  });
  if (messages.length > 20) return res.status(400).json({ error: 'Conversation too long' });
  for (const m of messages) {
    if (!m || typeof m.content !== 'string') return res.status(400).json({ error: 'Invalid message format' });
    if (m.content.length > 2000) return res.status(400).json({ error: 'Message too long' }); // ~500 tokens max per message
  }
  if (sessionId && typeof sessionId !== 'string') return res.status(400).json({ error: 'Invalid session' });

  // ── Resolve customer identity early — needed by session + fingerprint checks below ──
  const customerToken   = req.headers['x-customer-token'];
  const customerSession = customerToken ? validateSession(customerToken) : null;
  const isRegistered    = !!(customerSession && customerSession.role === 'customer');
  const customerId      = isRegistered ? customerSession.user.id : null;

  // Reject sessions not issued by this server (bot protection)
  // Registered users use customer token — they don't need a server-issued sessionId
  if (!isRegistered && sessionId && !isValidAnonSession(sessionId)) {
    return res.status(403).json({ error: 'invalid_session', message: 'Sesión no válida. Por favor recarga la página.' });
  }

  // Behavioral fingerprint score — _h sent by frontend
  // Score 0 = no browser interaction (direct API call / bot)
  // Score 100 = clear human behavior
  // Threshold raised 10→20: previously a bot only had to wait 3s and call
  // (timeOnPage>3000 alone = 15pts) to pass. 20 forces at least a second
  // signal too (scroll, or waiting past 10s). Kept modest on purpose — most
  // of the score comes from mouseMove (getBFScore() in tienda.html), which
  // touch/mobile visitors never trigger, so a real mobile shopper arriving
  // from a Meta ad who scrolls a little or lingers a few seconds still
  // clears this easily. This is a client-reported value the browser
  // computes — it raises the bar for lazy bots, it isn't a hard guarantee
  // against a scripted one that fakes it.
  const bfScore = parseInt(req.body._h) || 0;
  if (!isRegistered && bfScore < 20) {
    // Very likely a bot — silent slow response to waste their time
    await new Promise(r => setTimeout(r, 3000));
    return res.status(403).json({ error: 'verification_failed', message: 'Verificación fallida. Por favor recarga la página.' });
  }

  // ── Consult limits ────────────────────────────────────────────────────────
  // Anon: 2/day  |  Registered: 4/day (resets on purchase)
  // Uses atomic INSERT ... ON DUPLICATE KEY UPDATE to prevent race conditions
  // under concurrent requests from the same session.

  if (sessionId || isRegistered) {
    try {
      const today    = new Date().toISOString().slice(0, 10);
      const now      = new Date();
      const ANON_LIMIT = 2;
      const REG_LIMIT  = 4;
      const LIMIT      = isRegistered ? REG_LIMIT : ANON_LIMIT;

      if (messages.length === 1) {
        // First message of a new conversation — atomically upsert the counter.
        // IF last_reset < today: reset count to 1 (new day).
        // ELSE: increment by 1, but only if still under limit.
        // The INSERT handles first-ever rows; ON DUPLICATE KEY handles existing ones.
        if (isRegistered) {
          await db.execute(`
            INSERT INTO consult_counts (session_id, customer_id, count, last_reset, updated_at)
            VALUES (?, ?, 1, ?, ?)
            ON DUPLICATE KEY UPDATE
              count      = IF(last_reset < ?, 1, count + 1),
              last_reset = IF(last_reset < ?, ?, last_reset),
              updated_at = ?
          `, ['reg-' + customerId, customerId, today, now, today, today, today, now]);
        } else {
          await db.execute(`
            INSERT INTO consult_counts (session_id, customer_id, count, last_reset, updated_at)
            VALUES (?, NULL, 1, ?, ?)
            ON DUPLICATE KEY UPDATE
              count      = IF(last_reset < ?, 1, count + 1),
              last_reset = IF(last_reset < ?, ?, last_reset),
              updated_at = ?
          `, [sessionId, today, now, today, today, today, now]);
        }

        // Now read back the count to check if limit was exceeded
        const [rows] = isRegistered
          ? await db.execute('SELECT count, last_reset FROM consult_counts WHERE customer_id=?', [customerId])
          : await db.execute('SELECT count, last_reset FROM consult_counts WHERE session_id=? AND customer_id IS NULL', [sessionId]);

        if (rows.length) {
          const lastReset = rows[0].last_reset instanceof Date
            ? rows[0].last_reset.toISOString().slice(0, 10)
            : String(rows[0].last_reset).slice(0, 10);
          if (lastReset === today && rows[0].count > LIMIT) {
            // Undo the increment so they don't burn through their limit on rejected requests
            if (isRegistered) {
              await db.execute('UPDATE consult_counts SET count=? WHERE customer_id=?', [LIMIT, customerId]);
            } else {
              await db.execute('UPDATE consult_counts SET count=? WHERE session_id=? AND customer_id IS NULL', [LIMIT, sessionId]);
            }
            const msg = isRegistered
              ? `Has usado tus ${REG_LIMIT} consultas de hoy. Realiza una compra para reiniciar tu límite, o vuelve mañana.`
              : `Has usado tus ${ANON_LIMIT} consultas gratuitas de hoy. Regístrate para obtener ${REG_LIMIT} consultas diarias.`;
            return res.status(403).json({ error: 'consult_limit', message: msg });
          }
        }
      } else {
        // Follow-up message — just check, don't increment
        const [rows] = isRegistered
          ? await db.execute('SELECT count, last_reset FROM consult_counts WHERE customer_id=?', [customerId])
          : await db.execute('SELECT count, last_reset FROM consult_counts WHERE session_id=? AND customer_id IS NULL', [sessionId]);
        if (rows.length) {
          const lastReset = rows[0].last_reset instanceof Date
            ? rows[0].last_reset.toISOString().slice(0, 10)
            : String(rows[0].last_reset).slice(0, 10);
          if (lastReset === today && rows[0].count > LIMIT) {
            // Same message the first-message path builds — sin esto el frontend
            // cae a un texto genérico que siempre invita a "regístrate", incluso
            // a un cliente que ya tiene cuenta y solo agotó sus 4 consultas.
            const msg = isRegistered
              ? `Has usado tus ${REG_LIMIT} consultas de hoy. Realiza una compra para reiniciar tu límite, o vuelve mañana.`
              : `Has usado tus ${ANON_LIMIT} consultas gratuitas de hoy. Regístrate para obtener ${REG_LIMIT} consultas diarias.`;
            return res.status(403).json({ error: 'consult_limit', message: msg });
          }
        }
      }
    } catch(e) { console.warn('Consult count error:', e.message); }
  }

  // ── Infer gender from conversation if not in profile ────────────────────
  // Check last user message for gender signals
  const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content?.toLowerCase() || '';
  const shoppingForOther = /para (mi )?(novia|esposa|esposo|novio|pareja|mamá|mama|papá|papa|hijo|hija|amigo|amiga|regalo|alguien)/i.test(lastUserMsg);
  const explicitMale   = /(hombre|masculin|para él|para mi esposo|para mi novio|para mi papá|para mi hijo)/i.test(lastUserMsg);
  const explicitFemale = /(mujer|femenin|para ella|para mi esposa|para mi novia|para mi mamá|para mi hija)/i.test(lastUserMsg);

  // ── Load and merge saved profile(s) — registered (up to 7) or anonymous (1) ──
  // Anonymous sessions used to save their profile fine but never got it back:
  // Nez had no memory of them across a page reload (e.g. jumping between
  // index.html and tienda.html — two separate pages, same session_id). Now
  // both paths go through the same frequency-weighted merge.
  let profileContext = '';
  let mergedProfile = null;
  try {
    let profileRows = [];
    let touchQuery = null, touchArgs = null;
    let label = '';
    if (isRegistered) {
      const customerId2 = customerSession.user.id;
      [profileRows] = await db.execute(
        'SELECT profile FROM scent_profiles WHERE customer_id=? ORDER BY created_at DESC LIMIT 7',
        [customerId2]
      );
      touchQuery = 'UPDATE scent_profiles SET last_used=? WHERE customer_id=?';
      touchArgs  = [new Date(), customerId2];
      label = 'PERFIL CONSOLIDADO DEL CLIENTE (basado en ' + profileRows.length + ' sesión' + (profileRows.length > 1 ? 'es' : '') + ' previas)';
    } else if (sessionId) {
      [profileRows] = await db.execute(
        'SELECT profile FROM scent_profiles WHERE session_id=? AND customer_id IS NULL ORDER BY updated_at DESC LIMIT 1',
        [sessionId]
      );
      touchQuery = 'UPDATE scent_profiles SET last_used=? WHERE session_id=? AND customer_id IS NULL';
      touchArgs  = [new Date(), sessionId];
      label = 'PERFIL DEL CLIENTE (de esta misma sesión, aunque el chat se haya reiniciado)';
    }

    if (profileRows.length) {
      // Merge profiles: frequency-weighted aggregation (degenerates cleanly to
      // a single profile's own values when there's only one row, as for anon).
      const profiles = profileRows.map(r => { try { return JSON.parse(r.profile); } catch(e) { return null; } }).filter(Boolean);
      const total = profiles.length;

      // Gender: majority vote
      const genderVotes = { M: 0, F: 0, U: 0 };
      profiles.forEach(p => { if (p.gender_pref) genderVotes[p.gender_pref] = (genderVotes[p.gender_pref]||0) + 1; });
      const gender_pref = Object.entries(genderVotes).sort((a,b) => b[1]-a[1])[0][0];

      // Families: count occurrences, keep those appearing in >20% of profiles
      const famCount = {};
      profiles.forEach(p => (p.families||[]).forEach(f => { famCount[f] = (famCount[f]||0) + 1; }));
      const families = Object.entries(famCount).filter(([,c]) => c >= Math.max(1, total * 0.2)).sort((a,b) => b[1]-a[1]).map(([f]) => f).slice(0,5);

      // Intensity: most common
      const intCount = {};
      profiles.forEach(p => { if (p.intensity) intCount[p.intensity] = (intCount[p.intensity]||0) + 1; });
      const intensity = Object.entries(intCount).sort((a,b) => b[1]-a[1])[0]?.[0] || null;

      // Season: most common (excluding 'All')
      const seaCount = {};
      profiles.forEach(p => { if (p.season && p.season !== 'All') seaCount[p.season] = (seaCount[p.season]||0) + 1; });
      const season = Object.entries(seaCount).sort((a,b) => b[1]-a[1])[0]?.[0] || 'All';

      // Price: average of provided max prices
      const prices = profiles.map(p => p.price_max).filter(Boolean);
      const price_max = prices.length ? Math.round(prices.reduce((a,b) => a+b, 0) / prices.length) : null;

      // Avoid: union of all avoid lists
      const avoidSet = new Set();
      profiles.forEach(p => (p.avoid||[]).forEach(a => avoidSet.add(a)));

      // Recommended IDs: all unique IDs seen across sessions
      const recIdSet = new Set();
      profiles.forEach(p => (p.recommended_ids||[]).forEach(id => recIdSet.add(Number(id))));

      mergedProfile = { gender_pref, families, intensity, season, price_max, avoid: [...avoidSet], recommended_ids: [...recIdSet] };

      const parts = [];
      if (gender_pref !== 'U') parts.push(gender_pref === 'M' ? 'Prefiere fragancias masculinas' : 'Prefiere fragancias femeninas');
      if (families.length) parts.push(`Familias favoritas: ${families.join(', ')}`);
      if (intensity) parts.push(`Intensidad preferida: ${intensity}`);
      if (season && season !== 'All') parts.push(`Temporada: ${season}`);
      if (avoidSet.size) parts.push(`Evita: ${[...avoidSet].join(', ')}`);
      if (price_max) parts.push(`Presupuesto promedio: hasta $${price_max}`);

      if (parts.length) {
        const genderLine = gender_pref !== 'U'
          ? `\n\nGÉNERO DEL CLIENTE: ${gender_pref === 'M' ? 'Masculino' : 'Femenino'}. Pasa gender:"${gender_pref}" al llamar search_catalogue SIEMPRE, salvo que el cliente pida explícitamente fragancias para otro género o diga que compra para alguien más.`
          : '';
        profileContext = '\n\n' + label + ': ' + parts.join(' | ') + '. Úsalo para orientar tus recomendaciones naturalmente, sin mencionarlo explícitamente.' + genderLine;
      }
      if (touchQuery) await db.execute(touchQuery, touchArgs);
    }
  } catch(e) { console.warn('Profile load error:', e.message); }

  // Extract IDs already recommended in this conversation to avoid repeats
  const alreadyRecommended = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.content) {
      const match = m.content.match(/PERFIL_JSON:\s*({[\s\S]+?})/);
      if (match) {
        try {
          const prev = JSON.parse(match[1]);
          if (Array.isArray(prev.recommended_ids)) alreadyRecommended.push(...prev.recommended_ids.map(Number));
        } catch(e) {}
      }
    }
  }
  const avoidIds = [...new Set(alreadyRecommended)];
  // Tell Nez if this is the last turn
  const isLastTurn = userMsgCount >= 4; // fire on 4th user msg so 5th response feels like natural close
  const lastTurnNote = isLastTurn ? '\n\nÚLTIMO MENSAJE: Este es tu último mensaje en esta consulta. NO hagas preguntas — el cliente no podrá responder. Cierra con tu mejor recomendación y dirige a las tarjetas.' : '';

  const avoidNote = avoidIds.length
    ? `\n\nPRODUCTOS YA RECOMENDADOS EN ESTA CONVERSACIÓN: IDs ${avoidIds.join(', ')}. Pasa estos IDs en el parámetro exclude_ids al llamar search_catalogue para obtener opciones frescas. Si el catálogo no tiene suficientes alternativas puedes repetir alguno justificándolo.`
    : '';

  // Si la venta de decants está desactivada, Nez no debe ofrecerlos ni mencionar su precio —
  // el catálogo (search_catalogue) tampoco expondrá decant10/decant5 en el resultado.
  const decantsEnabled = (await getSetting('decants_enabled', '1')) !== '0';
  const decantSalesLine = decantsEnabled
    ? 'Presupuesto limitado → menciona el precio del decant. Para fragancias luxury el resultado incluye decant10:$XX y decant5:$XX — el 5ml es la entrada más accesible.'
    : 'La venta de decants está temporalmente desactivada — NO los ofrezcas ni menciones su precio. Si preguntan por decants o muestras, indica con naturalidad que por ahora solo hay frasco completo disponible.';
  const decantHigieneLines = decantsEnabled
    ? '\n- Cada decant es fraccionado bajo estrictas normas de higiene — el mismo producto que encuentras en una tienda de lujo.\n- Los decants vienen en viales de cristal con casing de aluminio — el aluminio protege de la luz directa que degrada la composición química del perfume, y el cristal preserva la fragancia sin alterar su aroma. Es el mismo estándar que usan las casas de perfumería de lujo para sus muestras.'
    : '';
  const decantValueLine = decantsEnabled
    ? '\n- El decant es la forma más inteligente de probar un perfume de lujo antes de invertir en el frasco completo — ningún competidor te da esa seguridad.'
    : '';
  const priceObjectionLine = decantsEnabled
    ? '- "Está caro" / "es mucho" → ofrece el decant: "Puedes probarla en decant por $XX — vial de cristal, mismo perfume, sin compromiso."\n- "¿Por qué cuesta tanto?" → explica brevemente: ingredientes premium, duración, proyección, autenticidad garantizada. Redirige al decant. SIEMPRE llama search_catalogue para obtener el ID del producto y mostrar su tarjeta — nunca respondas una objeción de precio sin tarjeta.\n- Si el decant también está fuera de rango → busca con max_price ajustado y presenta alternativas con tarjetas.'
    : '- "Está caro" / "es mucho" → explica brevemente: ingredientes premium, duración, proyección, autenticidad garantizada. SIEMPRE llama search_catalogue para obtener el ID del producto y mostrar su tarjeta — nunca respondas una objeción de precio sin tarjeta.\n- "¿Por qué cuesta tanto?" → misma explicación, con confianza. Si el precio sigue fuera de rango → busca con max_price ajustado y presenta alternativas con tarjetas.';
  const closingDecantLine = decantsEnabled
    ? '\n- "El decant es exactamente para esto. Lo tienes en la tarjeta."\n- "Si te convence en decant, el frasco siempre va a estar aquí."'
    : '';

  // Override gender context if current message signals shopping for someone else
  let genderOverride = '';
  if (shoppingForOther) {
    genderOverride = '\n\nATENCIÓN: El cliente está comprando para otra persona. Ignora el género del perfil guardado y usa gender:"any" en search_catalogue. Pregunta para quién es si no está claro.';
  } else if (explicitMale && mergedProfile?.gender_pref !== 'M') {
    genderOverride = '\n\nEl cliente pide fragancias masculinas en este mensaje. Usa gender:"M" en search_catalogue.';
  } else if (explicitFemale && mergedProfile?.gender_pref !== 'F') {
    genderOverride = '\n\nEl cliente pide fragancias femeninas en este mensaje. Usa gender:"F" en search_catalogue.';
  }

  const systemPrompt = `Eres Nez, sommelier de Sillage Parfumerie, El Salvador.${profileContext}${avoidNote}${genderOverride}${lastTurnNote}

IDENTIDAD: Nunca digas que eres IA. Eres Nez, sommelier. Tono cálido, directo, premium. Sin rodeos. Sin preguntas innecesarias al final de cada mensaje.

VOZ — HABLA COMO HUMANO, NO COMO FOLLETO:
- Habla como una persona real con criterio y pasión por el perfume — como si le recomendaras a un amigo, no como una ficha de producto.
- Usa lenguaje sensorial y concreto: cómo abre, cómo evoluciona, qué evoca, cuándo te la pondrías. Habla del olor, no de "características".
- PROHIBIDAS estas muletillas de IA/marketing (no las uses NUNCA): "se caracteriza por", "ideal para quienes buscan", "es una opción interesante", "apta para diversas ocasiones", "un aroma que impresione", "buena presencia", "perfecta para cualquier ocasión", "complementado con notas de", "envolvente y sofisticada".
- Varía SIEMPRE la estructura — nunca uses la misma plantilla dos veces seguidas. Si una respuesta empezó con el nombre, la siguiente empieza distinto.
- Frases cortas y vivas. Contracciones naturales. Una opinión real ("esta es de mis favoritas para la noche", "tiene gancho", "huele caro sin gritar").
- Cuando den tu opinión sobre un perfume, da una opinión DE VERDAD — con personalidad, no una descripción neutra de Wikipedia.

OBJETIVO: Perfilar en pocos turnos. Recomendar lo antes posible. Solo productos del catálogo.

REGLA DE ORO (innegociable): TODO lo que está en el catálogo es un producto que vendemos con orgullo y respaldamos al 100%. NUNCA digas que un producto del catálogo "no es lo bastante bueno", "no es premium/de nicho", o que "no lo recomendamos". JAMÁS menosprecies una marca que vendemos (Lattafa, Afnan, Armaf, etc. son excelentes y las ofrecemos con gusto). Si te preguntan por un producto específico que está en el catálogo, descríbelo SIEMPRE por sus virtudes y muéstralo con su tarjeta. Rechazar o criticar algo que vendemos es perder una venta y dañar la confianza.

FLUJO (máx 5 turnos):
- T1: bienvenida breve + máx 2 preguntas si faltan datos clave
- T2+: si hay contexto suficiente, recomienda sin preguntar más
- Si el usuario da contexto desde el inicio, recomienda de inmediato

CUÁNDO buscar: cualquier ocasión, vibe, familia, nota, producto o marca → busca. En duda → busca.
CUÁNDO preguntar: SOLO si el mensaje no da ninguna pista útil.
NUNCA preguntes lo que ya sabes. NUNCA digas que algo no existe (ni "no tengo información") sin buscarlo PRIMERO.
CONSULTA POR NOMBRE/OPINIÓN: si preguntan por un perfume específico o "qué opinas de X", llama search_catalogue pasando el nombre en notes (ej. notes:["sherif"]) o la marca en brand. Si aparece, responde con su carácter y notas y muéstralo. Solo si tras buscar realmente no está, dilo con tacto y ofrece una alternativa similar del catálogo.

SEÑALES DE INTENCIÓN ALTA — interprétalas y actúa:
- "Algo que no lo tenga cualquiera", "algo exclusivo", "algo diferente", "algo especial", "algo único", "algo de nicho" → el cliente quiere carácter y rareza. USA min_price:150 en search_catalogue para filtrar el tier diamond/gold y quedarte solo con premium. Busca en families: ["chypre","woody","oriental","leather","oud"]. Las marcas de nicho en nuestro catálogo son: Maison Francis Kurkdjian, Creed, Tom Ford, Initio, Parfums de Marly, Le Labo, Vilhelm Parfumerie, Mancera, Montale, Sospiro. Para estas solicitudes de exclusividad, PRIORIZA esas casas de nicho por encima de marcas más accesibles (Lattafa, Afnan, Armaf, Ajmal, Zimaya). Pero esto es SOLO una priorización para pedidos de "exclusividad": si el cliente pregunta por una de esas marcas accesibles o por un producto específico, recomiéndalo con gusto — todas son parte de nuestro catálogo y las respaldamos.
- "Lo mejor que tengas", "algo lujoso", "sin límite de presupuesto" → luxury tier directo. USA min_price:250. Baccarat Rouge, Aventus, Delina, Santal 33, Layton, Guidance.
- "Algo que dure todo el día", "que se sienta desde lejos" → prioriza sillage:Very Strong en los resultados.
- "Algo para impresionar" → proyección fuerte, fragancias con firma clara. min_price:100.

BÚSQUEDA:
- SIEMPRE usa exclude_ids con los IDs ya recomendados — NUNCA repitas productos ya mostrados
- Vibe/ocasión → families: "cena elegante"→["oriental","woody","chypre"], "día fresco"→["fresh","citrus"], "casual"→["woody","fougere","fresh"]
- Notas en español se traducen (piña→pineapple, sándalo→sandalwood, cedro→cedar, etc.)
- Si recomendaste algo incorrecto: admítelo, busca de nuevo

FORMATO — MUY IMPORTANTE:
- NUNCA uses listas numeradas (1. 2. 3.). Presenta cada fragancia en máx 2 líneas: nombre — perfil — por qué encaja.
- NO termines con "¿Te gustaría saber más?" ni preguntas de cierre — el cliente preguntará si quiere más.
- Sin párrafos largos. Sin explicaciones de notas. Directo.

RECOMENDACIONES: 1-3 según contexto. Sin precios. Si stock:low_stock → menciona sutilmente.
${decantSalesLine}

GÉNERO: perfil con género → úsalo siempre. Sin género → pregunta UNA vez. Unisex válido para cualquier género.

PERFIL_JSON — al final cuando presentes fragancias (sin texto después):
PERFIL_JSON:{...}
Ejemplo: PERFIL_JSON:{"gender_pref":"M","families":["oriental","woody"],"notes":["amber","oud"],"intensity":"strong","occasions":["evening"],"season":"Fall","price_min":0,"price_max":500,"avoid":[],"recommended_ids":[33,40,22]}
Campos: gender_pref, families (NON-EMPTY), notes, intensity, occasions, season, price_min, price_max, avoid, recommended_ids, gift (true solo en consultas de regalo).
CRÍTICO — ACUMULA, no solo lo de este turno: incluye TODO lo que ya sabes del cliente de TODA la conversación hasta ahora, no solo lo que dijo en su último mensaje. Si en un mensaje anterior mencionó género, intensidad, ocasión, temporada o presupuesto, vuelve a incluirlo en CADA PERFIL_JSON aunque no lo haya repetido ahora — nunca omitas un campo solo porque ya lo dijiste en un turno previo.
SOLO omite PERFIL_JSON si únicamente haces una pregunta.

CIERRE: Cuando el cliente muestre interés o decisión, cierra directo: "La encuentras en las tarjetas de abajo — agrégala al carrito desde ahí." Si ya eligió, confirma y cierra: "Perfecto. La tienes en la tarjeta de abajo." No preguntes "¿te gustaría agregarla?" — simplemente indica dónde está.
ÚLTIMO TURNO: Si es tu último mensaje disponible en esta consulta, NUNCA termines con una pregunta — el cliente no podrá responder. Cierra con una recomendación final clara y dirige a las tarjetas con una de las frases del CIERRE FINAL.

VALORES DE SILLAGE — úsalos en objeciones:
- Autenticidad garantizada: importamos de distribuidores mayoristas autorizados en EE.UU., con todos los registros sanitarios de El Salvador. Sin réplicas, sin alteraciones.${decantHigieneLines}
- Entrega: Gran San Salvador 1-3 días hábiles, Interior del país 3-7 días, Centroamérica 7-15 días.
- Política de devoluciones disponible.${decantValueLine}

OBJECIONES DE PRECIO:
${priceObjectionLine}
- Nunca te disculpes por el precio — defiéndelo con confianza.
- REGLA CRÍTICA: Cada vez que menciones o recomiendes un producto — en cualquier contexto, incluyendo objeciones — DEBES escribir su nombre en **negritas** así: **Armaf Club de Nuit Intense**. Sin negritas no aparece la tarjeta. Sin tarjeta no hay venta.

OBJECIONES DE COMPETENCIA / CONFIANZA:
- Si el cliente menciona otro vendedor o precio más bajo → no ataques, pero planta la duda: "La diferencia está en lo que no ves — procedencia, fraccionado, almacenamiento. Con Sillage eso está resuelto."
- Si pregunta por autenticidad → responde con confianza total y sin rodeos.

CIERRE FINAL — varía el cierre, nunca repitas la misma frase:
- "Están en las tarjetas — es un buen momento para probarla."${closingDecantLine}
- "Pocas formas mejores de conocer una fragancia antes de comprometerte con el frasco."
Nunca uses "cualquiera es una excelente elección" — es genérico y no cierra nada.

EVITA REPETIR: No uses los mismos argumentos dos veces en la misma conversación. Si ya mencionaste "distribuidores autorizados", en la siguiente objeción usa otro ángulo — el vial de cristal, los tiempos de entrega, la política de devoluciones, o simplemente confía en el producto sin justificarlo.

STOCK BAJO: stock:low_stock → "quedan pocas unidades" con naturalidad. No lo dramatices pero tampoco lo suavices.

REGALOS: Si el cliente menciona regalo o el contexto lo sugiere:
- Pregunta solo: ¿para quién es — hombre, mujer, o unisex? ¿qué personalidad o estilo tiene?
- Usa género y estilo de quien recibe, no de quien compra
- No sugieras decants para regalos — el frasco completo es lo apropiado
- Fragancias con proyección y sillage fuertes — un regalo debe impresionar al abrirlo
- CRÍTICO: En el PERFIL_JSON de consultas de regalo, incluye siempre "gift":true y usa gender_pref:"U" — nunca guardes el género del receptor como perfil del usuario que compra

Responde en el idioma del cliente.`


  // ── Tool definition ───────────────────────────────────
  const tools = [{
    type: 'function',
    function: {
      name: 'search_catalogue',
      description: 'Search the live fragrance catalogue. Call this whenever you have enough context about what the customer wants. You can search multiple families and notes at once for richer, more varied results.',
      parameters: {
        type: 'object',
        properties: {
          gender:    { type: 'string', enum: ['M','F','U','any'], description: 'Gender filter. Pass the customer profile gender by default. Use "any" only when customer explicitly shops for someone else or requests unisex.' },
          families:  { type: 'array', items: { type: 'string' }, description: 'Olfactive families to search — use multiple for broader results (e.g. ["woody","oriental"] for an elegant evening scent, ["fresh","citrus"] for something light). Options: woody, floral, oriental, citrus, fresh, aquatic, gourmand, chypre, fougere, spicy, powdery, green' },
          notes:     { type: 'array', items: { type: 'string' }, description: 'Specific ingredients the customer mentioned (e.g. ["oud","vanilla","rose"]). Use when customer explicitly names ingredients.' },
          brand:     { type: 'string', description: 'Filter by brand name (e.g. "Creed", "Dior", "Chanel"). Use when customer asks about a specific brand.' },
          exclude_ids: { type: 'array', items: { type: 'number' }, description: 'Product IDs already recommended in this conversation — exclude these from results' },
          max_price: { type: 'number', description: 'Maximum price in USD' },
          min_price: { type: 'number', description: 'Minimum price in USD' },
          season:    { type: 'string', description: 'Season: Spring, Summer, Fall, Winter, All Seasons' },
          intensity: { type: 'string', enum: ['Light','Moderate','Strong','Very Strong','any'], description: 'Sillage/projection preference' }
        },
        required: []
      }
    }
  }];

  // ── Tool executor ─────────────────────────────────────
  async function executeTool(name, args) {
    if (name !== 'search_catalogue') return '[]';
    try {
      const [catalogue, invMap, priceMap] = await Promise.all([
        getCatalogue(), getInventoryMap(), getPricingMap()
      ]);

      // Normalize arrays (model may send single string for legacy compat)
      const families   = Array.isArray(args.families) ? args.families.map(f=>f.toLowerCase()) :
                         args.family ? [args.family.toLowerCase()] : [];
      const noteTerms  = Array.isArray(args.notes) ? args.notes.map(n=>n.toLowerCase()) :
                         args.note  ? [args.note.toLowerCase()]  : [];
      const excludeIds = new Set((args.exclude_ids||[]).map(Number));

      // Cache key — based on search params (excluding exclude_ids which vary per conversation).
      // Incluye decantsEnabled: si se desactiva la venta de decants, el caché de 30 min no debe
      // seguir sirviendo resultados con precios de decant ya horneados en el texto.
      const cacheKey = JSON.stringify({ families, noteTerms,
        gender: args.gender, max_price: args.max_price, min_price: args.min_price,
        season: args.season, intensity: args.intensity, decantsEnabled });
      const cached = getToolCache(cacheKey);
      if (cached) {
        // Still apply exclude_ids filter on cached result
        if (excludeIds.size) {
          const filtered = cached.split('\n')
            .filter(line => !line.match(/^id:(\d+)/) || !excludeIds.has(Number(line.match(/^id:(\d+)/)[1])))
            .join('\n');
          return filtered || cached;
        }
        return cached;
      }

      // ── Spanish → English note aliases ──────────────────────────────────────
      // Translate common Spanish note terms before matching against English catalogue
      const noteAliases = {
        'piña':'pineapple','manzana':'apple','pera':'pear','melon':'melon',
        'naranja':'orange','mandarina':'mandarin','limón':'lemon','limon':'lemon',
        'bergamota':'bergamot','pomelo':'grapefruit','toronja':'grapefruit',
        'rosa':'rose','jazmín':'jasmine','jazmin':'jasmine','iris':'iris',
        'violeta':'violet','lavanda':'lavender','geranio':'geranium',
        'cedro':'cedar','sandalo':'sandalwood','sándalo':'sandalwood',
        'vetiver':'vetiver','pachuli':'patchouli','patchuli':'patchouli',
        'oud':'oud','cuero':'leather','tabaco':'tobacco','vainilla':'vanilla',
        'ámbar':'amber','ambar':'amber','almizce':'musk','musgo':'moss',
        'madera':'wood','especias':'spice','pimienta':'pepper','canela':'cinnamon',
        'incienso':'incense','mirra':'myrrh','bergamota':'bergamot',
        'frutos rojos':'berry','granada':'pomegranate','mora':'blackberry',
        'grosella':'blackcurrant','musgo de roble':'oakmoss',
      };
      const expandedNoteTerms = noteTerms.flatMap(n => {
        const alias = noteAliases[n.toLowerCase()];
        return alias ? [n, alias] : [n];
      });

      // ── Brand filter (exact or partial match, case-insensitive) ──────────────
      const brandFilter = args.brand ? args.brand.toLowerCase().trim() : null;

      // ── Score every product ───────────────────────────────────────────────
      // Also check if model is searching by product name directly
      const searchTerms = [...families, ...expandedNoteTerms].join(' ').toLowerCase();
      const scored = catalogue
        .filter(p => !excludeIds.has(Number(p.id)))
        .filter(p => {
          // Hard brand filter — if brand specified, only show that brand's products
          if (brandFilter && !p.brand.toLowerCase().includes(brandFilter) && !brandFilter.includes(p.brand.toLowerCase())) return false;
          return true;
        })
        .filter(p => {
          // Hard-exclude wrong gender BEFORE scoring — a penalty-based approach
          // lets high family/note scores overcome the gender filter, which causes
          // feminine products to appear in masculine searches and vice versa.
          if (!args.gender || args.gender === 'any') return true;
          return p.g === args.gender || p.g === 'U';
        })
        .map(p => {
          let score = 0;
          const inv = invMap[p.id] || {};
          const effPrice = (() => { const pr = priceMap[p.id]||{}; return (pr.onSale && pr.salePrice) ? Math.round(+pr.salePrice) : parseFloat(p.price); })();

          // Hard-exclude out of stock
          if (inv.outOfStock) return { p, score: -999 };

          const pText = [(p.notes||''),(p.top||''),(p.mid||''),(p.base||'')].join(' ').toLowerCase();
          const pFamilies = (p.family||'').toLowerCase().split(',').map(f=>f.trim()).filter(Boolean);
          const pFullName = (p.brand+' '+p.name).toLowerCase();

          // Direct name/brand match — if model passes product name as note (e.g. "santal 33", "sauvage")
          expandedNoteTerms.forEach(nt => {
            const ntNorm = nt.replace(/[^a-z0-9]/g, '');
            const nameNorm = pFullName.replace(/[^a-z0-9 ]/g, '');
            if(nameNorm.includes(ntNorm) || ntNorm.includes(nameNorm.split(' ').find(w => w.length > 4)||'')) score += 30;
          });

          // Gender bonus for exact match (unisex already passed the hard filter above)
          if (args.gender && args.gender !== 'any') {
            if (p.g === args.gender) score += 10;
            else if (p.g === 'U')   score += 5;
          }

          // Family tags — exact tag match scores highest, text match scores lower
          families.forEach((fam, idx) => {
            const weight = Math.max(12 - idx * 2, 6); // first family = 12, second = 10...
            if (pFamilies.includes(fam))          score += weight;
            else if (pText.includes(fam))         score += Math.floor(weight * 0.6);
          });

          // Specific notes (with Spanish alias expansion)
          // Higher weight so note matches strongly outrank generic family matches
          let noteMatchCount = 0;
          expandedNoteTerms.forEach(nt => {
            if (pText.includes(nt)) { score += 25; noteMatchCount++; }
          });
          // Hard penalty: if specific notes requested and product has NONE, bury it
          // But skip penalty if the product matched by NAME (name match was the intent)
          const hadNameMatch = expandedNoteTerms.some(nt => {
            const ntNorm = nt.replace(/[^a-z0-9]/g, '');
            const nameNorm = (p.brand+' '+p.name).toLowerCase().replace(/[^a-z0-9 ]/g, '');
            return nameNorm.includes(ntNorm) || ntNorm.includes(nameNorm.split(' ').find(w => w.length > 4)||'');
          });
          if (expandedNoteTerms.length > 0 && noteMatchCount === 0 && !hadNameMatch) score -= 50;

          // Price range
          const price = parseFloat(p.price);
          if (args.max_price && price > args.max_price) score -= 50; // hard exclude
          if (args.min_price && price < args.min_price) score -= 50; // hard exclude

          // Season
          if (args.season && args.season !== 'any') {
            if ((p.season||'').includes(args.season) || p.season === 'All Seasons') score += 6;
            else score -= 3;
          }

          // Intensity
          if (args.intensity && args.intensity !== 'any') {
            if (p.sillage === args.intensity) score += 6;
          }

          // Small diversity bonus — avoid always picking bestsellers
          if (!p.badge) score += 2; // slight boost for non-badged items to surface them

          return { p, score };
        })
        .filter(x => x.score > -15) // exclude very low-scoring products
        .sort((a, b) => b.score - a.score);

      // Return top 8 so model has real choices — not just 3
      const top = scored.filter(x => x.score > -999).slice(0, 8);

      if (!top.length) {
        // Full fallback: gender + price only
        const fallback = catalogue
          .filter(p => !excludeIds.has(Number(p.id)))
          .filter(p => !args.gender || args.gender === 'any' || p.g === args.gender || p.g === 'U')
          .filter(p => !args.max_price || parseFloat(p.price) <= args.max_price)
          .filter(p => !args.min_price || parseFloat(p.price) >= args.min_price)
          .slice(0, 8);
        if (!fallback.length) return 'Catálogo vacío — agrega fragancias desde el panel de administración.';
        return fallback.map(p =>
          [
            `id:${p.id} ${p.brand} ${p.name} $${p.price} ${p.g}`,
            p.family  ? `family:${p.family}`    : null,
            p.notes   ? `notes:${p.notes}`      : null,
            p.top     ? `top:${p.top}`          : null,
            p.mid     ? `mid:${p.mid}`          : null,
            p.base    ? `base:${p.base}`        : null,
            p.conc    ? `conc:${p.conc}`        : null,
            p.sillage ? `sillage:${p.sillage}`  : null,
            p.season  ? `season:${p.season}`    : null,
            p.tagline ? `tagline:"${p.tagline}"`: null,
          ].filter(Boolean).join(' | ')
        ).join('\n');
      }

      const result = top.map(({p, score}) => {
        const inv = invMap[p.id] || {};
        const pr  = priceMap[p.id] || {};
        const effPrice = (pr.onSale && pr.salePrice) ? Math.round(+pr.salePrice) : parseFloat(p.price);
        const stockLabel = inv.lowStock ? 'low_stock' : 'in_stock';
        const priceLabel = (pr.onSale && pr.salePrice) ? `$${effPrice} (sale, was $${p.price})` : `$${effPrice}`;
        // Sin decantsEnabled, ni el precio ni la palabra "decant" llegan al modelo —
        // así Nez no puede mencionarlos aunque el prompt fallara en suprimirlo.
        let decantLabel = '';
        if (decantsEnabled) {
          const decantP  = p.decantPrice  ? parseFloat(p.decantPrice)  : Math.round(effPrice * 0.30);
          const decant5P = p.decantPrice5 ? parseFloat(p.decantPrice5) : Math.round(decantP * 0.55);
          decantLabel = p.luxury ? `decant10:$${decantP} decant5:$${decant5P}` : `decant:$${decantP}`;
        }
        const parts = [
          `id:${p.id} ${p.brand} ${p.name} ${priceLabel}${decantLabel ? ' ' + decantLabel : ''} ${p.g}`,
          p.family   ? `family:${p.family}`       : null,
          p.notes    ? `notes:${p.notes}`          : null,
          p.top      ? `top:${p.top}`              : null,
          p.mid      ? `mid:${p.mid}`              : null,
          p.base     ? `base:${p.base}`            : null,
          p.conc     ? `conc:${p.conc}`            : null,
          p.sillage  ? `sillage:${p.sillage}`      : null,
          p.season   ? `season:${p.season}`        : null,
          p.tagline  ? `tagline:"${p.tagline}"`    : null,
          p.desc     ? `desc:"${p.desc}"`          : null,
          `[stock:${stockLabel}]`,
          p.badge    ? `[${p.badge}]`              : null,
          `[score:${score}]`
        ].filter(Boolean);
        return parts.join(' | ');
      }).join('\n');

      setToolCache(cacheKey, result);
      // Apply exclude_ids on fresh result too
      if (excludeIds.size) {
        return result.split('\n')
          .filter(line => !line.match(/^id:(\d+)/) || !excludeIds.has(Number(line.match(/^id:(\d+)/)[1])))
          .join('\n') || result;
      }
      return result;

    } catch(e) {
      console.error('Tool error:', e.message);
      return 'Error al buscar en el catálogo.';
    }
  }

  // ── OpenAI agentic loop ───────────────────────────────
  try {
    // ── Reply cache check — skip OpenAI if identical first-message query seen recently ──
    // Skip reply cache when user has a profile — personalised responses shouldn't be cached
  const replyCacheKey = profileContext ? null : getReplyCacheKey(messages, profileContext);
    if (replyCacheKey) {
      const cached = getReplyCache(replyCacheKey);
      if (cached) {
        console.log('Nez: cache hit for key', replyCacheKey.slice(0, 60));
        return res.json({ reply: cached.reply, profile: cached.profile, fromCache: true });
      }
    }

    const oaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-4).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    ];

    let finalReply = '';
    let iterations = 0;
    const MAX_ITER = 5; // allow: tool_call → result → tool_call → result → final reply
    let _ctrl, _timeout; // declared outside loop to avoid redeclaration

    while (iterations < MAX_ITER) {
      iterations++;
      _ctrl    = new AbortController();
      _timeout = setTimeout(() => _ctrl.abort(), 25000); // 25s timeout
      let response;

      // On the last iteration, disable tools to force a text reply
      const isLastIter = iterations === MAX_ITER;

      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          signal: _ctrl.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({
            model:       'gpt-4o-mini',
            messages:    oaiMessages,
            tools:       isLastIter ? undefined : tools,
            tool_choice: isLastIter ? undefined : 'auto',
            max_tokens:  900,  // 3 recommendations + PERFIL_JSON, con headroom para no truncar el JSON (rompe las tarjetas)
            temperature: 0.85  // más variación → lenguaje más natural y menos plantilla
          })
        });
        clearTimeout(_timeout);
      } catch(fetchErr) {
        clearTimeout(_timeout);
        if (fetchErr.name === 'AbortError') {
          return res.status(504).json({ error: 'timeout', message: 'El sommelier tardó demasiado. Intenta de nuevo.' });
        }
        throw fetchErr;
      }

      if (!response.ok) {
        const err = await response.text();
        console.error('OpenAI error:', err);
        if (response.status === 429) return res.status(429).json({ error: 'rate_limit' });
        return res.status(502).json({ error: 'OpenAI error' });
      }

      const data   = await response.json();
      const choice = data.choices?.[0];
      const msg    = choice?.message;

      // Log token usage including cache hits (prompt caching is automatic on gpt-4o-mini)
      if (data.usage && iterations === 1) {
        const u = data.usage;
        const cached = u.prompt_tokens_details?.cached_tokens || 0;
        console.log(`Nez tokens — input:${u.prompt_tokens} cached:${cached} output:${u.completion_tokens} total:${u.total_tokens}`);
      }

      if (!msg) break;

      // Capture any content even alongside tool_calls (OpenAI sometimes sends both)
      if (msg.content && choice.finish_reason !== 'tool_calls') {
        finalReply = msg.content;
      }

      oaiMessages.push(msg);

      // If GPT wants to call a tool
      if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch(e) {}
          const result = await executeTool(tc.function.name, args);
          oaiMessages.push({
            role:         'tool',
            tool_call_id: tc.id,
            content:      result
          });
        }
        continue; // loop again with tool results
      }

      // GPT gave a final text response
      finalReply = msg.content || finalReply;
      break;
    }

    // Extract profile JSON
    let profile = null;
    const profileMatch = finalReply.match(/PERFIL_JSON:({[\s\S]+?})/);
    if (profileMatch) {
      try {
        const parsed = JSON.parse(profileMatch[1]);
        // Reject if it's clearly the template placeholder (recommended_ids [1,2,3] with woody/moderate/300)
        const isTemplate = JSON.stringify(parsed.recommended_ids) === '[1,2,3]' &&
                           (parsed.families||[]).join(',') === 'woody' &&
                           parsed.intensity === 'moderate' &&
                           parsed.price_max === 300;
        if (!isTemplate) {
          profile = parsed;
        } else {
          console.warn('Nez returned template PERFIL_JSON — discarding');
        }
      }
      catch(e) { console.warn('Profile parse failed:', e.message); }
    } else {
      console.warn('Nez: no PERFIL_JSON in reply. Reply snippet:', finalReply.slice(0, 120));
    }
    const cleanReply = finalReply.replace(/PERFIL_JSON:[\s\S]+$/, '').trim();

    if (!cleanReply) {
      // Model returned only PERFIL_JSON with no conversational text — nudge it
      oaiMessages.push({ role: 'user', content: 'Por favor responde al cliente con tus recomendaciones en texto.' });
      try {
        const _ctrl2 = new AbortController();
        const _t2 = setTimeout(() => _ctrl2.abort(), 15000);
        const r2 = await fetch('https://api.openai.com/v1/chat/completions', {
          signal: _ctrl2.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: oaiMessages, max_tokens: 500, temperature: 0.7 })
        });
        clearTimeout(_t2);
        if (r2.ok) {
          const d2 = await r2.json();
          const retry = d2.choices?.[0]?.message?.content?.replace(/PERFIL_JSON:[\s\S]+$/, '').trim();
          if (retry) return res.json({ reply: retry, profile });
        }
      } catch(e2) { /* fall through */ }
      return res.json({ reply: 'Aquí tienes mis recomendaciones basadas en lo que me contaste. ¿Te gustaría afinar algo?', profile });
    }

    // Store in reply cache if this was a first-message query
    if (replyCacheKey && cleanReply) {
      setReplyCache(replyCacheKey, cleanReply, profile);
    }

    res.json({ reply: cleanReply, profile });

  } catch(e) {
    console.error('Sommelier error:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});


// ── Reset consult count (admin only) ─────────────────
app.delete('/api/sommelier/counts', requireAdmin, async (req, res) => {
  const { sessionId } = req.query;
  if (sessionId) {
    await db.execute('DELETE FROM consult_counts WHERE session_id=?', [sessionId]);
  } else {
    await db.execute('DELETE FROM consult_counts'); // clear all
  }
  res.json({ ok: true });
});

// POST /api/sommelier/profile — save scent profile
app.post('/api/sommelier/profile', async (req, res) => {
  let { profile, sessionId } = req.body;
  if (!profile) return res.status(400).json({ error: 'No profile' });

  // Gift profiles: sanitize before saving — don't store recipient gender as user's own
  if (profile.gift) {
    profile = { ...profile, gender_pref: 'U' };
    // Don't delete gift flag so frontend can also skip showing it in pills
  }

  const customerToken   = req.headers['x-customer-token'];
  const customerSession = customerToken ? validateSession(customerToken) : null;
  const customerId      = (customerSession && customerSession.role === 'customer') ? customerSession.user.id : null;

  const n = new Date();
  try {
    if (customerId) {
      // Always insert a new profile row (history), keep max 7 per user
      await db.execute(
        'INSERT INTO scent_profiles (customer_id, session_id, profile, created_at, updated_at, last_used) VALUES (?,?,?,?,?,?)',
        [customerId, sessionId||null, JSON.stringify(profile), n, n, n]
      );
      // Prune: delete oldest rows beyond 7
      const [allRows] = await db.execute(
        'SELECT id FROM scent_profiles WHERE customer_id=? ORDER BY created_at DESC',
        [customerId]
      );
      if (allRows.length > 7) {
        const toDelete = allRows.slice(7).map(r => r.id);
        await db.execute(
          `DELETE FROM scent_profiles WHERE id IN (${toDelete.map(() => '?').join(',')})`,
          toDelete
        );
      }
    } else if (sessionId) {
      // Upsert for anonymous sessions
      const [existing] = await db.execute('SELECT id FROM scent_profiles WHERE session_id=? AND customer_id IS NULL', [sessionId]);
      if (existing.length) {
        await db.execute('UPDATE scent_profiles SET profile=?, updated_at=? WHERE session_id=? AND customer_id IS NULL',
          [JSON.stringify(profile), n, sessionId]);
      } else {
        await db.execute('INSERT INTO scent_profiles (customer_id, session_id, profile, created_at, updated_at) VALUES (?,?,?,?,?)',
          [null, sessionId, JSON.stringify(profile), n, n]);
      }
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('Save profile error:', e.message);
    res.status(500).json({ error: 'Error saving profile' });
  }
});

// GET /api/sommelier/profile — retrieve scent profile
// sessionId goes in X-Session-ID header, not query param, to avoid logs/browser history exposure
app.get('/api/sommelier/profile', async (req, res) => {
  const customerToken   = req.headers['x-customer-token'];
  const customerSession = customerToken ? validateSession(customerToken) : null;
  const customerId      = (customerSession && customerSession.role === 'customer') ? customerSession.user.id : null;
  const sessionId       = req.headers['x-session-id'] || req.query.sessionId; // header preferred, query fallback for compat

  try {
    let rows = [];
    if (customerId) {
      [rows] = await db.execute('SELECT profile FROM scent_profiles WHERE customer_id=? ORDER BY created_at DESC LIMIT 7', [customerId]);
    } else if (sessionId) {
      [rows] = await db.execute('SELECT profile FROM scent_profiles WHERE session_id=? AND customer_id IS NULL ORDER BY created_at DESC LIMIT 1', [sessionId]);
    }
    if (!rows.length) return res.json({ profile: null });
    // For registered users: return merged profile
    if (rows.length === 1) return res.json({ profile: JSON.parse(rows[0].profile) });
    const profiles = rows.map(r => { try { return JSON.parse(r.profile); } catch(e) { return null; } }).filter(Boolean);
    const famCount = {}, intCount = {}, seaCount = {}, genderVotes = { M:0, F:0, U:0 };
    profiles.forEach(p => {
      if (p.gender_pref) genderVotes[p.gender_pref] = (genderVotes[p.gender_pref]||0) + 1;
      (p.families||[]).forEach(f => { famCount[f] = (famCount[f]||0) + 1; });
      if (p.intensity) intCount[p.intensity] = (intCount[p.intensity]||0) + 1;
      if (p.season && p.season !== 'All') seaCount[p.season] = (seaCount[p.season]||0) + 1;
    });
    const total = profiles.length;
    const merged = {
      gender_pref: Object.entries(genderVotes).sort((a,b)=>b[1]-a[1])[0][0],
      families: Object.entries(famCount).filter(([,c])=>c>=Math.max(1,total*0.2)).sort((a,b)=>b[1]-a[1]).map(([f])=>f).slice(0,5),
      intensity: Object.entries(intCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||null,
      season: Object.entries(seaCount).sort((a,b)=>b[1]-a[1])[0]?.[0]||'All',
      price_max: (() => { const p=profiles.map(x=>x.price_max).filter(Boolean); return p.length?Math.round(p.reduce((a,b)=>a+b,0)/p.length):null; })(),
      avoid: [...new Set(profiles.flatMap(p=>p.avoid||[]))],
      recommended_ids: [...new Set(profiles.flatMap(p=>(p.recommended_ids||[]).map(Number)))]
    };
    res.json({ profile: merged });
  } catch(e) {
    res.json({ profile: null });
  }
});

// DELETE /api/sommelier/profile — clear the saved scent profile (so "Restablecer"
// actually sticks across reloads, not just in localStorage).
app.delete('/api/sommelier/profile', async (req, res) => {
  const customerToken   = req.headers['x-customer-token'];
  const customerSession = customerToken ? validateSession(customerToken) : null;
  const customerId      = (customerSession && customerSession.role === 'customer') ? customerSession.user.id : null;
  const sessionId       = req.headers['x-session-id'] || req.query.sessionId;
  try {
    if (customerId)      await db.execute('DELETE FROM scent_profiles WHERE customer_id=?', [customerId]);
    else if (sessionId)  await db.execute('DELETE FROM scent_profiles WHERE session_id=? AND customer_id IS NULL', [sessionId]);
    res.json({ ok: true });
  } catch(e) {
    console.error('Clear profile error:', e.message);
    res.status(500).json({ error: 'Error clearing profile' });
  }
});
// ─── Bundle Routes ────────────────────────────────────

// ── COLLECTIONS ────────────────────────────────────────────────────────────

// GET /api/collections — public (active only, ordered)
app.get('/api/collections', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM collections WHERE active=1 ORDER BY sort_order ASC, id ASC');
    res.json(rows.map(c => ({
      ...c,
      filter_json:  c.filter_json  ? JSON.parse(c.filter_json)  : null,
      product_ids:  c.product_ids  ? JSON.parse(c.product_ids)  : []
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/collections/all — admin (includes inactive)
app.get('/api/collections/all', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM collections ORDER BY sort_order ASC, id ASC');
    res.json(rows.map(c => ({
      ...c,
      filter_json: c.filter_json ? JSON.parse(c.filter_json) : null,
      product_ids: c.product_ids ? JSON.parse(c.product_ids) : []
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/collections — create
app.post('/api/collections', requireAdmin, async (req, res) => {
  try {
    const { name, description, icon, type, filter_json, product_ids, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido.' });
    await db.execute(
      'INSERT INTO collections (name, description, icon, type, filter_json, product_ids, sort_order, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)',
      [name, description||'', icon||'✨', type||'auto',
       filter_json ? JSON.stringify(filter_json) : null,
       product_ids ? JSON.stringify(product_ids) : '[]',
       sort_order||0, new Date()]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/collections/:id — update
app.patch('/api/collections/:id', requireAdmin, async (req, res) => {
  try {
    const { name, description, icon, type, filter_json, product_ids, sort_order, active } = req.body;
    const fields = [], vals = [];
    if (name        !== undefined) { fields.push('name=?');        vals.push(name); }
    if (description !== undefined) { fields.push('description=?'); vals.push(description); }
    if (icon        !== undefined) { fields.push('icon=?');        vals.push(icon); }
    if (type        !== undefined) { fields.push('type=?');        vals.push(type); }
    if (filter_json !== undefined) { fields.push('filter_json=?'); vals.push(filter_json ? JSON.stringify(filter_json) : null); }
    if (product_ids !== undefined) { fields.push('product_ids=?'); vals.push(JSON.stringify(product_ids)); }
    if (sort_order  !== undefined) { fields.push('sort_order=?');  vals.push(sort_order); }
    if (active      !== undefined) { fields.push('active=?');      vals.push(active); }
    if (!fields.length) return res.json({ ok: true });
    vals.push(parseInt(req.params.id));
    await db.execute('UPDATE collections SET ' + fields.join(',') + ' WHERE id=?', vals);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/collections/reorder — bulk sort_order update
app.patch('/api/collections/reorder', requireAdmin, async (req, res) => {
  try {
    const { order } = req.body; // array of { id, sort_order }
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
    await Promise.all(order.map(item =>
      db.execute('UPDATE collections SET sort_order=? WHERE id=?', [item.sort_order, item.id])
    ));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/collections/:id
app.delete('/api/collections/:id', requireAdmin, async (req, res) => {
  try {
    await db.execute('DELETE FROM collections WHERE id=?', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bundles — public
app.get('/api/bundles', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM bundles WHERE active=1 ORDER BY created_at DESC');
    const bundles = rows.map(b => ({ ...b, items: JSON.parse(b.items || '[]') }));
    res.json(bundles);
  } catch(e) { res.json([]); }
});

// GET /api/bundles/all — admin (includes inactive)
app.get('/api/bundles/all', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM bundles ORDER BY created_at DESC');
    const bundles = rows.map(b => ({ ...b, items: JSON.parse(b.items || '[]') }));
    res.json(bundles);
  } catch(e) { res.json([]); }
});

// POST /api/bundles — create
app.post('/api/bundles', requireAdmin, async (req, res) => {
  const { name, description, items, price, orig_price } = req.body;
  if (!name || !items || !price) return res.status(400).json({ error: 'Missing fields' });
  await db.execute(
    'INSERT INTO bundles (name, description, items, price, orig_price, active, created_at) VALUES (?,?,?,?,?,1,?)',
    [name, description || '', JSON.stringify(items), parseFloat(price), parseFloat(orig_price || 0), new Date()]
  );
  await logActivity('Bundle creado: ' + name);
  res.json({ ok: true });
});

// PATCH /api/bundles/:id — update
app.patch('/api/bundles/:id', requireAdmin, async (req, res) => {
  const { name, description, items, price, orig_price, active } = req.body;
  const fields = [];
  const vals   = [];
  if (name        !== undefined) { fields.push('name=?');        vals.push(name); }
  if (description !== undefined) { fields.push('description=?'); vals.push(description); }
  if (items       !== undefined) { fields.push('items=?');       vals.push(JSON.stringify(items)); }
  if (price       !== undefined) { fields.push('price=?');       vals.push(parseFloat(price)); }
  if (orig_price  !== undefined) { fields.push('orig_price=?');  vals.push(parseFloat(orig_price)); }
  if (active      !== undefined) { fields.push('active=?');      vals.push(active ? 1 : 0); }
  if (!fields.length) return res.json({ ok: true });
  vals.push(req.params.id);
  await db.execute('UPDATE bundles SET ' + fields.join(',') + ' WHERE id=?', vals);
  res.json({ ok: true });
});

// DELETE /api/bundles/:id
app.delete('/api/bundles/:id', requireAdmin, async (req, res) => {
  await db.execute('DELETE FROM bundles WHERE id=?', [req.params.id]);
  await logActivity('Bundle eliminado #' + req.params.id);
  res.json({ ok: true });
});
// ─── Catalogue routes ─────────────────────────────────
app.post('/api/catalogue', requireAdmin, async (req, res) => {
  const newFrag = { ...req.body, ...calcIntensity(req.body) };
  // Auto-generate chords unless manually overridden
  if (!newFrag.chords_override) {
    newFrag.chords = calcChords(newFrag);
  }
  // Use addProduct: assigns id = MAX(id)+1 over ALL products (incl. soft-deleted
  // active=0 rows), avoiding id collisions that would silently leave the new
  // product inactive/invisible. Also inserts a single row instead of re-upserting all.
  const newId = await catalogueSvc.addProduct(newFrag);
  newFrag.id = newId;
  const catalogue = await getCatalogue();
  broadcast('catalogue', catalogue);
  await logActivity(`Fragancia agregada: ${newFrag.brand} ${newFrag.name}`);

  // Auto-create bottle_inventory record for this new fragrance (ml=0, ready to configure)
  try {
    const sizeStr    = String(newFrag.size || '');
    const sizeMatch  = sizeStr.match(/([\d.]+)\s*ml/i);
    const bottleSize = sizeMatch ? parseFloat(sizeMatch[1]) : 100;
    await db.execute(`
      INSERT IGNORE INTO bottle_inventory
        (product_id, ml_total, ml_remaining, ml_reserved, decant_size, sample_size, alert_ml, bottles_count, bottle_size, notes, updated_at)
      VALUES (?, 0, 0, 0, 5, 1.5, ?, 0, ?, '', ?)
    `, [newFrag.id, Math.max(10, bottleSize * 0.15), bottleSize, new Date()]);
  } catch(e) { /* non-fatal */ }

  res.json({ ok: true, fragrance: newFrag });
});

app.put('/api/catalogue/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const catalogue = await getCatalogue();
  const idx = catalogue.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Fragancia no encontrada' });
  catalogue[idx] = { ...req.body, id, ...calcIntensity(req.body) };
  // Recalculate chords unless manually overridden
  if (!catalogue[idx].chords_override) {
    catalogue[idx].chords = calcChords(catalogue[idx]);
  }
  await saveCatalogue(catalogue);
  broadcast('catalogue', catalogue);
  await logActivity(`Fragancia actualizada: ${catalogue[idx].brand} ${catalogue[idx].name}`);
  res.json({ ok: true, fragrance: catalogue[idx] });
});

app.delete('/api/catalogue/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const catalogue = await getCatalogue();
  const frag = catalogue.find(p => p.id === id);
  if (!frag) return res.status(404).json({ error: 'Fragancia no encontrada' });
  await deleteProduct(id);
  const updated = catalogue.filter(p => p.id !== id);
  broadcast('catalogue', updated);
  await logActivity(`Fragancia eliminada: ${frag.brand} ${frag.name}`);
  res.json({ ok: true });
});

// ── ADMIN NOTIFICATION EMAILS ────────────────────────────────────────────────

app.get('/api/admin/notification-emails', requireAdmin, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM admin_notification_emails ORDER BY created_at ASC');
  res.json(rows);
});

app.post('/api/admin/notification-emails', requireAdmin, async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido.' });
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!re.test(email)) return res.status(400).json({ error: 'Correo inválido.' });
  try {
    await db.execute(
      'INSERT INTO admin_notification_emails (email, name, active, created_at) VALUES (?,?,1,?)',
      [email.toLowerCase().trim(), name?.trim() || null, new Date()]
    );
    await logActivity(`Notificación de pedidos activada para: ${email}`);
    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Este email ya está registrado.' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/notification-emails/:id', requireAdmin, async (req, res) => {
  const { active } = req.body;
  await db.execute('UPDATE admin_notification_emails SET active=? WHERE id=?', [active ? 1 : 0, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/notification-emails/:id', requireAdmin, async (req, res) => {
  const [rows] = await db.execute('SELECT email FROM admin_notification_emails WHERE id=?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'No encontrado.' });
  await db.execute('DELETE FROM admin_notification_emails WHERE id=?', [req.params.id]);
  await logActivity(`Notificación de pedidos eliminada: ${rows[0].email}`);
  res.json({ ok: true });
});

// ── COD ABUSE MANAGEMENT ─────────────────────────────────────────────────────

// GET /api/admin/cod-blocklist
app.get('/api/admin/cod-blocklist', requireAdmin, async (req, res) => {
  const [rows] = await db.execute(
    'SELECT * FROM cod_blocklist ORDER BY created_at DESC'
  );
  res.json(rows);
});

// POST /api/admin/cod-blocklist — manually block a contact
app.post('/api/admin/cod-blocklist', requireAdmin, async (req, res) => {
  const { email, phone, reason } = req.body;
  if (!email && !phone) return res.status(400).json({ error: 'Email o teléfono requerido.' });
  await db.execute(
    `INSERT INTO cod_blocklist (email, phone, reason, blocked_by, created_at)
     VALUES (?,?,?,?,?)`,
    [email?.toLowerCase()?.trim() || null, phone?.trim() || null,
     reason || 'Bloqueado manualmente', 'admin', new Date()]
  );
  await logActivity(`COD bloqueado manualmente: ${email || phone}`);
  res.json({ ok: true });
});

// DELETE /api/admin/cod-blocklist/:id — unblock
app.delete('/api/admin/cod-blocklist/:id', requireAdmin, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM cod_blocklist WHERE id=?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'No encontrado.' });
  await db.execute('DELETE FROM cod_blocklist WHERE id=?', [req.params.id]);
  await logActivity(`COD desbloqueado: ${rows[0].email || rows[0].phone}`);
  res.json({ ok: true });
});

// GET /api/admin/cod-noshows — list no-shows with counts
app.get('/api/admin/cod-noshows', requireAdmin, async (req, res) => {
  const [rows] = await db.execute(`
    SELECT email, phone,
           COUNT(*) as total,
           MAX(created_at) as last_noshow,
           GROUP_CONCAT(order_id ORDER BY created_at DESC) as order_ids
    FROM cod_noshows
    GROUP BY email, phone
    ORDER BY total DESC, last_noshow DESC
  `);
  res.json(rows);
});

// GET /api/admin/cod-settings — get COD config
app.get('/api/admin/cod-settings', requireAdmin, async (req, res) => {
  const minOrder    = parseFloat(await getSetting('cod_min_order', '25')) || 25;
  const noshowLimit = parseInt(await getSetting('cod_noshow_limit', '2')) || 2;
  res.json({ minOrder, noshowLimit });
});

// POST /api/admin/cod-settings — update COD config
app.post('/api/admin/cod-settings', requireAdmin, async (req, res) => {
  const { minOrder, noshowLimit } = req.body;
  if (minOrder !== undefined)    await setSetting('cod_min_order',    parseFloat(minOrder));
  if (noshowLimit !== undefined) await setSetting('cod_noshow_limit', parseInt(noshowLimit));
  await logActivity(`Configuración COD actualizada — mínimo: $${minOrder}, límite no-shows: ${noshowLimit}`);
  res.json({ ok: true });
});

// POST /api/admin/sale-email — send sale notification to targeted customers
app.post('/api/admin/sale-email', requireAdmin, async (req, res) => {
  const { productId, audience, message } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId requerido.' });

  try {
    const catalogue = await getCatalogue();
    const prod = catalogue.find(p => p.id === parseInt(productId));
    if (!prod) return res.status(404).json({ error: 'Fragancia no encontrada.' });

    const [priceRows] = await db.execute(
      'SELECT sale_price, on_sale FROM pricing WHERE product_id=?', [parseInt(productId)]
    );
    const pr = priceRows[0] || {};
    const salePrice = pr.on_sale && pr.sale_price ? parseFloat(pr.sale_price) : null;
    const savings   = salePrice ? Math.round(prod.price - salePrice) : null;

    // Build recipient list based on audience
    let customers = [];
    if (audience === 'favorites') {
      // Customers whose Nez profile includes this product in recommended_ids
      const [rows] = await db.execute(`
        SELECT DISTINCT c.id, c.name, c.email, ep.unsubscribe_token
        FROM customers c
        JOIN email_preferences ep ON ep.customer_id = c.id
        LEFT JOIN sommelier_profiles sp ON sp.customer_id = c.id
        WHERE ep.marketing = 1
          AND sp.profile_json IS NOT NULL
          AND JSON_CONTAINS(
            JSON_EXTRACT(sp.profile_json, '$.recommended_ids'),
            CAST(? AS JSON)
          )
      `, [parseInt(productId)]);
      customers = rows;

      // Fallback: if no profile matches, get all marketing customers
      if (!customers.length) {
        const [allRows] = await db.execute(`
          SELECT c.id, c.name, c.email, ep.unsubscribe_token
          FROM customers c
          JOIN email_preferences ep ON ep.customer_id = c.id
          WHERE ep.marketing = 1
        `);
        customers = allRows;
      }
    } else {
      // All customers with marketing enabled
      const [rows] = await db.execute(`
        SELECT c.id, c.name, c.email, ep.unsubscribe_token
        FROM customers c
        JOIN email_preferences ep ON ep.customer_id = c.id
        WHERE ep.marketing = 1
      `);
      customers = rows;
    }

    if (!customers.length) return res.json({ ok: true, sent: 0 });

    const BASE = process.env.BASE_URL || 'https://sillage-sv.com';
    let sent = 0;

    for (const customer of customers) {
      const unsubUrl = `${BASE}/preferencias-email?token=${customer.unsubscribe_token}`;
      const productUrl = `${BASE}/?producto=${prod.id}`;

      const savingsHtml = savings
        ? `<div style="display:inline-block;background:#b8955a;color:#0e0c0a;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:4px 12px;margin-bottom:16px">Ahorra $${savings}</div>`
        : '';

      const customMsgHtml = message
        ? `<p style="font-size:13px;color:#8a7f72;line-height:1.8;font-style:italic;margin:0 0 20px;border-left:2px solid #b8955a;padding-left:12px">${escHtml(message)}</p>`
        : '';

      const html = emailTemplate(`
        <p style="font-size:13px;color:#8a7f72;margin:0 0 20px">
          Hola <strong style="color:#1a1714">${escHtml(customer.name.split(' ')[0])}</strong> —
          una fragancia que podrías amar acaba de tener un precio especial.
        </p>
        ${savingsHtml}
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8d8b8;margin-bottom:20px">
          <tr>
            <td style="padding:20px 24px">
              <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8955a;margin-bottom:4px">${escHtml(prod.brand)}</div>
              <div style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#1a1714;margin-bottom:8px">${escHtml(prod.name)}</div>
              ${prod.tagline ? `<div style="font-size:12px;color:#8a7f72;font-style:italic;margin-bottom:16px">${escHtml(prod.tagline)}</div>` : ''}
              <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:20px">
                ${salePrice ? `<span style="font-family:Georgia,serif;font-size:26px;color:#b8955a">$${salePrice}</span>` : ''}
                ${salePrice ? `<span style="font-size:14px;color:#aaa;text-decoration:line-through">$${prod.price}</span>` : `<span style="font-family:Georgia,serif;font-size:26px;color:#1a1714">$${prod.price}</span>`}
              </div>
              ${customMsgHtml}
              <a href="${productUrl}"
                 style="display:inline-block;padding:10px 24px;background:#b8955a;color:#0e0c0a;text-decoration:none;font-size:11px;letter-spacing:3px;text-transform:uppercase">
                Ver Fragancia →
              </a>
            </td>
          </tr>
        </table>
        <p style="font-size:11px;color:#aaa;line-height:1.6">
          Recibiste este correo porque tienes una cuenta en Sillage Parfumerie y aceptaste emails de novedades.
          <a href="${unsubUrl}" style="color:#b8955a">Gestionar preferencias</a>
        </p>
      `);

      await sendEmail({
        to: customer.email,
        subject: `${prod.brand} ${prod.name} — precio especial${savings ? ` · Ahorra $${savings}` : ''} | Sillage`,
        html
      });
      sent++;
    }

    await logActivity(`Email de oferta enviado: ${prod.brand} ${prod.name} → ${sent} clientes (audiencia: ${audience})`);
    res.json({ ok: true, sent });

  } catch(e) {
    console.error('Sale email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/backfill-chords — recalculate chords for all products missing them
app.post('/api/admin/backfill-chords', requireAdmin, async (req, res) => {
  const catalogue = await getCatalogue();
  let updated = 0;
  for (const p of catalogue) {
    if (!p.chords_override && (!p.chords || !p.chords.length)) {
      p.chords = calcChords(p);
      updated++;
    }
  }
  await saveCatalogue(catalogue);
  broadcast('catalogue', catalogue);
  await logActivity(`Chords recalculados: ${updated} productos actualizados`);
  res.json({ ok: true, updated });
});

// POST /api/admin/migrate-note-intensity
// Runs calcIntensity on every product and saves updated catalogue.
// Safe to run multiple times — just recalculates and overwrites scores.
app.post('/api/admin/migrate-note-intensity', requireAdmin, async (req, res) => {
  try {
    const catalogue = await getCatalogue();
    let updated = 0;
    const scored = catalogue.map(p => {
      const scores = calcIntensity(p);
      updated++;
      return { ...p, ...scores };
    });
    await saveCatalogue(scored);
    broadcast('catalogue', scored);
    await logActivity(`Note intensity migration: scored ${updated} products`);
    res.json({ ok: true, updated, sample: scored.slice(0, 3).map(p => ({
      id: p.id, name: p.name,
      top_intensity: p.top_intensity,
      mid_intensity: p.mid_intensity,
      base_intensity: p.base_intensity,
    }))});
  } catch(e) {
    console.error('Note intensity migration error:', e.message);
    res.status(500).json({ error: e.message });
  }
});



// Link a guest order to a newly registered customer account
app.patch('/api/customer/link-order', requireCustomer, async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'Order ID required' });
  const customerId = req.customer.user.id;
  // Only link if order belongs to same email and has no customer yet
  const [rows] = await db.execute(
    'SELECT * FROM orders WHERE id=? AND customer_id IS NULL', [orderId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Pedido no encontrado o ya vinculado' });
  const order = rows[0];
  // Verify email matches for security
  if (order.email.toLowerCase() !== req.customer.user.email.toLowerCase())
    return res.status(403).json({ error: 'Este pedido no pertenece a este correo' });
  await db.execute(
    'UPDATE orders SET customer_id=?, updated_at=? WHERE id=?',
    [customerId, new Date(), orderId]
  );
  logActivity(`Pedido ${orderId} vinculado a cliente ${req.customer.user.email}`);
  res.json({ ok: true });
});

// ── Settings / Shipping ───────────────────────────────
app.get('/api/settings/shipping', async (req, res) => {
  const cost      = parseFloat(await getSetting('shipping_cost', '5')) || 5;
  const threshold = parseFloat(await getSetting('shipping_threshold', '50')) || 50;
  const freeMsg   = await getSetting('shipping_free_msg', 'Envío gratis en pedidos mayores a');
  const paidMsg   = await getSetting('shipping_paid_msg', 'Envío estándar');
  res.json({ cost, threshold, freeMsg, paidMsg });
});

// Interruptor global: venta de decants/muestras en toda la tienda.
app.get('/api/settings/decants', async (req, res) => {
  const enabled = (await getSetting('decants_enabled', '1')) !== '0';
  res.json({ enabled });
});

app.post('/api/settings/decants', requireAdmin, async (req, res) => {
  const enabled = !!req.body.enabled;
  await setSetting('decants_enabled', enabled ? '1' : '0');
  broadcast('decants_update', { enabled });
  await logActivity(`Venta de decants ${enabled ? 'activada' : 'desactivada'}`);
  res.json({ ok: true, enabled });
});

app.post('/api/settings/shipping', requireAdmin, async (req, res) => {
  const { cost, threshold, freeMsg, paidMsg } = req.body;
  if (cost      !== undefined) await setSetting('shipping_cost',      parseFloat(cost));
  if (threshold !== undefined) await setSetting('shipping_threshold', parseFloat(threshold));
  if (freeMsg   !== undefined) await setSetting('shipping_free_msg',  freeMsg);
  if (paidMsg   !== undefined) await setSetting('shipping_paid_msg',  paidMsg);
  // Broadcast to ALL clients (store + admin) so cart updates instantly
  broadcast('shipping_update', { cost: parseFloat(cost), threshold: parseFloat(threshold) });
  await logActivity(`Configuración de envío actualizada — $${cost} para pedidos < $${threshold}`);
  res.json({ ok: true });
});
// ── Top sellers — count units sold per product from orders ──

// ─── Bottle Inventory API ─────────────────────────────

// POST /api/bottle-inventory/init — admin: create missing records for all catalogue products
// Run once to populate existing fragrances. Safe to run multiple times (INSERT IGNORE).
app.post('/api/bottle-inventory/init', requireAdmin, async (req, res) => {
  try {
    const catalogue = await getCatalogue();
    let created = 0;
    for (const prod of catalogue) {
      const sizeStr    = String(prod.size || '');
      const sizeMatch  = sizeStr.match(/([\d.]+)\s*ml/i);
      const bottleSize = sizeMatch ? parseFloat(sizeMatch[1]) : 100;
      const [result] = await db.execute(`
        INSERT IGNORE INTO bottle_inventory
          (product_id, ml_total, ml_remaining, ml_reserved, decant_size, sample_size, alert_ml, bottles_count, bottle_size, notes, updated_at)
        VALUES (?, 0, 0, 0, 5, 1.5, ?, 0, ?, '', ?)
      `, [prod.id, Math.max(10, bottleSize * 0.15), bottleSize, new Date()]);
      if (result.affectedRows > 0) created++;
    }
    res.json({ ok: true, created, total: catalogue.length });
  } catch(e) {
    console.error('Bottle inventory init error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bottle-inventory — admin: get all bottle inventory records
app.get('/api/bottle-inventory', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM bottle_inventory ORDER BY product_id');
    const [invRows] = await db.execute('SELECT product_id, stock, out_of_stock FROM inventory');
    const invMap = {};
    invRows.forEach(r => { invMap[r.product_id] = r; });
    const catalogue = await getCatalogue();
    const result = rows
      .filter(r => catalogue.find(p => p.id === r.product_id)) // skip orphaned records
      .map(r => {
        const prod     = catalogue.find(p => p.id === r.product_id);
        const invEntry = invMap[r.product_id] || {};
        const isOos    = parseInt(invEntry.out_of_stock) === 1 || parseInt(invEntry.stock) === 0;
        const decants_remaining = (!isOos && r.decant_size > 0) ? Math.floor(r.ml_remaining / r.decant_size) : 0;
        const samples_remaining = (!isOos && r.sample_size > 0) ? Math.floor(r.ml_remaining / r.sample_size) : 0;
        const low_alert = parseFloat(r.ml_remaining) <= parseFloat(r.alert_ml);
        const empty     = parseFloat(r.ml_remaining) <= 0 || isOos;
        return {
          ...r,
          product_name: `${prod.brand} ${prod.name}`,
          decants_remaining,
          samples_remaining,
          low_alert,
          empty,
          ml_remaining: parseFloat(r.ml_remaining),
          ml_total:     parseFloat(r.ml_total),
          ml_reserved:  parseFloat(r.ml_reserved),
          decant_size:  parseFloat(r.decant_size),
          sample_size:  parseFloat(r.sample_size),
          alert_ml:     parseFloat(r.alert_ml),
          bottle_size:  parseFloat(r.bottle_size),
        };
      });
    res.json(result);
  } catch(e) {
    console.error('Bottle inventory GET error:', e.message);
    res.status(500).json({ error: 'Error al cargar inventario de botellas.' });
  }
});

// DELETE /api/bottle-inventory/orphans — remove records with no matching catalogue product
app.delete('/api/bottle-inventory/orphans', requireAdmin, async (req, res) => {
  try {
    const catalogue = await getCatalogue();
    const validIds  = catalogue.map(p => p.id);
    if (!validIds.length) return res.json({ ok: true, deleted: 0 });
    const placeholders = validIds.map(() => '?').join(',');
    const [result] = await db.execute(
      `DELETE FROM bottle_inventory WHERE product_id NOT IN (${placeholders})`,
      validIds
    );
    await logActivity(`Rastreador: ${result.affectedRows} registro(s) huérfano(s) eliminados`);
    res.json({ ok: true, deleted: result.affectedRows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bottle-inventory — admin: create or update a bottle inventory record
app.post('/api/bottle-inventory', requireAdmin, async (req, res) => {
  const { product_id, decant_size, sample_size, alert_ml, bottle_size, notes } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id requerido' });
  const n = new Date();
  await db.execute(`
    INSERT INTO bottle_inventory (product_id, ml_total, ml_remaining, ml_reserved, decant_size, sample_size, alert_ml, bottles_count, bottle_size, notes, updated_at)
    VALUES (?, 0, 0, 0, ?, ?, ?, 0, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      decant_size  = VALUES(decant_size),
      sample_size  = VALUES(sample_size),
      alert_ml     = VALUES(alert_ml),
      bottle_size  = VALUES(bottle_size),
      notes        = VALUES(notes),
      updated_at   = VALUES(updated_at)
  `, [parseInt(product_id), parseFloat(decant_size)||5, parseFloat(sample_size)||1.5,
      parseFloat(alert_ml)||10, parseFloat(bottle_size)||100, notes||'', n]);
  res.json({ ok: true });
});

// POST /api/bottle-inventory/:id/add — admin: register opening a new bottle
app.post('/api/bottle-inventory/:id/add', requireAdmin, async (req, res) => {
  const pid   = parseInt(req.params.id, 10);
  const { ml } = req.body;
  if (!ml || parseFloat(ml) <= 0) return res.status(400).json({ error: 'ml inválido' });
  const mlNum = parseFloat(ml);
  const n     = new Date();

  // Update bottle ml tracker
  await db.execute(`
    UPDATE bottle_inventory SET
      ml_total      = ml_total + ?,
      ml_remaining  = ml_remaining + ?,
      bottles_count = bottles_count + 1,
      updated_at    = ?
    WHERE product_id = ?
  `, [mlNum, mlNum, n, pid]);

  // Deduct 1 unit from physical inventory (opening a bottle = consuming 1 unit of stock)
  const [invRows] = await db.execute('SELECT stock FROM inventory WHERE product_id=?', [pid]);
  if (invRows.length) {
    const currentStock = parseInt(invRows[0].stock) || 0;
    if (currentStock > 0) {
      const newStock = currentStock - 1;
      const isOos    = newStock === 0;
      const isLow    = newStock <= 5 && !isOos;
      await db.execute(
        `UPDATE inventory SET stock=?, out_of_stock=?, low_stock=?, updated_at=? WHERE product_id=?`,
        [newStock, isOos ? 1 : 0, isLow ? 1 : 0, n, pid]
      );
      invalidateInventory(); // clear cache so getInventoryMap returns fresh data
      broadcast('inventory', await getInventoryMap());
    }
    // else stock already 0 — bottle was already exhausted, just record the ml
  } else {
    // No inventory row — admin hasn't set stock for this product yet.
    // Create a starter row with stock=0, but DON'T mark out_of_stock=1
    // since that would hide the product from the bottle tracker.
    // After this, admin should set the correct stock in the Inventory tab.
    await db.execute(
      `INSERT IGNORE INTO inventory (product_id, stock, low_stock, out_of_stock, updated_at)
       VALUES (?, 0, 0, 0, ?)`,
      [pid, n]
    );
    invalidateInventory();
    broadcast('inventory', await getInventoryMap());
    console.log(`Created missing inventory row for product ${pid} with stock=0 — admin should update via Inventory tab`);
  }

  const catalogue = await getCatalogue();
  const prod = catalogue.find(p => p.id === pid);
  await logActivity(`Botella abierta: ${prod ? prod.brand+' '+prod.name : 'ID '+pid} (+${mlNum}ml, -1 unidad inventario)`);
  res.json({ ok: true });
});

// PATCH /api/bottle-inventory/:id — admin: manual ml adjustment
app.patch('/api/bottle-inventory/:id', requireAdmin, async (req, res) => {
  const pid = parseInt(req.params.id, 10);
  const { ml_remaining, ml_reserved, decant_size, sample_size, alert_ml, notes } = req.body;
  const fields = [], vals = [];
  if (ml_remaining !== undefined) { fields.push('ml_remaining=?'); vals.push(parseFloat(ml_remaining)); }
  if (ml_reserved  !== undefined) { fields.push('ml_reserved=?');  vals.push(parseFloat(ml_reserved)); }
  if (decant_size  !== undefined) { fields.push('decant_size=?');  vals.push(parseFloat(decant_size)); }
  if (sample_size  !== undefined) { fields.push('sample_size=?');  vals.push(parseFloat(sample_size)); }
  if (alert_ml     !== undefined) { fields.push('alert_ml=?');     vals.push(parseFloat(alert_ml)); }
  if (notes        !== undefined) { fields.push('notes=?');         vals.push(notes); }
  if (!fields.length) return res.json({ ok: true });
  fields.push('updated_at=?'); vals.push(new Date()); vals.push(pid);
  await db.execute(`UPDATE bottle_inventory SET ${fields.join(',')} WHERE product_id=?`, vals);
  res.json({ ok: true });
});

// ─── Analytics Dashboard ──────────────────────────────
app.get('/api/analytics', requireAdmin, async (req, res) => {
  try {
    const today     = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const day7      = new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10);
    const day30     = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    // Optional custom range from query params
    const rangeFrom = req.query.from || day30;
    const rangeTo   = req.query.to   || today;

    const catalogue = await getCatalogue();

    // ── Revenue ────────────────────────────────────────
    const [revRows] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN DATE(created_at)=? THEN total ELSE 0 END),0)            AS today,
        COALESCE(SUM(CASE WHEN DATE(created_at)=? THEN total ELSE 0 END),0)            AS yesterday,
        COALESCE(SUM(CASE WHEN created_at>=? THEN total ELSE 0 END),0)                 AS day7,
        COALESCE(SUM(CASE WHEN created_at>=? THEN total ELSE 0 END),0)                 AS day30,
        COALESCE(SUM(CASE WHEN DATE(created_at) BETWEEN ? AND ? THEN total ELSE 0 END),0) AS rangeTotal,
        COALESCE(SUM(total),0)                                                          AS allTime,
        COUNT(*)                                                                         AS totalOrders,
        COUNT(CASE WHEN DATE(created_at)=? THEN 1 END)                                 AS ordersToday,
        COUNT(CASE WHEN created_at>=? THEN 1 END)                                      AS orders7,
        COUNT(CASE WHEN DATE(created_at) BETWEEN ? AND ? THEN 1 END)                   AS ordersRange,
        COUNT(CASE WHEN payment_status='Pendiente' THEN 1 END)                         AS pending,
        COUNT(CASE WHEN payment_status='Pagado' THEN 1 END)                            AS paid,
        AVG(CASE WHEN DATE(created_at) BETWEEN ? AND ? THEN total END)                 AS avgOrderValue
      FROM orders
      WHERE payment_status='Pagado' OR (payment_method='cod' AND status='Entregado')
    `, [today, yesterday, day7, day30, rangeFrom, rangeTo, today, day7, rangeFrom, rangeTo, rangeFrom, rangeTo]);

    // ── Revenue by day (last 14 days) ─────────────────
    const [dailyRev] = await db.query(`
      SELECT DATE(created_at) as date, COALESCE(SUM(total),0) as revenue, COUNT(*) as orders
      FROM orders
      WHERE DATE(created_at) BETWEEN ? AND ?
        AND (payment_status='Pagado' OR (payment_method='cod' AND status='Entregado'))
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [rangeFrom, rangeTo]);

    // ── Top products ───────────────────────────────────
    const [orderRows] = await db.query("SELECT items FROM orders WHERE (payment_status='Pagado' OR (payment_method='cod' AND status='Entregado')) AND DATE(created_at) BETWEEN ? AND ?", [rangeFrom, rangeTo]);
    const productSales = {};
    orderRows.forEach(r => {
      try {
        JSON.parse(r.items || '[]').forEach(item => {
          const pid = parseInt(item.productId);
          if (!pid) return;
          if (!productSales[pid]) productSales[pid] = { units: 0, revenue: 0 };
          productSales[pid].units   += parseInt(item.qty) || 1;
          productSales[pid].revenue += parseFloat(item.unitPrice || item.price || 0) * (parseInt(item.qty) || 1);
        });
      } catch(e) {}
    });
    const topProducts = Object.entries(productSales)
      .map(([pid, s]) => {
        const p = catalogue.find(x => x.id === parseInt(pid));
        return { id: parseInt(pid), name: p ? `${p.brand} ${p.name}` : `ID ${pid}`,
                 units: s.units, revenue: s.revenue };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    // ── Top brands ─────────────────────────────────────
    const brandSales = {};
    orderRows.forEach(r => {
      try {
        JSON.parse(r.items || '[]').forEach(item => {
          const p = catalogue.find(x => x.id === parseInt(item.productId));
          if (!p) return;
          if (!brandSales[p.brand]) brandSales[p.brand] = { units: 0, revenue: 0 };
          brandSales[p.brand].units   += parseInt(item.qty) || 1;
          brandSales[p.brand].revenue += parseFloat(item.unitPrice || item.price || 0) * (parseInt(item.qty) || 1);
        });
      } catch(e) {}
    });
    const topBrands = Object.entries(brandSales)
      .map(([brand, s]) => ({ brand, ...s }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6);

    // ── Customers ──────────────────────────────────────
    const [custRows] = await db.query(`
      SELECT
        COUNT(*)                                                                         AS total,
        COUNT(CASE WHEN DATE(created_at) BETWEEN ? AND ? THEN 1 END)                    AS rangeNew,
        COUNT(CASE WHEN created_at>=? THEN 1 END)                                       AS week,
        COUNT(CASE WHEN created_at>=? THEN 1 END)                                       AS month,
        COUNT(CASE WHEN last_login BETWEEN ? AND ? THEN 1 END)                          AS activeRange
      FROM customers
    `, [rangeFrom, rangeTo, day7, day30, rangeFrom, rangeTo]);

    // ── Nez / Sommelier ──────────────────────────────
    const [nezRows] = await db.query(`
      SELECT
        COUNT(*)                                                                         AS totalProfiles,
        COUNT(CASE WHEN customer_id IS NOT NULL THEN 1 END)                              AS registered,
        COUNT(CASE WHEN customer_id IS NULL THEN 1 END)                                  AS anonymous,
        COUNT(CASE WHEN DATE(created_at) BETWEEN ? AND ? THEN 1 END)                    AS rangeNew
      FROM scent_profiles
    `, [rangeFrom, rangeTo]);

    const [consultRows] = await db.query(`
      SELECT
        COUNT(*)                                                        AS totalSessions,
        SUM(count)                                                      AS totalConsults,
        COUNT(CASE WHEN customer_id IS NOT NULL THEN 1 END)            AS registeredSessions
      FROM consult_counts
      WHERE last_reset BETWEEN ? AND ?
    `, [rangeFrom, rangeTo]);

    // ── Payment methods breakdown ──────────────────────
    const [pmRows] = await db.query(`
      SELECT payment_method, COUNT(*) as cnt, SUM(total) as rev
      FROM orders GROUP BY payment_method
    `);

    res.json({
      range:      { from: rangeFrom, to: rangeTo },
      revenue:    revRows[0],
      dailyRev:   dailyRev.map(r => ({ date: r.date?.toISOString?.()?.slice(0,10) || r.date, revenue: parseFloat(r.revenue), orders: r.orders })),
      topProducts,
      topBrands,
      customers:  custRows[0],
      nez:      { ...nezRows[0], ...consultRows[0] },
      paymentMethods: pmRows.map(r => ({ method: r.payment_method, count: r.cnt, revenue: parseFloat(r.rev||0) }))
    });
  } catch(e) {
    console.error('Analytics error:', e.message);
    res.status(500).json({ error: 'Error al cargar analytics.' });
  }
});

// GET /api/catalogue/brand-ranking — public, returns brand names in prestige hierarchy order
// Order follows luxury brand tier: heritage houses first, then niche, then accessible luxury.
// Brands not in the hierarchy appear at the end alphabetically.
app.get('/api/catalogue/brand-ranking', async (req, res) => {
  try {
    const catalogue = await getCatalogue();
    const allBrands = [...new Set(catalogue.map(p => p.brand).filter(Boolean))];

    // Prestige hierarchy — edit this list to control brand order in Collections
    const HIERARCHY = [
      'Creed', 'Tom Ford', 'Maison Francis Kurkdjian', 'Le Labo',
      'Chanel', 'Dior', 'Hermès', 'Hermes', 'Givenchy', 'Gucci', 'Burberry',
      'Parfums de Marly', 'Maison Margiela', 'Jo Malone',
      'Giorgio Armani', 'Yves Saint Laurent', 'Jean Paul Gaultier',
      'Versace', 'Lancôme', 'Paco Rabanne',
      'Armaf', 'Montblanc', 'Davidoff',
    ];

    const ranked = [
      ...HIERARCHY.filter(b => allBrands.includes(b)),
      ...allBrands.filter(b => !HIERARCHY.includes(b)).sort()
    ].map(b => ({ brand: b }));

    res.json(ranked);
  } catch(e) {
    console.error('Brand ranking error:', e.message);
    res.json([]);
  }
});

app.get('/api/catalogue/top-sellers', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT items FROM orders ORDER BY created_at DESC');
    const counts = {};
    rows.forEach(r => {
      try {
        const items = JSON.parse(r.items);
        items.forEach(item => {
          const pid = parseInt(item.productId, 10);
          if (pid) counts[pid] = (counts[pid] || 0) + (parseInt(item.qty, 10) || 1);
        });
      } catch(e) {}
    });
    // Sort by units sold descending
    const sorted = Object.entries(counts)
      .map(([pid, units]) => ({ productId: parseInt(pid), units }))
      .sort((a, b) => b.units - a.units);
    res.json(sorted);
  } catch(e) {
    console.error('Top sellers error:', e.message);
    res.json([]);
  }
});

// Public, PII-free version for the storefront "Los Más Vendidos" collection.
// Returns only [{ productId, units }] (top 20) — no customer/order data.
app.get('/api/storefront/top-sellers', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT items FROM orders WHERE payment_status = 'Pagado' ORDER BY created_at DESC LIMIT 2000");
    const counts = {};
    rows.forEach(r => {
      try {
        JSON.parse(r.items).forEach(item => {
          const pid = parseInt(item.productId, 10);
          if (pid) counts[pid] = (counts[pid] || 0) + (parseInt(item.qty, 10) || 1);
        });
      } catch(e) {}
    });
    const sorted = Object.entries(counts)
      .map(([pid, units]) => ({ productId: parseInt(pid), units }))
      .sort((a, b) => b.units - a.units)
      .slice(0, 20);
    res.json(sorted);
  } catch(e) {
    res.json([]);
  }
});
// ─── Start ────────────────────────────────────────────
// Prevent DB errors from crashing the server
// ── Global Express error handler — NEVER expose internals to client ──────────
// This catches any error passed to next(err) or unhandled async throws
// ═══════════════════════════════════════════════════════
//  EMAIL FOLLOWUP CRON — runs daily, sends 14-day post-delivery emails
// ═══════════════════════════════════════════════════════
async function runFollowupCron() {
  try {
    const now = new Date();
    // Find orders due for followup: scheduled_at <= now, not yet sent, customer registered
    const [orders] = await db.execute(`
      SELECT o.*, c.email, c.name as customer_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      JOIN email_preferences ep ON ep.customer_id = c.id
      WHERE o.followup_scheduled_at IS NOT NULL
        AND o.followup_scheduled_at <= ?
        AND o.followup_sent_at IS NULL
        AND ep.followup = 1
    `, [now]);

    for (const order of orders) {
      try {
        order.customer = order.customer_name;
        order.items = JSON.parse(order.items || '[]');
        const content = await buildFollowupEmail(order);
        if (!content) continue;

        const unsubFooter = await buildUnsubscribeFooter(order.customer_id).catch(() => '');
        const BASE = process.env.BASE_URL || 'https://sillage-sv.com';

        const html = emailTemplate(
          `<h2 style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#1a1714;margin:0 0 16px">Hola ${escHtml(order.customer)} 👋</h2>` +
          `<div style="border-left:3px solid #b8955a;padding:12px 16px;margin:0 0 20px;background:#faf8f4">` +
            `<p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8955a;margin:0 0 8px">Nez te escribe</p>` +
            `<p style="font-family:Georgia,serif;font-size:14px;color:#4a3f35;line-height:1.9;margin:0;font-style:italic">${escHtml(content).replace(/\n/g,'<br/>')}</p>` +
          `</div>` +
          `<div style="text-align:center;margin-top:24px">` +
            `<a href="${BASE}" style="display:inline-block;padding:12px 28px;border:1px solid #b8955a;color:#b8955a;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none">Ver Catálogo</a>` +
          `</div>` +
          unsubFooter
        );

        await sendEmail({
          to: order.email,
          subject: `Una recomendación de Nez — Sillage Parfumerie`,
          from: `Nez · Sillage <${EMAIL_PEDIDOS}>`,
          html
        });

        await db.execute('UPDATE orders SET followup_sent_at=? WHERE id=?', [now, order.id]);
        await logActivity(`Followup email enviado a ${order.customer_name} (pedido ${order.id})`);
      } catch(e) {
        console.warn(`Followup failed for order ${order.id}:`, e.message);
      }
    }
    if (orders.length) console.log(`✅ Followup cron: ${orders.length} email(s) sent`);
  } catch(e) {
    console.warn('Followup cron error:', e.message);
  }
}
// Run once at startup (catches any missed), then every 6 hours
setTimeout(runFollowupCron, 30000);
setInterval(runFollowupCron, 6 * 60 * 60 * 1000);

// ── Unsubscribe / Email preferences page ─────────────────
app.get('/preferencias-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/');
  const [rows] = await db.execute(
    'SELECT ep.*, c.name FROM email_preferences ep JOIN customers c ON ep.customer_id=c.id WHERE ep.unsubscribe_token=?',
    [token]
  ).catch(() => [[]]);
  if (!rows.length) return res.redirect('/');
  const prefs = rows[0];
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Preferencias de Email — Sillage</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;1,300&family=Jost:wght@300;400&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0e0c0a;color:#e8dcc8;font-family:'Jost',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem}
.card{background:#1a1714;border:1px solid rgba(184,149,90,0.2);border-top:2px solid rgba(184,149,90,0.5);padding:2.5rem;max-width:420px;width:100%}
.brand{font-family:'Cormorant Garamond',serif;font-size:1.4rem;font-weight:300;letter-spacing:0.1em;color:#b8955a;margin-bottom:0.3rem}
h1{font-family:'Cormorant Garamond',serif;font-size:1.1rem;font-weight:300;color:#e8dcc8;margin-bottom:0.5rem}
p{font-size:0.72rem;color:#8a7f72;line-height:1.8;margin-bottom:1.5rem}
.pref-row{display:flex;justify-content:space-between;align-items:center;padding:0.9rem 0;border-bottom:1px solid rgba(184,149,90,0.1)}
.pref-row:last-of-type{border-bottom:none}
.pref-label{font-size:0.72rem;color:#e8dcc8}
.pref-sub{font-size:0.6rem;color:#8a7f72;margin-top:0.15rem}
.tog-wrap{position:relative;display:inline-block;width:36px;height:20px}
.tog-wrap input{opacity:0;width:0;height:0}
.tog-track{position:absolute;cursor:pointer;inset:0;background:rgba(255,255,255,0.08);border:1px solid rgba(184,149,90,0.2);transition:.3s}
.tog-wrap input:checked + .tog-track{background:rgba(184,149,90,0.3);border-color:rgba(184,149,90,0.5)}
.tog-thumb{position:absolute;height:14px;width:14px;left:3px;bottom:3px;background:#8a7f72;transition:.3s;pointer-events:none}
.tog-wrap input:checked ~ .tog-thumb{transform:translateX(16px);background:#b8955a}
.save-btn{width:100%;margin-top:1.5rem;background:transparent;border:1px solid rgba(184,149,90,0.4);color:rgba(184,149,90,0.8);font-family:'Jost',sans-serif;font-size:0.62rem;letter-spacing:0.2em;text-transform:uppercase;padding:0.75rem;cursor:pointer;transition:all 0.3s}
.save-btn:hover{background:rgba(184,149,90,0.08);border-color:rgba(184,149,90,0.7);color:#e8dcc8}
.msg{display:none;font-size:0.65rem;color:#5a9a6a;text-align:center;margin-top:0.8rem;letter-spacing:0.1em}
</style>
</head>
<body>
<div class="card">
  <div class="brand">SILLAGE</div>
  <h1>Preferencias de Email</h1>
  <p>Hola ${escHtml(prefs.name)} — gestiona qué emails deseas recibir. Las confirmaciones de pedido siempre se envían.</p>
  <form id="prefForm">
    <div class="pref-row">
      <div><div class="pref-label">Emails de marketing</div><div class="pref-sub">Nuevas llegadas, ofertas y novedades</div></div>
      <label class="tog-wrap"><input type="checkbox" id="mktg" ${prefs.marketing ? 'checked' : ''}/><span class="tog-track"></span><span class="tog-thumb"></span></label>
    </div>
    <div class="pref-row">
      <div><div class="pref-label">Emails de seguimiento</div><div class="pref-sub">Recomendaciones personalizadas de Nez</div></div>
      <label class="tog-wrap"><input type="checkbox" id="flwp" ${prefs.followup ? 'checked' : ''}/><span class="tog-track"></span><span class="tog-thumb"></span></label>
    </div>
    <button type="button" class="save-btn" onclick="save()">Guardar preferencias</button>
    <div class="msg" id="msg">✓ PREFERENCIAS GUARDADAS</div>
  </form>
</div>
<script>
function save(){
  fetch('/api/email-preferences',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:'${token}',marketing:document.getElementById('mktg').checked,followup:document.getElementById('flwp').checked})
  }).then(function(r){return r.json();}).then(function(){
    var m=document.getElementById('msg');m.style.display='block';setTimeout(function(){m.style.display='none';},3000);
  }).catch(function(){alert('Error al guardar. Intenta de nuevo.');});
}
</script>
</body>
</html>`);
});

app.post('/api/email-preferences', async (req, res) => {
  const { token, marketing, followup } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  try {
    await db.execute(
      'UPDATE email_preferences SET marketing=?, followup=?, updated_at=? WHERE unsubscribe_token=?',
      [marketing ? 1 : 0, followup ? 1 : 0, new Date(), token]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Error al guardar preferencias' });
  }
});

// Create email preferences when customer registers
async function initEmailPreferencesForCustomer(customerId) {
  await ensureEmailPreferences(customerId).catch(() => {});
}

app.use(function(err, req, res, next) {
  // Always log the full error internally
  const stackLine = err.stack ? err.stack.split(String.fromCharCode(10))[1] || '' : '';
  console.error('Unhandled route error:', err.message, stackLine);
  // Never send stack traces, table names, or internal messages to the client
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Ocurrió un error interno. Por favor intenta de nuevo.' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled Rejection:', reason?.message || reason);
  console.error('⚠️  Rejection Stack:', reason?.stack || '(no stack)');
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception:', err.message);
});

async function start() {
  // Listen FIRST so Railway health check passes immediately
  await new Promise(resolve => server.listen(PORT, () => {
    console.log('\u2705 Server listening on port ' + PORT);
    resolve();
  }));

  try {
    // Warm up DB connection pool before accepting traffic
    // Prevents cold-start 503s on first user request
    await db.execute('SELECT 1');
    console.log('✅ DB connection established');
    await initDB();
    await migrateOrders();
    await migrateConsultCounts();
    await migrateCustomers();
    await seedData();
    await restoreLoginAttempts();
    await auth.restoreRevocations();
    await fixCorruptedInventoryRows();
    await migrateInventoryRows();
    console.log('\u2705 SILLAGE PARFUMERIE v3.1 - Server Ready | ' + BASE_URL);
  } catch(err) {
    console.error('\u274C DB startup failed:', err.message);
    process.exit(1);
  }
}
start();
