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

// ─── Internal modules ─────────────────────────────────
const cfg          = require('./config');
const db           = require('./services/db');
const catalogueSvc = require('./services/catalogue');
const emailSvc     = require('./services/email');
const { Cache }    = require('./services/cache');
const security     = require('./middleware/security');
const auth         = require('./middleware/auth');

// ─── Aliases for backwards compatibility within this file ──────────────────
const { getCatalogue, saveCatalogue, getInventoryMap, getPricingMap, getActivity, getSetting, setSetting, getBrandHierarchy } = catalogueSvc;

// logActivity also broadcasts to admin WebSocket clients
async function logActivity(msg) {
  await catalogueSvc.logActivity(msg);
  if (typeof broadcastAdmin === 'function') {
    broadcastAdmin('activity', { msg, time: new Date().toLocaleTimeString() });
  }
}
const { requireAdmin, requireCustomer, optionalCustomer, createSession, validateSession, destroySession } = auth;
const { authLimiter, getIp } = security;
const { ADMIN_USER, ADMIN_PASS, PORT, BASE_URL, OPENAI_API_KEY, WOMPI_CLIENT_ID, WOMPI_CLIENT_SECRET, EMAIL_HOLA, EMAIL_PEDIDOS, SESSION_TTL_CUSTOMER, SESSION_TTL_ADMIN, RESEND_API_KEY, NODE_ENV, IS_PROD, ANON_SESSION_TTL, ANON_WS_LIMIT, ANON_SOMMELIER_MAX, REG_SOMMELIER_LIMIT, ANON_SOMMELIER_LIMIT, CACHE_TTL_TOOL, CACHE_TTL_REPLY } = cfg;

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
    CREATE TABLE IF NOT EXISTS settings (
      key_name   VARCHAR(100) PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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

  console.log('✅ Tables ready');
}

// ─── Seed default data ────────────────────────────────
async function migrateOrders() {
  const cols = [
    "phone          VARCHAR(50)  DEFAULT NULL",
    "city           VARCHAR(100) DEFAULT NULL",
    "state_province VARCHAR(100) DEFAULT NULL",
    "country        VARCHAR(100) DEFAULT NULL",
    "payment_method VARCHAR(50)  DEFAULT 'wompi'",
    "tracking_number VARCHAR(200) DEFAULT NULL"
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

async function sendEmail({ to, subject, html, from }) {
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
        html
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('❌ Resend error:', data);
    else console.log('✅ Email sent to', to, '— id:', data.id);
  } catch(e) {
    console.error('❌ Resend fetch error:', e.message);
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

async function sendOrderConfirmation(order) {
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
    ${nezBlock}
    <p style="font-size:12px;color:#8a7f72;line-height:1.8;margin-top:16px">Enviando a: ${escHtml(order.address)}</p>`);

  await sendEmail({
    to: order.email,
    subject: `✨ Pedido Confirmado — ${escHtml(order.id)} | Sillage Parfumerie`,
    from: `Sillage Pedidos <${EMAIL_PEDIDOS}>`,
    html
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
  const html = emailTemplate(`
    <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:300;color:#1a1714;margin:0 0 8px">¡Tu pedido fue entregado! ✨</h2>
    <p style="font-size:13px;color:#8a7f72;margin:0 0 24px">Hola <strong style="color:#1a1714">${escHtml(order.customer)}</strong>, tu fragancia ha llegado a su destino. ¡Esperamos que la disfrutes!</p>
    <div style="background:#faf8f4;border:1px solid #e8d8b8;padding:12px 16px;margin-bottom:24px">
      <span style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8a7f72">Número de Pedido</span><br/>
      <span style="font-family:Georgia,serif;font-size:18px;color:#b8955a">${escHtml(order.id)}</span>
    </div>
    <p style="font-size:12px;color:#8a7f72;line-height:1.8;margin-bottom:16px">Si tienes algún problema con tu pedido, puedes contactarnos dentro de los <strong style="color:#1a1714">8 días hábiles</strong> siguientes a la entrega para gestionar una devolución o cambio.</p>
    <div style="text-align:center;margin-top:24px">
      <a href="https://sillage-sv.com/devoluciones" style="display:inline-block;padding:12px 28px;border:1px solid #b8955a;color:#b8955a;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none">Política de Devoluciones</a>
    </div>`);
  await sendEmail({
    to: order.email,
    subject: `✨ Pedido ${escHtml(order.id)} entregado — Sillage Parfumerie`,
    from: `Sillage Pedidos <${EMAIL_PEDIDOS}>`,
    html
  });
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
    const fwd = req.headers['x-forwarded-for'];
    const ip  = fwd ? fwd.split(',').map(s => s.trim()).pop() : req.socket.remoteAddress;
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
async function restoreLoginAttempts() {
  try {
    const [rows] = await db.execute(
      "SELECT key_name, value, updated_at FROM settings WHERE key_name LIKE 'auth_fail:%'"
    );
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const row of rows) {
      const updated = new Date(row.updated_at).getTime();
      if (updated > cutoff) {
        const ip = row.key_name.replace('auth_fail:', '');
        loginAttempts.set(ip, { count: parseInt(row.value) || 1, firstAttempt: updated });
      } else {
        // Expired — clean up
        await db.execute('DELETE FROM settings WHERE key_name=?', [row.key_name]).catch(() => {});
      }
    }
    if (rows.length) console.log(`✅ Restored ${rows.length} login attempt record(s) from DB`);
  } catch(e) { console.warn('Could not restore login attempts:', e.message); }
}
function checkRateLimit(ip) {
  const e = loginAttempts.get(ip);
  if (!e) return true;
  if (Date.now() - e.firstAttempt > 15 * 60 * 1000) { loginAttempts.delete(ip); return true; }
  return e.count < 5;
}
function recordFailed(ip) {
  const e = loginAttempts.get(ip) || { count: 0, firstAttempt: Date.now() };
  e.count++; loginAttempts.set(ip, e);
}
function clearAttempts(ip) { loginAttempts.delete(ip); }

// ─── Auth middleware ──────────────────────────────────
// requireAdmin → middleware/auth.js
// requireCustomer → middleware/auth.js

// ─── Middleware stack ────────────────────────────────────────────────────────
app.use(security.httpsRedirect);
app.use(security.cors);
app.use(compression({ level: 6, threshold: 1024 }));  // gzip all responses > 1KB
app.use(express.json({ limit: security.bodyLimit }));
app.use(security.securityHeaders);
app.use(security.rateLimit());                         // global rate limit
app.use(express.static(__dirname, {
  maxAge: '1d',        // cache static assets for 1 day
  etag:   true,
  lastModified: true,
}));
app.get('/', (req, res) => {
  const fs = require('fs');
  const index = path.join(__dirname, 'index.html');
  const store  = path.join(__dirname, 'claud-perfumes-server.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  if (fs.existsSync(store)) return res.sendFile(store);
  res.send('<h2>Store file not found.</h2>');
});

app.get('/nosotros',    (req, res) => res.sendFile(path.join(__dirname, 'nosotros.html')));
app.get('/envios', (req, res) => res.sendFile(path.join(__dirname, 'envios.html')));
app.get('/terminos', (req, res) => res.sendFile(path.join(__dirname, 'terminos.html')));
app.get('/devoluciones', (req, res) => res.sendFile(path.join(__dirname, 'devoluciones.html')));
app.get('/privacidad', (req, res) => {
  const fs = require('fs');
  const file = path.join(__dirname, 'privacidad.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.redirect('/');
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
    ok = !!(username && ADMIN_USER && password && ADMIN_PASS &&
      crypto.timingSafeEqual(Buffer.from(username.padEnd(100)), Buffer.from(ADMIN_USER.padEnd(100))) &&
      crypto.timingSafeEqual(Buffer.from(password.padEnd(100)), Buffer.from(ADMIN_PASS.padEnd(100))));
  } catch(e) {}

  if (!ok) {
    recordFailed(ip);
    trackAbuse('login_burst', ip);
    // Persist failed attempt to DB so it survives server restarts/redeploys
    await db.execute(
      `INSERT INTO settings (key_name, value, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
      [`auth_fail:${ip}`, loginAttempts.get(ip)?.count || 1, new Date()]
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
app.post('/api/customer/register', authLimiter, async (req, res) => {
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

app.post('/api/customer/login', authLimiter, async (req, res) => {
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

// ═══════════════════════════════════════════════════════
//  PUBLIC STORE ROUTES
// ═══════════════════════════════════════════════════════
app.get('/api/health',    (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/api/inventory', async (req, res) => res.json(await getInventoryMap()));
app.get('/api/pricing',   async (req, res) => res.json(await getPricingMap()));
// GET /api/session/init — issues a server-signed anonymous session ID
// Frontend must call this first; sessions not issued by the server are rejected
// Rate limited: max 10 new sessions per IP per hour to prevent session farming
const _sessionInitTracker = new Map();
const SESSION_INIT_MAX    = 10;
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

  const now    = Date.now();
  const record = _sessionInitTracker.get(ip) || { count: 0, start: now };
  if (now - record.start > SESSION_INIT_WINDOW) { record.count = 0; record.start = now; }
  record.count++;
  _sessionInitTracker.set(ip, record);

  if (record.count > SESSION_INIT_MAX) {
    trackAbuse('bot_farm', ip, { detail: `${record.count} new sessions requested` });
    return res.status(429).json({ error: 'Too many session requests. Try again later.' });
  }

  // Track every new session issuance (not reuse) for bot farm detection
  trackAbuse('bot_farm', ip);
  const sessionId = issueAnonSession();
  res.json({ sessionId });
});

// Prune session init tracker every hour
setInterval(() => {
  const cutoff = Date.now() - SESSION_INIT_WINDOW;
  for (const [ip, rec] of _sessionInitTracker.entries())
    if (rec.start < cutoff) _sessionInitTracker.delete(ip);
}, 60 * 60 * 1000);

app.get('/api/catalogue', async (req, res) => res.json(await getCatalogue()));

// ── Helper: deduct inventory and broadcast ────────────
async function deductInventory(items) {
  const n = new Date();
  for (const item of items) {
    await db.execute(
      `UPDATE inventory SET
        stock        = GREATEST(0, stock - ?),
        low_stock    = CASE WHEN GREATEST(0, stock - ?) <= 5 AND GREATEST(0, stock - ?) > 0 THEN 1 ELSE low_stock END,
        out_of_stock = CASE WHEN GREATEST(0, stock - ?) = 0 THEN 1 ELSE 0 END,
        updated_at   = ? WHERE product_id = ?`,
      [parseInt(item.qty), parseInt(item.qty), parseInt(item.qty), parseInt(item.qty), n, parseInt(item.productId)]
    );
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
  try {
    const catalogue  = await getCatalogue();
    const invMap     = await getInventoryMap();
    const priceMap   = await getPricingMap();
    let   serverTotal = 0;
    for (const item of rawItems) {
      const pid  = parseInt(item.productId, 10);
      const qty  = parseInt(item.qty, 10) || 1;
      const type = (item.type || 'full').toLowerCase(); // 'full' | 'decant' | 'bottle' | 'sample'
      const prod = catalogue.find(p => p.id === pid);
      if (!prod) return res.status(400).json({ error: `Producto no encontrado: ${pid}` });
      if (invMap[pid]?.outOfStock) return res.status(400).json({ error: `Producto agotado: ${prod.brand} ${prod.name}` });
      const pr           = priceMap[pid] || {};
      const fullPrice    = (pr.onSale && pr.salePrice) ? parseFloat(pr.salePrice) : parseFloat(prod.price);

      let unitPrice;
      if (type === 'decant' || type === 'sample') {
        // Determine valid decant prices based on size
        const sizeStr = String(item.size || '');
        const is5ml   = sizeStr.includes('5ml') || sizeStr === '5';
        // 10ml price: catalogue decantPrice or 30% of full
        const price10 = prod.decantPrice ? parseFloat(prod.decantPrice) : Math.round(fullPrice * 0.30);
        // 5ml price: catalogue decantPrice5 or ~55% of 10ml price (mirrors frontend)
        const price5  = prod.decantPrice5 ? parseFloat(prod.decantPrice5) : Math.round(price10 * 0.55);
        const catalogDecantPrice = is5ml ? price5 : price10;
        // Accept client unitPrice if within ±$1 tolerance (slightly wider for rounding)
        const clientUnitPrice = parseFloat(item.unitPrice || 0);
        if (clientUnitPrice > 0 && Math.abs(clientUnitPrice - catalogDecantPrice) <= 1.00) {
          unitPrice = clientUnitPrice;
        } else {
          unitPrice = catalogDecantPrice;
        }
      } else {
        // Full bottle or bundle split — use full catalogue price
        unitPrice = parseFloat(item.unitPrice || fullPrice);
        // Clamp: client price must not be lower than 50% of catalogue price (bundle splits are ok)
        if (unitPrice < fullPrice * 0.10) unitPrice = fullPrice;
      }

      serverTotal += unitPrice * qty;
    }
    // Fetch shipping cost from settings
    const shippingCost      = parseFloat(await getSetting('shipping_cost', '5')) || 5;
    const shippingThreshold = parseFloat(await getSetting('shipping_threshold', '50')) || 50;
    if (serverTotal < shippingThreshold) serverTotal += shippingCost;
    serverTotal = Math.round(serverTotal * 100) / 100;

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
    trackerStep:   1
  };

  await db.execute(
    `INSERT INTO orders (id,customer,email,phone,address,city,state_province,country,items,total,status,payment_status,payment_method,tracker_step,customer_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [order.id, order.customer, order.email, order.phone, order.address,
     order.city, order.state, order.country,
     JSON.stringify(order.items), order.total,
     order.status, order.paymentStatus, order.paymentMethod,
     parseInt(order.trackerStep), customerId ? parseInt(customerId) : null, n, n]
  );

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

  broadcastAdmin('new_order', order);
  await logActivity(`Nuevo pedido ${escHtml(order.id)} de ${escHtml(order.customer)} — $${parseFloat(order.total||0).toFixed(2)}`);
  try { await sendOrderConfirmation(order); } catch(e) {}

  // Wompi: create payment link and return URL
  let wompiUrl = null;
  if (paymentMethod === 'wompi' && WOMPI_CLIENT_ID) {
    wompiUrl = await createWompiLink(order);
  }

  res.json({ ok: true, order, wompiUrl });
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

  broadcast('inventory', await getInventoryMap());
  await logActivity('Inventario actualizado');
  res.json({ ok: true });
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

app.patch('/api/orders/:id', requireAdmin, async (req, res) => {
  const { status, trackerStep, trackingNumber } = req.body;
  const [existing] = await db.execute('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: 'Pedido no encontrado' });
  const prevStatus = existing[0].status;
  await db.execute(
    `UPDATE orders SET
      status          = COALESCE(?,status),
      tracker_step    = COALESCE(?,tracker_step),
      tracking_number = COALESCE(?,tracking_number),
      updated_at      = ?
     WHERE id=?`,
    [status || null, trackerStep ?? null, trackingNumber || null, new Date(), req.params.id]
  );
  const [updated] = await db.execute('SELECT * FROM orders WHERE id=?', [req.params.id]);
  const order = {
    ...updated[0],
    items:   JSON.parse(updated[0].items || '[]'),
    address: updated[0].address,
    tracking_number: updated[0].tracking_number
  };
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

    // Chivo → Procesando: admin manually verified Chivo QR payment, deduct ml
    if (isChivo && status === 'Procesando') {
      await deductBottleInventory(order.items);
      // Also mark as paid
      await db.execute('UPDATE orders SET payment_status=?, updated_at=? WHERE id=?', ['Pagado', new Date(), req.params.id]);
      order.payment_status = 'Pagado';
      broadcastAdmin('order_update', { id: order.id, status: order.status, paymentStatus: 'Pagado', trackerStep: order.tracker_step });
      await logActivity(`Pago Chivo confirmado para pedido ${escHtml(order.id)}`);
    }

    // COD → Entregado: mark as Pagado (payment collected on delivery)
    if (isCOD && status === 'Entregado') {
      await db.execute('UPDATE orders SET payment_status=?, updated_at=? WHERE id=?', ['Pagado', new Date(), req.params.id]);
      order.payment_status = 'Pagado';
      broadcastAdmin('order_update', { id: order.id, status: order.status, paymentStatus: 'Pagado', trackerStep: order.tracker_step });
      await logActivity(`Pago COD confirmado para pedido ${escHtml(order.id)}`);
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
  const bfScore = parseInt(req.body._h) || 0;
  if (!isRegistered && bfScore < 10) {
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
            return res.status(403).json({ error: 'consult_limit' });
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

  // ── Load and merge up to 7 saved profiles for registered customers ──────
  let profileContext = '';
  let mergedProfile = null;
  if (isRegistered) {
    try {
      const customerId2 = customerSession.user.id;
      const [profileRows] = await db.execute(
        'SELECT profile FROM scent_profiles WHERE customer_id=? ORDER BY created_at DESC LIMIT 7',
        [customerId2]
      );
      if (profileRows.length) {
        // Merge profiles: frequency-weighted aggregation
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
          profileContext = '\n\nPERFIL CONSOLIDADO DEL CLIENTE (basado en ' + total + ' sesión' + (total > 1 ? 'es' : '') + ' previas): ' + parts.join(' | ') + '. Úsalo para orientar tus recomendaciones naturalmente, sin mencionarlo explícitamente.' + genderLine;
        }
        // Update last_used on all rows
        await db.execute('UPDATE scent_profiles SET last_used=? WHERE customer_id=?', [new Date(), customerId2]);
      }
    } catch(e) { console.warn('Profile load error:', e.message); }
  }

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
  const isLastTurn = userMsgCount >= 5;
  const lastTurnNote = isLastTurn ? '\n\nÚLTIMO MENSAJE: Este es tu último mensaje en esta consulta. NO hagas preguntas — el cliente no podrá responder. Cierra con tu mejor recomendación y dirige a las tarjetas.' : '';

  const avoidNote = avoidIds.length
    ? `\n\nPRODUCTOS YA RECOMENDADOS EN ESTA CONVERSACIÓN: IDs ${avoidIds.join(', ')}. Pasa estos IDs en el parámetro exclude_ids al llamar search_catalogue para obtener opciones frescas. Si el catálogo no tiene suficientes alternativas puedes repetir alguno justificándolo.`
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

OBJETIVO: Perfilar en pocos turnos. Recomendar lo antes posible. Solo productos del catálogo.

FLUJO (máx 5 turnos):
- T1: bienvenida breve + máx 2 preguntas si faltan datos clave
- T2+: si hay contexto suficiente, recomienda sin preguntar más
- Si el usuario da contexto desde el inicio, recomienda de inmediato

CUÁNDO buscar: cualquier ocasión, vibe, familia, nota, producto o marca → busca. En duda → busca.
CUÁNDO preguntar: SOLO si el mensaje no da ninguna pista útil.
NUNCA preguntes lo que ya sabes. NUNCA digas que algo no existe sin buscarlo.

SEÑALES DE INTENCIÓN ALTA — interprétalas y actúa:
- "Algo que no lo tenga cualquiera", "algo exclusivo", "algo diferente", "algo especial", "algo único", "algo de nicho" → el cliente quiere carácter y rareza. USA min_price:150 en search_catalogue para filtrar el tier diamond/gold y quedarte solo con premium. Busca en families: ["chypre","woody","oriental","leather","oud"]. Las marcas de nicho en nuestro catálogo son: Maison Francis Kurkdjian, Creed, Tom Ford, Initio, Parfums de Marly, Le Labo, Vilhelm Parfumerie, Mancera, Montale, Sospiro. NO recomiendes Lattafa, Afnan, Armaf, Ajmal, Zimaya para estas solicitudes.
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
Presupuesto limitado → menciona el precio del decant. Para fragancias luxury el resultado incluye decant10:$XX y decant5:$XX — el 5ml es la entrada más accesible.

GÉNERO: perfil con género → úsalo siempre. Sin género → pregunta UNA vez. Unisex válido para cualquier género.

PERFIL_JSON — al final cuando presentes fragancias (sin texto después):
PERFIL_JSON:{...}
Ejemplo: PERFIL_JSON:{"gender_pref":"M","families":["oriental","woody"],"notes":["amber","oud"],"intensity":"strong","occasions":["evening"],"season":"Fall","price_min":0,"price_max":500,"avoid":[],"recommended_ids":[33,40,22]}
Campos: gender_pref, families (NON-EMPTY), notes, intensity, occasions, season, price_min, price_max, avoid, recommended_ids, gift (true solo en consultas de regalo).
SOLO omite PERFIL_JSON si únicamente haces una pregunta.

CIERRE: Cuando el cliente muestre interés o decisión, cierra directo: "La encuentras en las tarjetas de abajo — agrégala al carrito desde ahí." Si ya eligió, confirma y cierra: "Perfecto. La tienes en la tarjeta de abajo." No preguntes "¿te gustaría agregarla?" — simplemente indica dónde está.
ÚLTIMO TURNO: Si es tu último mensaje disponible en esta consulta, NUNCA termines con una pregunta — el cliente no podrá responder. Cierra con una recomendación final clara y dirige a las tarjetas: "Ahí las tienes en las tarjetas — cualquiera es una excelente elección."

VALORES DE SILLAGE — úsalos en objeciones:
- Autenticidad garantizada: importamos de distribuidores mayoristas autorizados en EE.UU., con todos los registros sanitarios de El Salvador. Sin réplicas, sin alteraciones.
- Cada decant es fraccionado bajo estrictas normas de higiene — el mismo producto que encuentras en una tienda de lujo.
- Los decants vienen en viales de cristal con casing de aluminio — el aluminio protege de la luz directa que degrada la composición química del perfume, y el cristal preserva la fragancia sin alterar su aroma. Es el mismo estándar que usan las casas de perfumería de lujo para sus muestras.
- Entrega: Gran San Salvador 1-3 días hábiles, Interior del país 3-7 días, Centroamérica 7-15 días.
- Política de devoluciones disponible.
- El decant es la forma más inteligente de probar un perfume de lujo antes de invertir en el frasco completo — ningún competidor te da esa seguridad.

OBJECIONES DE PRECIO:
- "Está caro" / "es mucho" → ofrece el decant: "Puedes probarla en decant por $XX — vial de cristal, mismo perfume, sin compromiso."
- "¿Por qué cuesta tanto?" → explica brevemente: ingredientes premium, duración, proyección, autenticidad garantizada. Redirige al decant. SIEMPRE llama search_catalogue para obtener el ID del producto y mostrar su tarjeta — nunca respondas una objeción de precio sin tarjeta.
- Si el decant también está fuera de rango → busca con max_price ajustado y presenta alternativas con tarjetas.
- Nunca te disculpes por el precio — defiéndelo con confianza.
- REGLA CRÍTICA: Cada vez que menciones o recomiendes un producto — en cualquier contexto, incluyendo objeciones — DEBES escribir su nombre en **negritas** así: **Armaf Club de Nuit Intense**. Sin negritas no aparece la tarjeta. Sin tarjeta no hay venta.

OBJECIONES DE COMPETENCIA / CONFIANZA:
- Si el cliente menciona otro vendedor o precio más bajo → no ataques, pero planta la duda: "La diferencia está en lo que no ves — procedencia, fraccionado, almacenamiento. Con Sillage eso está resuelto."
- Si pregunta por autenticidad → responde con confianza total y sin rodeos.

CIERRE FINAL — varía el cierre, nunca repitas la misma frase:
- "Están en las tarjetas — es un buen momento para probarla."
- "El decant es exactamente para esto. Lo tienes en la tarjeta."
- "Pocas formas mejores de conocer una fragancia antes de comprometerte con el frasco."
- "Si te convence en decant, el frasco siempre va a estar aquí."
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

      // Cache key — based on search params (excluding exclude_ids which vary per conversation)
      const cacheKey = JSON.stringify({ families, noteTerms,
        gender: args.gender, max_price: args.max_price, min_price: args.min_price,
        season: args.season, intensity: args.intensity });
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
          if (expandedNoteTerms.length > 0 && noteMatchCount === 0) score -= 50;

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
        const decantP  = p.decantPrice  ? parseFloat(p.decantPrice)  : Math.round(effPrice * 0.30);
        const decant5P = p.decantPrice5 ? parseFloat(p.decantPrice5) : Math.round(decantP * 0.55);
        const decantLabel = p.luxury
          ? `decant10:$${decantP} decant5:$${decant5P}`
          : `decant:$${decantP}`;
        const parts = [
          `id:${p.id} ${p.brand} ${p.name} ${priceLabel} ${decantLabel} ${p.g}`,
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
    const replyCacheKey = getReplyCacheKey(messages, profileContext);
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
            max_tokens:  700,  // enough for 3 recommendations + PERFIL_JSON
            temperature: 0.7
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
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: oaiMessages, max_tokens: 400, temperature: 0.7 })
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
// ─── Bundle Routes ────────────────────────────────────

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
  const catalogue = await getCatalogue();
  const maxId = catalogue.reduce((m, p) => Math.max(m, p.id || 0), 0);
  const newFrag = { ...req.body, id: maxId + 1 };
  catalogue.push(newFrag);
  await saveCatalogue(catalogue);
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
  catalogue[idx] = { ...req.body, id };
  await saveCatalogue(catalogue);
  broadcast('catalogue', catalogue);
  await logActivity(`Fragancia actualizada: ${catalogue[idx].brand} ${catalogue[idx].name}`);
  res.json({ ok: true, fragrance: catalogue[idx] });
});

app.delete('/api/catalogue/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  let catalogue = await getCatalogue();
  const frag = catalogue.find(p => p.id === id);
  if (!frag) return res.status(404).json({ error: 'Fragancia no encontrada' });
  catalogue = catalogue.filter(p => p.id !== id);
  await saveCatalogue(catalogue);
  broadcast('catalogue', catalogue);
  await logActivity(`Fragancia eliminada: ${frag.brand} ${frag.name}`);
  res.json({ ok: true });
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
    const catalogue = await getCatalogue();
    const result = rows.map(r => {
      const prod = catalogue.find(p => p.id === r.product_id);
      const decants_remaining = r.decant_size > 0 ? Math.floor(r.ml_remaining / r.decant_size) : 0;
      const samples_remaining = r.sample_size > 0 ? Math.floor(r.ml_remaining / r.sample_size) : 0;
      const low_alert = parseFloat(r.ml_remaining) <= parseFloat(r.alert_ml);
      const empty = parseFloat(r.ml_remaining) <= 0;
      return {
        ...r,
        product_name: prod ? `${prod.brand} ${prod.name}` : `Producto ${r.product_id}`,
        decants_remaining,
        samples_remaining,
        low_alert,
        empty,
        ml_remaining:  parseFloat(r.ml_remaining),
        ml_total:      parseFloat(r.ml_total),
        ml_reserved:   parseFloat(r.ml_reserved),
        decant_size:   parseFloat(r.decant_size),
        sample_size:   parseFloat(r.sample_size),
        alert_ml:      parseFloat(r.alert_ml),
        bottle_size:   parseFloat(r.bottle_size),
      };
    });
    res.json(result);
  } catch(e) {
    console.error('Bottle inventory GET error:', e.message);
    res.status(500).json({ error: 'Error al cargar inventario de botellas.' });
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
  const pid = parseInt(req.params.id, 10);
  const { ml } = req.body; // ml being added (e.g. 100 for a 100ml bottle)
  if (!ml || parseFloat(ml) <= 0) return res.status(400).json({ error: 'ml inválido' });
  const mlNum = parseFloat(ml);
  const n = new Date();
  await db.execute(`
    UPDATE bottle_inventory SET
      ml_total     = ml_total + ?,
      ml_remaining = ml_remaining + ?,
      bottles_count = bottles_count + 1,
      updated_at   = ?
    WHERE product_id = ?
  `, [mlNum, mlNum, n, pid]);
  const catalogue = await getCatalogue();
  const prod = catalogue.find(p => p.id === pid);
  await logActivity(`Botella registrada: ${prod ? prod.brand+' '+prod.name : 'ID '+pid} (+${mlNum}ml)`);
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
// ─── Start ────────────────────────────────────────────
// Prevent DB errors from crashing the server
// ── Global Express error handler — NEVER expose internals to client ──────────
// This catches any error passed to next(err) or unhandled async throws
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
    console.log('\u2705 SILLAGE PARFUMERIE v3.1 - Server Ready | ' + BASE_URL);
  } catch(err) {
    console.error('\u274C DB startup failed:', err.message);
    process.exit(1);
  }
}
start();
