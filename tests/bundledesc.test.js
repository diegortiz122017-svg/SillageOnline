'use strict';
// Pruebas de la descripción de bundles con IA. Ejecutar:  node tests/bundledesc.test.js
const assert = require('assert');
const { buildMessages, cleanDescription, planDescription, productFacts, MAX_LEN } = require('../services/bundledesc');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }

const cat = [
  { id: 1, brand: 'Lattafa', name: 'Khamrah', g: 'U', family: 'Gourmand', notes: 'Canela, Vainilla', sillage: 'Very Strong', season: 'Fall' },
  { id: 2, brand: 'Lacoste', name: 'Silver Grey', g: 'M', top: 'Bergamota' },
  { id: 3, brand: 'Coach', name: 'Dreams' },
];

t('el pedido lleva solo datos que existen y no repite perfumes', () => {
  const { messages, count } = buildMessages({ items: [{ productId: 1 }, { productId: '2' }, { productId: 1 }] }, cat);
  assert.strictEqual(count, 2);
  const u = messages[1].content;
  assert.ok(u.includes('Lattafa Khamrah | unisex | familia: Gourmand | notas: Canela, Vainilla | estela: Very Strong | temporada: Fall'));
  assert.ok(u.includes('Lacoste Silver Grey | para hombre | salida: Bergamota'));
  assert.ok(!/notas:.*notas:/.test(productFacts(cat[2])) && productFacts(cat[2]) === 'Coach Dreams');
  assert.strictEqual((u.match(/Khamrah/g) || []).length, 1);
});
t('un bundle sin perfumes en el catálogo no vale la pena enviarlo a la IA', () => {
  assert.strictEqual(buildMessages({ items: [{ productId: 99 }] }, cat).count, 0);
  assert.strictEqual(buildMessages({}, cat).count, 0);
});
t('las instrucciones prohíben precios, formato y autenticidad', () => {
  const s = buildMessages({ items: [{ productId: 1 }] }, cat).messages[0].content;
  assert.ok(/precios/.test(s) && /decant/.test(s) && /autenticidad/.test(s) && /originalidad/.test(s));
});

t('limpia comillas, negritas y la firma', () => {
  assert.strictEqual(cleanDescription('"**Dulces** y especiados para noches frías. — Nez"'), 'Dulces y especiados para noches frías.');
});
t('una respuesta larga se corta en una oración completa', () => {
  const long = 'Tres perfumes cálidos y especiados para el otoño. ' + 'Con mucha estela y una duración que se nota en la ropa durante todo el día y también durante la noche, sin esfuerzo alguno, incluso con calor. Y más.';
  const out = cleanDescription(long);
  assert.ok(out.length <= MAX_LEN, out.length);
  assert.strictEqual(out, 'Tres perfumes cálidos y especiados para el otoño.');
});
t('sin punto cercano, corta en palabra completa y cierra con punto', () => {
  const out = cleanDescription('palabra '.repeat(40));
  assert.ok(out.length <= MAX_LEN + 1 && out.endsWith('.') && !/\s\./.test(out));
});
t('descarta lo que no sirve: vacío, muy corto, con precio o enlace', () => {
  for (const bad of ['', '   ', 'Corto.', 'Un set muy completo por solo $45 este mes.', 'Mira sillage-sv.com y https://x.com para ver más cosas.', null, undefined]) {
    assert.strictEqual(cleanDescription(bad), '', String(bad));
  }
});

const items = [{ productId: 1, type: 'botella', size: '100ml' }];
t('bundle nuevo: sin descripción se genera; con texto se respeta', () => {
  assert.deepStrictEqual(planDescription(null, { description: '  ' }), { action: 'generate', ai: 1 });
  assert.deepStrictEqual(planDescription(null, {}), { action: 'generate', ai: 1 });
  assert.deepStrictEqual(planDescription(null, { description: ' Mi texto ' }), { action: 'set', description: 'Mi texto', ai: 0 });
});
t('editar: lo escrito a mano nunca se regenera, ni aunque cambien los perfumes', () => {
  const ex = { description: 'Texto mío', description_ai: 0, items };
  assert.strictEqual(planDescription(ex, { description: 'Texto mío', items: [{ productId: 2 }] }).action, 'keep');
  assert.strictEqual(planDescription(ex, { items: [{ productId: 2 }] }).action, 'keep');
});
t('editar: si la persona cambia el texto de la IA, pasa a ser suyo', () => {
  const ex = { description: 'Texto IA', description_ai: 1, items };
  assert.deepStrictEqual(planDescription(ex, { description: 'Texto IA editado' }), { action: 'set', description: 'Texto IA editado', ai: 0 });
});
t('editar: el texto de la IA se rehace solo si cambian los perfumes', () => {
  const ex = { description: 'Texto IA', description_ai: 1, items };
  assert.deepStrictEqual(planDescription(ex, { description: 'Texto IA', items }), { action: 'keep', ai: 1 });   // el admin lo reenvía igual
  assert.deepStrictEqual(planDescription(ex, { description: 'Texto IA', items: [{ productId: 2, type: 'botella', size: '100ml' }] }), { action: 'generate', ai: 1 });
  assert.deepStrictEqual(planDescription(ex, { items: [{ productId: 1, type: 'botella', size: '50ml' }] }), { action: 'generate', ai: 1 });
  assert.strictEqual(planDescription(ex, { price: 5 }).action, 'keep');
});
t('editar: borrar el texto pide uno nuevo a la IA', () => {
  assert.deepStrictEqual(planDescription({ description: 'Mío', description_ai: 0, items }, { description: '' }), { action: 'generate', ai: 1 });
});
t('editar: un bundle que seguía sin descripción se genera al cambiar sus perfumes', () => {
  assert.strictEqual(planDescription({ description: '', description_ai: 0, items }, { items: [{ productId: 2 }] }).action, 'generate');
  assert.strictEqual(planDescription({ description: '', description_ai: 0, items }, { active: false }).action, 'keep');
});

console.log(`\n${passed} pruebas pasaron`);
