'use strict';
// Pruebas del enlace de ítems manuales con el catálogo. Ejecutar:  node tests/productmatch.test.js
const assert = require('assert');
const { matchProduct, linkItems, isNonProductLine } = require('../services/productmatch');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }

const cat = [
  { id: 32, brand: 'Lattafa', name: 'Khamrah' },
  { id: 60, brand: 'Lattafa', name: 'Khamrah Qahwa' },
  { id: 40, brand: 'Lattafa', name: 'Asad' },
  { id: 53, brand: 'Lattafa', name: 'Asad Bourbon' },
  { id: 63, brand: 'Lacoste', name: 'Silver Grey' },
  { id: 74, brand: 'David Beckham', name: 'Classic' },
  { id: 77, brand: 'David Beckham', name: 'Classic Homme' },
  { id: 90, brand: 'Dior', name: 'Sauvage' },
  { id: 91, brand: 'Otra', name: 'Sauvage' },            // mismo nombre en dos marcas
  { id: 86, brand: 'Jimmy Choo', name: 'I want choo [Edicion Limitada 25]' },
];
const id = text => { const m = matchProduct(text, cat); return m ? m.product.id : null; };

t('"Marca Nombre" exacto (lo que escribe el selector del catálogo)', () => {
  assert.strictEqual(id('Lattafa Khamrah'), 32);
  assert.strictEqual(id('Lacoste Silver Grey'), 63);
});
t('acentos, mayúsculas y espacios no importan', () => {
  assert.strictEqual(id('  LATTAFA   khamráh '.replace('á', 'a')), 32);
  assert.strictEqual(id('lacoste SILVER grey'), 63);
});
t('el nombre solo sirve si es único en el catálogo', () => {
  assert.strictEqual(id('Khamrah'), 32);
  assert.strictEqual(id('Silver Grey'), 63);
  assert.strictEqual(id('Sauvage'), null, 'Sauvage está en dos marcas: no se adivina');
  assert.strictEqual(id('Dior Sauvage'), 90);
});
t('no confunde una versión con otra (Khamrah vs Khamrah Qahwa, Asad vs Asad Bourbon, Classic vs Classic Homme)', () => {
  assert.strictEqual(id('Lattafa Khamrah Qahwa'), 60);
  assert.strictEqual(id('Khamrah Qahwa'), 60);
  assert.strictEqual(id('Asad Bourbon'), 53);
  assert.strictEqual(id('Asad'), 40);
  assert.strictEqual(id('David Beckham Classic'), 74);
  assert.strictEqual(id('David Beckham Classic Homme'), 77);
});
t('tamaños y palabras de formato se ignoran, y "decant" se detecta como tipo', () => {
  assert.strictEqual(id('Lattafa Khamrah 100ml'), 32);
  assert.strictEqual(id('Perfume Lattafa Asad EDP'), 40);
  const m = matchProduct('Decant Asad 10ml', cat);
  assert.strictEqual(m.product.id, 40);
  assert.strictEqual(m.type, 'decant');
  assert.strictEqual(matchProduct('Lattafa Khamrah (Decant 10 ml)', cat).type, 'decant');
  assert.strictEqual(matchProduct('Lattafa Khamrah', cat).type, 'full');
});
t('un texto que contiene el nombre completo enlaza al más largo', () => {
  assert.strictEqual(id('Khamrah Qahwa edición regalo'), 60);
  assert.strictEqual(id('Combo Lacoste Silver Grey + estuche'), 63);
});
t('ante la duda NO enlaza', () => {
  assert.strictEqual(id('Perfume para hombre'), null);
  assert.strictEqual(id('Lattafa'), null);
  assert.strictEqual(id('Ab'), null);
  assert.strictEqual(id(''), null);
  assert.strictEqual(id(undefined), null);
});
t('texto que es "Marca Nombre" de un perfume y el nombre de otro: ambiguo, no se adivina', () => {
  const c2 = [{ id: 81, brand: 'Animale', name: 'Animale for Men' }, { id: 87, brand: 'Animale', name: 'Animale Animale for men' }];
  assert.strictEqual(matchProduct('Animale Animale for men', c2), null);
  assert.strictEqual(matchProduct('Animale for Men', c2) && matchProduct('Animale for Men', c2).product.id, 81);
});
t('nombres con corchetes y números del catálogo enlazan con su texto completo', () => {
  assert.strictEqual(id('Jimmy Choo I want choo [Edicion Limitada 25]'), 86);
});
t('envíos y descuentos no son perfumes', () => {
  assert.ok(isNonProductLine('Envío') && isNonProductLine('Envio a domicilio') && isNonProductLine('Descuento'));
  assert.ok(!isNonProductLine('Lattafa Khamrah'));
});
t('linkItems: respeta el productId válido, enlaza por nombre, reporta lo que no pudo y no cuenta el envío', () => {
  const r = linkItems([
    { name: 'Lattafa Khamrah', qty: 1, price: 60, productId: 32, type: 'full' },     // ya enlazado
    { name: 'Decant Asad 10ml', qty: 2, price: 15 },                                 // por nombre, decant
    { name: 'Algo raro que no existe', qty: 1, price: 20 },                           // sin enlazar
    { name: 'Envío', qty: 1, price: 5 },                                              // no es perfume
    { name: 'Lattafa Khamrah', qty: 1, price: 60, productId: 9999 },                  // id que no existe → se reintenta por nombre
  ], cat);
  assert.strictEqual(r.linked, 2);
  assert.deepStrictEqual(r.items.map(i => i.productId), [32, 40, undefined, undefined, 32]);
  assert.strictEqual(r.items[1].type, 'decant');
  assert.deepStrictEqual(r.unmatched.map(u => [u.index, u.name]), [[2, 'Algo raro que no existe']]);
});
t('linkItems no modifica la lista original', () => {
  const orig = [{ name: 'Lattafa Asad', qty: 1, price: 50 }];
  linkItems(orig, cat);
  assert.strictEqual(orig[0].productId, undefined);
});

console.log(`\n${passed} pruebas pasaron`);
