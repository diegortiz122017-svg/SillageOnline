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

module.exports = { collectionProducts, collectionSlug };
