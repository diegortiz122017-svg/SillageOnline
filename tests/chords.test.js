'use strict';
// Pruebas de referencia del cálculo de acordes. Ejecutar:  node tests/chords.test.js
// Si cambias services/chords.js y alguna falla, el cambio empeoró un caso conocido.
const assert = require('assert');
const { calcChords, analyzeChords } = require('../services/chords');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }
const has   = (p, c) => assert.ok(calcChords(p).includes(c), `${c} debería estar en [${calcChords(p)}]`);
const lacks = (p, c) => assert.ok(!calcChords(p).includes(c), `${c} NO debería estar en [${calcChords(p)}]`);

// ── Reconocimiento por palabra completa (antes: por subcadena) ─────────────────
t('"Saffron" es Especiado/Ambarado, no Gourmand ("ron")', () => {
  const p = { mid: 'Saffron' }; has(p, 'Especiado'); lacks(p, 'Gourmand');
});
t('"Citron" es Cítrico, no Gourmand', () => { const p = { top: 'Citron' }; has(p, 'Cítrico'); lacks(p, 'Gourmand'); });
t('"Ron" (licor) sí es Gourmand', () => has({ top: 'Ron, Ciruela' }, 'Gourmand'));
t('"Pimienta rosa" no suma Floral', () => { const p = { top: 'Pimienta rosa' }; has(p, 'Especiado'); lacks(p, 'Floral'); });
t('"Rosewood" es madera, no Floral', () => { const p = { mid: 'Rosewood' }; has(p, 'Amaderado'); lacks(p, 'Floral'); });
t('"Watermelon" es Frutal (ya no cuenta como "water" acuático)', () => assert.strictEqual(calcChords({ top: 'Watermelon' })[0], 'Frutal'));
t('"Pearl" no es Frutal', () => { assert.deepStrictEqual(calcChords({ top: 'Pearl' }), []); });
t('"Plumeria" es Floral, no Frutal', () => { const p = { mid: 'Plumeria' }; has(p, 'Floral'); lacks(p, 'Frutal'); });
t('"Pineapple" no cuenta también "apple" (peso 1, una vez)', () => {
  assert.strictEqual(analyzeChords({ top: 'Pineapple' }).scores.Frutal, 1);
});
t('"Ámbar gris" no cuenta además "ámbar"', () => {
  assert.strictEqual(analyzeChords({ base: 'Ámbar gris' }).scores.Ambarado, 0.5 * 1.6);
});
t('acentos y mayúsculas no importan', () => {
  assert.deepStrictEqual(calcChords({ top: 'LIMÓN' }), calcChords({ top: 'limon' }));
});

// ── Perfumes de referencia (catálogo real) ─────────────────────────────────────
t('Khamrah (Lattafa): dulce, ámbar y gourmand', () => {
  const p = { top: 'Canela, Bergamota, Nuez Moscada', mid: 'Dátiles, Praline, Tuberosa, Mahonial',
              base: 'Vainilla, Tonka, Madera de ámbar, Mirra, Benjuí, Madera de akigala', sillage: 'Very Strong' };
  has(p, 'Dulce'); has(p, 'Ambarado'); has(p, 'Gourmand');
  assert.strictEqual(calcChords(p)[0], 'Dulce');
});
t('Eclaire (Lattafa): gourmand dulce', () => {
  const p = { top: 'Caramelo, Leche, Azucar', mid: 'Miel, Flores blancas', base: 'Vainilla, Praline, Almizcle' };
  has(p, 'Gourmand'); has(p, 'Dulce');
});
t('Encre Noire (Lalique): amaderado terroso', () => {
  const p = { top: 'Ciprés', mid: 'Vetiver', base: 'Madera de Cachemira, Almizcle' };
  has(p, 'Amaderado'); has(p, 'Terroso');
});
t('Fakhar (Lattafa): aromático amaderado', () => {
  const p = { top: 'Bergamota, Manzana, Gengibre', mid: 'Lavand, Salvia, Bayas de enebro, Geranio', base: 'Tonka, Cedro, Vetiver, Amber' };
  assert.strictEqual(calcChords(p)[0], 'Aromático'); has(p, 'Amaderado');
});
t('Ramz Gold (Lattafa): frutal y floral', () => {
  const p = { top: 'Manzana, Durazno, Pera, Naranja, Grosella', mid: 'Rosa, Jazmin sambac, Azahar', base: 'Sándalo, Almizcle Blanco, Vainilla, Pachulí' };
  has(p, 'Frutal'); has(p, 'Floral');
});
t('Aventus-like: la familia principal es Frutal y Terroso (musgo/pachulí) entra; Sensual es solo un matiz', () => {
  const p = { top: 'Pineapple, Bergamot, Apple, Blackcurrant', mid: 'Rose, Jasmine, Birch, Patchouli', base: 'Musk, Oakmoss, Ambergris, Vanilla', sillage: 'Strong' };
  assert.strictEqual(calcChords(p)[0], 'Frutal'); has(p, 'Terroso'); assert.notStrictEqual(calcChords(p)[0], 'Sensual');
});

// ── Reglas generales ───────────────────────────────────────────────────────────
t('la estela por sí sola NO crea una familia', () => {
  assert.deepStrictEqual(calcChords({ sillage: 'Very Strong' }), []);
});
t('Sensual/Cálido/Fresco son matices: no aparecen salvo que pesen frente a la familia líder', () => {
  const p = { base: 'Almizcle', mid: 'Cedro, Cedro de Virginia, Sándalo', sillage: 'Strong' };   // muchas notas amaderadas, poco almizcle
  lacks(p, 'Sensual');
});
t('máximo 5 acordes y la primera es siempre una familia (no un matiz)', () => {
  const { FAMILIES } = require('../services/chords');
  const p = { top: 'Bergamota, Lavanda, Pimienta', mid: 'Rosa, Jazmín, Geranio', base: 'Vainilla, Ámbar, Almizcle, Cedro, Pachulí', sillage: 'Very Strong' };
  const c = calcChords(p);
  assert.ok(c.length <= 5); assert.ok(FAMILIES.includes(c[0]));
});
t('notas desconocidas se reportan', () => {
  assert.deepStrictEqual(analyzeChords({ top: 'Bergamota, Unobtainium' }).unknown, ['Unobtainium']);
});
t('el resultado es estable (mismo orden siempre)', () => {
  const p = { top: 'Lavanda, Limón', mid: 'Rosa, Cedro', base: 'Vainilla, Pachulí' };
  assert.deepStrictEqual(calcChords(p), calcChords(JSON.parse(JSON.stringify(p))));
});

console.log(`\n${passed} pruebas pasaron`);
