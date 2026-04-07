'use strict';

const db    = require('./db');
const cache = require('./cache');

// ─── Catalogue ────────────────────────────────────────────────────────────────
async function getCatalogue() {
  const cached = cache.catalogueCache.get('catalogue');
  if (cached) return cached;

  const [rows] = await db.execute('SELECT data FROM catalogue ORDER BY id DESC LIMIT 1');
  const data   = rows.length ? JSON.parse(rows[0].data) : [];
  cache.catalogueCache.set('catalogue', data);
  return data;
}

async function saveCatalogue(data) {
  await db.execute('DELETE FROM catalogue');
  await db.execute('INSERT INTO catalogue (data, updated_at) VALUES (?, ?)', [
    JSON.stringify(data), new Date(),
  ]);
  cache.catalogueCache.set('catalogue', data); // update cache immediately
}

// ─── Inventory ────────────────────────────────────────────────────────────────
async function getInventoryMap() {
  const cached = cache.inventoryCache.get('inventory');
  if (cached) return cached;

  const [rows] = await db.execute('SELECT * FROM inventory');
  const map    = {};
  rows.forEach(r => {
    map[r.product_id] = {
      stock:      r.stock,
      lowStock:   !!r.low_stock,
      outOfStock: !!r.out_of_stock,
    };
  });
  cache.inventoryCache.set('inventory', map);
  return map;
}

function invalidateInventory() {
  cache.inventoryCache.delete('inventory');
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
async function getPricingMap() {
  const cached = cache.pricingCache.get('pricing');
  if (cached) return cached;

  const [rows] = await db.execute('SELECT * FROM pricing');
  const map    = {};
  rows.forEach(r => {
    map[r.product_id] = {
      salePrice: r.sale_price,
      onSale:    !!r.on_sale,
    };
  });
  cache.pricingCache.set('pricing', map);
  return map;
}

function invalidatePricing() {
  cache.pricingCache.delete('pricing');
}

// ─── Activity log ─────────────────────────────────────────────────────────────
async function logActivity(msg) {
  await db.execute('INSERT INTO activity (message, created_at) VALUES (?, ?)', [msg, new Date()]);
}

async function getActivity(limit = 20) {
  const [rows] = await db.query(
    'SELECT message AS msg, created_at AS time FROM activity ORDER BY created_at DESC LIMIT ?',
    [parseInt(limit) || 20]
  );
  return rows;
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function getSetting(key, defaultValue = null) {
  try {
    const [rows] = await db.execute('SELECT value FROM settings WHERE key_name=?', [key]);
    return rows.length ? rows[0].value : defaultValue;
  } catch { return defaultValue; }
}

async function setSetting(key, value) {
  await db.execute(
    `INSERT INTO settings (key_name, value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=VALUES(updated_at)`,
    [key, String(value), new Date()]
  );
}

// ─── Brand hierarchy ──────────────────────────────────────────────────────────
const cfg = require('../config');

async function getBrandHierarchy() {
  const stored = await getSetting('brand_hierarchy');
  if (stored) {
    try { return JSON.parse(stored); } catch { /* fall through */ }
  }
  return cfg.DEFAULT_BRAND_HIERARCHY;
}

module.exports = {
  getCatalogue,
  saveCatalogue,
  getInventoryMap,
  invalidateInventory,
  getPricingMap,
  invalidatePricing,
  logActivity,
  getActivity,
  getSetting,
  setSetting,
  getBrandHierarchy,
};
