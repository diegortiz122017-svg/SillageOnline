'use strict';
// Pruebas de la portada de vista previa de colecciones. Ejecutar:  node tests/collectionimg.test.js
const assert = require('assert');
const { collectionCardSvg, renderCollectionPng, cardVersion, available } = require('../services/collectionimg');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }

t('el SVG lleva etiqueta, nombre y frase', () => {
  const svg = collectionCardSvg({ name: 'Para Regalar', tagline: 'Piezas que impresionan.' });
  assert.ok(svg.includes('COLECCIÓN') && svg.includes('Para Regalar') && svg.includes('Piezas que impresionan.'));
  assert.ok(svg.includes('width="1200"') && svg.includes('height="630"'));
});
t('sin frase no dibuja separador ni texto vacío', () => {
  const svg = collectionCardSvg({ name: 'Solo nombre', tagline: '' });
  assert.ok(!svg.includes('<rect x="570"'));
  assert.strictEqual((svg.match(/font-weight="300" font-size="30"/g) || []).length, 0);
});
t('escapa caracteres de marcado (un nombre no puede romper el SVG)', () => {
  const svg = collectionCardSvg({ name: 'A & <b>"B"</b>', tagline: "it's <x>" });
  assert.ok(!svg.includes('<b>') && !svg.includes('<x>'));
  assert.ok(svg.includes('A &amp; &lt;b&gt;'));
});
t('nombre largo: baja de tamaño, usa dos líneas y nunca más', () => {
  const short = collectionCardSvg({ name: 'La Oficina', tagline: '' });
  const long = collectionCardSvg({ name: 'Perfumes árabes para la temporada de lluvias', tagline: '' });
  const size = s => +/font-family="Cormorant Garamond" font-weight="300" font-size="(\d+)"/.exec(s)[1];
  assert.ok(size(long) < size(short));
  assert.ok((long.match(/Cormorant Garamond/g) || []).length <= 2);
  const huge = collectionCardSvg({ name: 'palabra '.repeat(40), tagline: 'frase '.repeat(60) });
  assert.ok((huge.match(/Cormorant Garamond/g) || []).length <= 2);
  assert.ok((huge.match(/font-size="30"/g) || []).length <= 2);
  assert.ok(huge.includes('…'));
});
t('una palabra interminable no rompe el cálculo', () => {
  assert.ok(collectionCardSvg({ name: 'x'.repeat(200), tagline: 'y'.repeat(300) }).startsWith('<svg'));
});
t('la huella cambia con el nombre o la frase, y no con espacios de más', () => {
  const a = cardVersion({ name: 'Para Regalar', tagline: 'x' });
  assert.notStrictEqual(a, cardVersion({ name: 'Para Regalar', tagline: 'y' }));
  assert.notStrictEqual(a, cardVersion({ name: 'Para regalar', tagline: 'x' }));
  assert.strictEqual(a, cardVersion({ name: ' Para   Regalar ', tagline: 'x' }));
  assert.strictEqual(cardVersion({ name: 'A', tagline: null }), cardVersion({ name: 'A', tagline: '' }));
});
if (available()) {
  t('el PNG es 1200x630 y se reutiliza de la caché', () => {
    const o = { name: 'Frescos & Cítricos', tagline: 'Abre una ventana. Energía inmediata.' };
    const png = renderCollectionPng(o);
    assert.strictEqual(png.slice(1, 4).toString(), 'PNG');
    assert.strictEqual(png.readUInt32BE(16), 1200);
    assert.strictEqual(png.readUInt32BE(20), 630);
    assert.strictEqual(renderCollectionPng(o), png);
  });
} else {
  t('sin @resvg/resvg-js devuelve null (el servidor cae al collage)', () => assert.strictEqual(renderCollectionPng({ name: 'x' }), null));
}

console.log(`\n${passed} pruebas pasaron`);
