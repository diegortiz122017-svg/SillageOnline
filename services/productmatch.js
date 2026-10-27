'use strict';

// Enlaza los ítems de una venta manual (DTE emitido a mano) con perfumes del catálogo, para que
// cuenten en "Más vendidos", marcas y demás estadísticas, que leen item.productId de cada pedido.
// Lógica PURA y conservadora: ante la duda NO enlaza (un ítem sin enlazar se resuelve a mano; uno
// mal enlazado falsea los números sin que nadie se entere).

const { norm } = require('./nurture');

const DECANT_WORDS = /\b(decants?|muestras?|samples?)\b/;
// Líneas que no son perfumes (se ignoran: ni se enlazan ni se reportan como "sin enlazar").
const NON_PRODUCT = /^(env[ií]o|flete|delivery|shipping|costo de env[ií]o|gastos de env[ií]o|propina|descuento|recargo)\b/i;

function isNonProductLine(name) { return NON_PRODUCT.test(String(name || '').trim()); }

// Minúsculas, sin acentos, sin tamaños ("100ml") ni palabras de formato ("decant", "frasco", "EDP").
function clean(s) {
  return norm(s)
    .replace(/\b\d+\s*(ml|oz)\b/g, ' ')
    .replace(/\b(decants?|muestras?|samples?|frasco|botella|perfume|eau de parfum|edp|edt)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// → { product, type: 'full'|'decant', how } o null
function matchProduct(text, catalogue) {
  const n = clean(text);
  if (n.length < 3) return null;
  const type = DECANT_WORDS.test(norm(text)) ? 'decant' : 'full';
  const rows = (catalogue || []).map(p => ({ p, full: clean(`${p.brand} ${p.name}`), name: clean(p.name) }));

  const uniq = (list, how) => (list.length === 1 ? { product: list[0].p, type, how } : null);
  // 1) "Marca Nombre" exacto (lo que escribe el selector del catálogo)
  const full = rows.filter(r => r.full === n);
  const byName = rows.filter(r => r.name === n);
  // Si el texto es a la vez "Marca Nombre" de un perfume y el nombre de OTRO (p. ej. "Animale for Men" de la
  // marca Animale y un producto llamado "Animale Animale for men"), es ambiguo: no se adivina.
  if (full.length && byName.length && [...full, ...byName].some(r => r.p.id !== (full[0] || byName[0]).p.id)) return null;
  if (full.length) return uniq(full, 'full');
  // 2) solo el nombre, si es único en todo el catálogo
  if (byName.length) return uniq(byName, 'name');
  // 3) el texto CONTIENE el nombre completo (p. ej. "Khamrah Qahwa de regalo"): gana el más largo y no puede empatar
  //    (se prueba con "Marca Nombre" y, si el nombre es único, también con el nombre solo)
  const nameCount = new Map();
  rows.forEach(r => nameCount.set(r.name, (nameCount.get(r.name) || 0) + 1));
  const keys = rows.flatMap(r => [{ p: r.p, key: r.full }, ...(nameCount.get(r.name) === 1 ? [{ p: r.p, key: r.name }] : [])]);
  const inside = keys.filter(k => k.key.length >= 5 && (` ${n} `).includes(` ${k.key} `))
    .sort((a, b) => b.key.length - a.key.length);
  if (inside.length) {
    const top = inside[0];
    const rival = inside.find(k => k.p.id !== top.p.id && k.key.length === top.key.length);   // empate entre perfumes distintos
    if (!rival) return { product: top.p, type, how: 'contains' };
  }
  return null;
}

// items: [{ name, qty, price, productId?, type? }]. Devuelve { items, linked, unmatched }:
//  · un productId que existe en el catálogo se respeta;
//  · si falta (o no existe), se intenta enlazar por nombre;
//  · unmatched = ítems que siguen sin perfume (sin contar envíos y similares), con su posición.
function linkItems(items, catalogue) {
  const byId = new Map((catalogue || []).map(p => [Number(p.id), p]));
  let linked = 0;
  const unmatched = [];
  const out = (items || []).map((it, index) => {
    const pid = parseInt(it && it.productId, 10);
    if (pid && byId.has(pid)) return it;
    if (isNonProductLine(it && it.name)) return it;
    const m = matchProduct(it && it.name, catalogue);
    if (m) {
      linked++;
      return { ...it, productId: Number(m.product.id), type: m.type === 'decant' ? 'decant' : (it.type || 'full') };
    }
    unmatched.push({ index, name: String((it && it.name) || ''), qty: Number(it && it.qty) || 1, price: Number(it && it.price) || 0 });
    return it;
  });
  return { items: out, linked, unmatched };
}

module.exports = { matchProduct, linkItems, isNonProductLine, clean };
