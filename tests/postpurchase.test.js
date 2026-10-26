'use strict';
// Pruebas del motor de recomendaciones post-compra. Ejecutar:  node tests/postpurchase.test.js
const assert = require('assert');
const pp = require('../services/postpurchase');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }

let id = 0;
const P = (brand, name, g, chords, notes, extra) => ({
  id: ++id, brand, name, g, price: 50, size: '100ml', chords,
  top: notes[0] || '', mid: notes[1] || '', base: notes[2] || '', ...extra,
});
const khamrah = P('Lattafa', 'Khamrah', 'U', ['Dulce', 'Gourmand', 'Ambarado'], ['Canela', 'Dátiles', 'Vainilla, Tonka']);
const qahwa   = P('Lattafa', 'Khamrah Qahwa', 'U', ['Dulce', 'Gourmand', 'Especiado'], ['Canela', 'Café', 'Vainilla']);
const petra   = P('Lattafa', 'Petra', 'F', ['Dulce', 'Gourmand'], ['Praline', 'Vainilla', 'Tonka']);
const sunset  = P('Coach', 'Dreams Sunset', 'F', ['Dulce', 'Floral', 'Gourmand'], ['Mandarina', 'Jazmín', 'Tonka']);
const manIce  = P('Jimmy Choo', 'Man Ice', 'M', ['Terroso', 'Amaderado', 'Cítrico'], ['Menta, Manzana', 'Cedro', 'Musgo de roble']);
const platin  = P('Coach', 'Men Pure Platinum', 'M', ['Amaderado', 'Ambarado', 'Cítrico', 'Terroso'], ['Manzana', 'Cedro', 'Musgo de roble']);
const silver  = P('Lacoste', 'Silver Grey', 'M', ['Aromático', 'Amaderado', 'Terroso', 'Cítrico'], ['Bergamota', 'Cedro', 'Ambroxan']);
const filler  = Array.from({ length: 12 }, (_, i) => P('Marca' + i, 'Relleno ' + i, 'U', ['Amaderado'], ['Cedro', 'Sándalo', 'Almizcle']));
const catalogue = [khamrah, qahwa, petra, sunset, manIce, platin, silver, ...filler];

t('nunca recomienda lo que ya compró', () => {
  const r = pp.recommend([khamrah], catalogue, {}, {});
  assert.ok(r.length && r.every(x => x.p.id !== khamrah.id));
});
t('la versión hermana (Khamrah → Khamrah Qahwa) SÍ es una buena sugerencia y va primero', () => {
  const r = pp.recommend([khamrah], catalogue, {}, {});
  assert.strictEqual(r[0].p.id, qahwa.id);
});
t('no recomienda agotados', () => {
  const r = pp.recommend([khamrah], catalogue, { [qahwa.id]: { outOfStock: true } }, {});
  assert.ok(r.every(x => x.p.id !== qahwa.id));
});
t('comprador de un perfume de hombre: no se le sugieren perfumes de mujer', () => {
  const r = pp.recommend([manIce], catalogue, {}, {});
  assert.ok(r.length >= 2 && r.every(x => x.p.g !== 'F'));
  assert.ok(r.some(x => x.p.id === platin.id));
});
t('si lo comprado es unisex, los unisex pasan antes que los de un solo género', () => {
  const r = pp.recommend([khamrah], catalogue, {}, {});
  assert.ok(r.findIndex(x => x.p.id === qahwa.id) < r.findIndex(x => x.p.id === petra.id) || !r.some(x => x.p.id === petra.id));
});
t('las razones solo citan lo que de verdad comparten (acordes/notas del catálogo)', () => {
  const r = pp.recommend([manIce], catalogue, {}, {});
  const top = r.find(x => x.p.id === platin.id);
  assert.ok(/cítrico|terroso|musgo|manzana|cedro/i.test(top.reason), top.reason);
  assert.ok(!/gourmand|vainilla/i.test(top.reason), top.reason);
});
t('un acorde omnipresente ("Amaderado") no se usa como razón', () => {
  const r = pp.recommend([manIce], catalogue, {}, {});
  r.forEach(x => assert.ok(!/comparte[^.;]*amaderado/i.test(x.reason), x.reason));
});
t('máximo 2 por marca y sin repetir la misma línea entre sugerencias', () => {
  const r = pp.recommend([khamrah], catalogue, {}, {});
  const byBrand = {}; r.forEach(x => { byBrand[x.p.brand] = (byBrand[x.p.brand] || 0) + 1; });
  assert.ok(Object.values(byBrand).every(n => n <= 2));
});
t('es determinista (mismo resultado siempre)', () => {
  const a = pp.recommend([khamrah], catalogue, {}, {}).map(x => x.p.id).join();
  const b = pp.recommend([khamrah], catalogue, {}, {}).map(x => x.p.id).join();
  assert.strictEqual(a, b);
});
t('sin nada comprado no recomienda', () => assert.deepStrictEqual(pp.recommend([], catalogue, {}, {}), []));

const ctx = (extra) => ({ decantsEnabled: true, decantOut: new Set(), priceMap: {}, catalogue, invMap: {}, firstName: 'Ana', ...extra });
t('correo de 14 días: tarjetas con UTM utm_medium=postpurchase y campaña pp14', () => {
  const picks = pp.recommend([khamrah], catalogue, {}, {});
  const m = pp.buildPostPurchaseEmail(ctx({ kind: 'followup', bought: [{ p: khamrah, type: 'full' }], picks }));
  assert.strictEqual(m.campaign, 'pp14');
  assert.ok((m.bodyHtml.match(/utm_medium=postpurchase&amp;utm_campaign=pp14/g) || []).length >= picks.length);
});
t('recompra de un decant: ofrece el frasco completo y calcula el precio por ml solo con datos del catálogo', () => {
  const k = { ...khamrah, price: 60, decantPrice: 15 };
  const picks = pp.recommend([k], catalogue, {}, {});
  const m = pp.buildPostPurchaseEmail(ctx({ kind: 'reorder', bought: [{ p: k, type: 'decant' }], picks }));
  assert.ok(/ahora en frasco/.test(m.bodyHtml) && /\$0\.60 por ml/.test(m.bodyHtml) && /decant de 10 ml \(\$15\) a \$1\.50/.test(m.bodyHtml), m.bodyHtml.slice(0, 600));
});
t('recompra de un frasco: "para alternar", sin ofrecer el mismo frasco', () => {
  const picks = pp.recommend([khamrah], catalogue, {}, {});
  const m = pp.buildPostPurchaseEmail(ctx({ kind: 'reorder', bought: [{ p: khamrah, type: 'full' }], picks }));
  assert.ok(/Para alternar/.test(m.subject) && !/ahora en frasco/.test(m.bodyHtml));
});
t('la incorporación reciente respeta género y rango de precio', () => {
  const caro = P('Marca', 'Edición cara', 'F', ['Floral'], ['Rosa'], { price: 200 });
  const nuevoHombre = P('Marca', 'Nuevo hombre', 'M', ['Cítrico'], ['Limón'], { price: 55 });
  const cat2 = [...catalogue, nuevoHombre, caro];
  const n = pp.newestAvailable(cat2, {}, new Set(), [manIce], {});
  assert.strictEqual(n.id, nuevoHombre.id);
});

console.log(`\n${passed} pruebas pasaron`);
