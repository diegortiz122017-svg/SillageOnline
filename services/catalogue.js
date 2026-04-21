'use strict';

const db    = require('./db');
const cache = require('./cache');

// ── Helper: map a DB row back to the legacy product shape ─────────────────────
// All existing code (frontend, Nez, admin) uses the old field names (g, top, mid,
// base, conc, long, desc, c, s) — we keep those names in the returned objects
// so nothing else needs to change.
function rowToProduct(r) {
  return {
    id:            r.id,
    brand:         r.brand,
    name:          r.name,
    g:             r.gender,
    price:         parseFloat(r.price),
    decantPrice:   r.decant_price  != null ? parseFloat(r.decant_price)  : undefined,
    decantPrice5:  r.decant_price_5 != null ? parseFloat(r.decant_price_5) : undefined,
    decantSizeMl:  r.decant_size_ml  != null ? parseFloat(r.decant_size_ml)  : undefined,
    size:          r.size,
    badge:         r.badge,
    luxury:        !!r.luxury,
    notes:         r.notes,
    top:           r.top_notes,
    mid:           r.mid_notes,
    base:          r.base_notes,
    top_intensity: r.top_intensity,
    mid_intensity: r.mid_intensity,
    base_intensity:r.base_intensity,
    tagline:       r.tagline,
    desc:          r.description,
    conc:          r.concentration,
    season:        r.season,
    sillage:       r.sillage,
    long:          r.longevity,
    c:             r.colors  ? (typeof r.colors  === 'string' ? JSON.parse(r.colors)  : r.colors)  : [],
    s:             r.shape,
    photos:        r.photos  ? (typeof r.photos  === 'string' ? JSON.parse(r.photos)  : r.photos)  : [],
    chords:        (() => {
      const override = r.chords_override ? (typeof r.chords_override === 'string' ? JSON.parse(r.chords_override) : r.chords_override) : null;
      const auto     = r.chords ? (typeof r.chords === 'string' ? JSON.parse(r.chords) : r.chords) : [];
      return (override && override.length) ? override : auto;
    })(),
    chords_override: r.chords_override ? (typeof r.chords_override === 'string' ? JSON.parse(r.chords_override) : r.chords_override) : null,
    sort_order:    r.sort_order,
  };
}

// ── Helper: map incoming product object to DB column values ───────────────────
function productToRow(p, now) {
  return [
    p.brand        || '',
    p.name         || '',
    p.g            || 'U',
    parseFloat(p.price)        || 0,
    p.decantPrice  != null ? parseFloat(p.decantPrice)  : null,
    p.decantPrice5  != null ? parseFloat(p.decantPrice5)  : null,
    p.decantSizeMl  != null ? parseFloat(p.decantSizeMl)  : null,
    p.size         || null,
    p.badge        || null,
    p.luxury       ? 1 : 0,
    p.notes        || null,
    p.top          || null,
    p.mid          || null,
    p.base         || null,
    p.top_intensity  != null ? p.top_intensity  : 30,
    p.mid_intensity  != null ? p.mid_intensity  : 30,
    p.base_intensity != null ? p.base_intensity : 30,
    p.tagline      || null,
    p.desc         || null,
    p.conc         || null,
    p.season       || null,
    p.sillage      || null,
    p.long         || null,
    p.c            ? JSON.stringify(p.c)      : null,
    p.s            || null,
    p.photos       ? JSON.stringify(p.photos) : null,
    p.chords       ? JSON.stringify(p.chords) : null,
    p.chords_override ? JSON.stringify(p.chords_override) : null,
    p.sort_order   != null ? p.sort_order : 0,
    now,
  ];
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

async function getCatalogue() {
  const cached = cache.catalogueCache.get('catalogue');
  if (cached) return cached;

  const [rows] = await db.execute(
    'SELECT * FROM products WHERE active=1 ORDER BY sort_order ASC, id ASC'
  );
  const data = rows.map(rowToProduct);
  cache.catalogueCache.set('catalogue', data);
  return data;
}

// saveCatalogue: kept for backwards compatibility with any code that calls it
// with a full array. Performs an upsert for each product.
async function saveCatalogue(data) {
  const now = new Date();
  for (const p of data) {
    if (!p.id) continue;
    await db.execute(`
      INSERT INTO products
        (id, brand, name, gender, price, decant_price, decant_price_5, decant_size_ml,
         size, badge, luxury, notes, top_notes, mid_notes, base_notes,
         top_intensity, mid_intensity, base_intensity,
         tagline, description, concentration, season, sillage, longevity,
         colors, shape, photos, chords, chords_override, sort_order, active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
      ON DUPLICATE KEY UPDATE
        brand=VALUES(brand), name=VALUES(name), gender=VALUES(gender),
        price=VALUES(price), decant_price=VALUES(decant_price),
        decant_price_5=VALUES(decant_price_5), decant_size_ml=VALUES(decant_size_ml),
        size=VALUES(size), badge=VALUES(badge), luxury=VALUES(luxury),
        notes=VALUES(notes), top_notes=VALUES(top_notes), mid_notes=VALUES(mid_notes),
        base_notes=VALUES(base_notes), top_intensity=VALUES(top_intensity),
        mid_intensity=VALUES(mid_intensity), base_intensity=VALUES(base_intensity),
        tagline=VALUES(tagline), description=VALUES(description),
        concentration=VALUES(concentration), season=VALUES(season),
        sillage=VALUES(sillage), longevity=VALUES(longevity),
        colors=VALUES(colors), shape=VALUES(shape), photos=VALUES(photos),
        chords=VALUES(chords), chords_override=VALUES(chords_override),
        sort_order=VALUES(sort_order), updated_at=VALUES(updated_at)`,
      [p.id, ...productToRow(p, now), now]
    );
  }
  cache.catalogueCache.delete('catalogue'); // invalidate so next read is fresh
}

// ── Individual product operations (used by new endpoints) ─────────────────────

async function addProduct(p) {
  const now = new Date();
  // Get next id
  const [maxRow] = await db.execute('SELECT COALESCE(MAX(id),0)+1 AS next_id FROM products');
  const id = maxRow[0].next_id;
  await db.execute(`
    INSERT INTO products
      (id, brand, name, gender, price, decant_price, decant_price_5, decant_size_ml,
       size, badge, luxury, notes, top_notes, mid_notes, base_notes,
       top_intensity, mid_intensity, base_intensity,
       tagline, description, concentration, season, sillage, longevity,
       colors, shape, photos, chords, chords_override, sort_order, active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [id, ...productToRow(p, now), now]
  );
  cache.catalogueCache.delete('catalogue');
  return id;
}

async function updateProduct(id, p) {
  const now = new Date();
  await db.execute(`
    UPDATE products SET
      brand=?, name=?, gender=?, price=?, decant_price=?, decant_price_5=?, decant_size_ml=?,
      size=?, badge=?, luxury=?, notes=?, top_notes=?, mid_notes=?, base_notes=?,
      top_intensity=?, mid_intensity=?, base_intensity=?,
      tagline=?, description=?, concentration=?, season=?, sillage=?, longevity=?,
      colors=?, shape=?, photos=?, chords=?, chords_override=?, sort_order=?, updated_at=?
    WHERE id=?`,
    [...productToRow(p, now), id]
  );
  cache.catalogueCache.delete('catalogue');
}

async function deleteProduct(id) {
  // Soft delete — preserves historical order references
  await db.execute('UPDATE products SET active=0, updated_at=? WHERE id=?', [new Date(), id]);
  cache.catalogueCache.delete('catalogue');
}

async function getProductById(id) {
  const [rows] = await db.execute('SELECT * FROM products WHERE id=? AND active=1', [id]);
  return rows.length ? rowToProduct(rows[0]) : null;
}

// ── Inventory ─────────────────────────────────────────────────────────────────

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

// ── Pricing ───────────────────────────────────────────────────────────────────

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

// ── Activity log ──────────────────────────────────────────────────────────────

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

// ── Settings ──────────────────────────────────────────────────────────────────

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

// ── Brand hierarchy ───────────────────────────────────────────────────────────

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
  addProduct,
  updateProduct,
  deleteProduct,
  getProductById,
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
