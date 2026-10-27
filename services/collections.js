'use strict';

// Colecciones curadas del lado del servidor: qué perfumes trae una colección y cómo se llama su URL.
// Es el MISMO criterio que usa la tienda en el navegador (dbCollectionToLocal en tienda.html):
//  · manual → los ids guardados en product_ids;
//  · auto   → familias/notas (coincide CUALQUIERA, por texto), insignia, estela y rango de precio.
// Sirve para la vista previa al compartir /coleccion/<slug> y para el sitemap.

const { slugify } = require('./nurture');

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
const list = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

// c: fila de la tabla collections (filter_json / product_ids pueden venir como texto JSON u objeto).
function collectionProducts(c, catalogue) {
  if (c.type === 'manual') {
    const ids = new Set((parseJson(c.product_ids, []) || []).map(Number));
    return (catalogue || []).filter(p => ids.has(Number(p.id)));
  }
  const f = parseJson(c.filter_json, {}) || {};
  const families = list(f.family), notes = list(f.note);
  return (catalogue || []).filter(p => {
    const t = [p.notes, p.family, p.top, p.mid, p.base].map(x => x || '').join(' ').toLowerCase();
    if (families.length && !families.some(x => t.includes(x))) return false;
    if (notes.length && !notes.some(x => t.includes(x))) return false;
    if (f.badge && p.badge !== f.badge) return false;
    if (f.sillage && p.sillage !== f.sillage) return false;
    if (f.price_min && parseFloat(p.price) < f.price_min) return false;
    if (f.price_max && parseFloat(p.price) > f.price_max) return false;
    return true;
  });
}

const collectionSlug = c => slugify(c.name);

// Colecciones predeterminadas de la tienda (CURATED_FALLBACK en tienda.html): el navegador las usa SOLO
// cuando la base de datos no tiene ninguna activa. Aquí van únicamente nombre y frase (lo que necesita la
// vista previa al compartir); a qué perfumes alcanzan lo decide el navegador, por eso no hay conteo.
const DEFAULT_COLLECTIONS = [
  { name: 'La Oficina',         description: 'Presente sin saturar. El tipo que hace que pregunten.' },
  { name: 'Noche Especial',     description: 'Para cuando quieres dejar rastro.' },
  { name: 'Frescos & Cítricos', description: 'Abre una ventana. Energía inmediata.' },
  { name: 'Para Regalar',       description: 'Piezas que impresionan. Para quien merece lo mejor.' },
  { name: 'Los Más Vendidos',   description: 'Las fragancias más queridas por nuestros clientes.' },
  { name: 'Una Primera Cita',   description: 'Suave, memorable. Que invite a acercarse.' },
].map(c => Object.assign({ builtin: true }, c));

// rows: colecciones activas de la base de datos. Misma regla que el navegador: si hay alguna, solo esas;
// si no hay ninguna, las predeterminadas.
function findCollection(rows, slug) {
  const want = String(slug || '').toLowerCase();
  const pool = rows && rows.length ? rows : DEFAULT_COLLECTIONS;
  return pool.find(c => collectionSlug(c) === want) || null;
}

module.exports = { collectionProducts, collectionSlug, findCollection, DEFAULT_COLLECTIONS };
