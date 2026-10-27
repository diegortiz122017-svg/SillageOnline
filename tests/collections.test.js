'use strict';
// Pruebas de las colecciones del lado del servidor. Ejecutar:  node tests/collections.test.js
const assert = require('assert');
const { collectionProducts, collectionSlug } = require('../services/collections');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }

const cat = [
  { id: 1, brand: 'Lattafa', name: 'Khamrah', notes: 'Canela, Vainilla, Tonka', top: 'Canela', mid: 'Dátiles', base: 'Vainilla', price: 60, sillage: 'Very Strong', badge: 'bestseller' },
  { id: 2, brand: 'Lacoste', name: 'Silver Grey', notes: 'Bergamota, Cedro', top: 'Bergamota', mid: 'Cedro', base: 'Ambroxan', price: 102, sillage: 'Moderate' },
  { id: 3, brand: 'Lattafa', name: 'Asad', notes: 'Oud, Ámbar', top: 'Lavanda', mid: 'Oud', base: 'Vainilla', price: 55, sillage: 'Very Strong' },
  { id: 4, brand: 'Coach', name: 'Dreams', notes: 'Mandarina', top: 'Mandarina', mid: 'Jazmín', base: 'Tonka', price: 110, sillage: 'Moderate' },
];
const ids = c => collectionProducts(c, cat).map(p => p.id);

t('manual: solo los ids guardados (JSON como texto o como arreglo)', () => {
  assert.deepStrictEqual(ids({ type: 'manual', product_ids: '[1,4]' }), [1, 4]);
  assert.deepStrictEqual(ids({ type: 'manual', product_ids: [3] }), [3]);
  assert.deepStrictEqual(ids({ type: 'manual', product_ids: null }), []);
  assert.deepStrictEqual(ids({ type: 'manual', product_ids: '[1' }), [], 'JSON roto no revienta');
});
t('auto por nota: coincide CUALQUIERA de las notas, sin importar mayúsculas', () => {
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: '{"note":"vainilla"}' }), [1, 3]);
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: { note: 'Oud, Jazmín' } }), [3, 4]);
});
t('auto por rango de precio y estela', () => {
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: '{"price_max":60}' }), [1, 3]);
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: '{"price_min":100}' }), [2, 4]);
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: '{"sillage":"Very Strong"}' }), [1, 3]);
});
t('auto con varios criterios: deben cumplirse todos los tipos a la vez', () => {
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: '{"note":"vainilla","price_max":56}' }), [3]);
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: '{"badge":"bestseller"}' }), [1]);
});
t('auto sin filtros trae todo el catálogo', () => {
  assert.deepStrictEqual(ids({ type: 'auto', filter_json: null }), [1, 2, 3, 4]);
});
t('el slug coincide con el de los perfumes y bundles (sin acentos ni signos)', () => {
  assert.strictEqual(collectionSlug({ name: 'Para la Oficina' }), 'para-la-oficina');
  assert.strictEqual(collectionSlug({ name: 'Noches de Verano & Playa' }), 'noches-de-verano-playa');
  assert.strictEqual(collectionSlug({ name: 'Cálidas y Dulces' }), 'calidas-y-dulces');
});

console.log(`\n${passed} pruebas pasaron`);
