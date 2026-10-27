'use strict';
// Pruebas del collage de vista previa de bundles. Ejecutar:  node tests/shareimg.test.js
const assert = require('assert');
const { parseCloudinary, bundleCollageUrl } = require('../services/shareimg');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  -', name); }
const B = 'https://res.cloudinary.com/sillage/image/upload/';

t('extrae el id público (con carpeta, versión y extensión)', () => {
  const p = parseCloudinary(B + 'v1712345/perfumes/khamrah.png');
  assert.strictEqual(p.publicId, 'perfumes/khamrah');
  assert.strictEqual(p.layerId, 'perfumes:khamrah');   // en superposiciones "/" se escribe ":"
});
t('ignora transformaciones ya presentes en la URL', () => {
  assert.strictEqual(parseCloudinary(B + 'w_400,c_limit,q_auto/v9/perfumes/khamrah.jpg').publicId, 'perfumes/khamrah');
});
t('una URL que no es de Cloudinary no se procesa', () => {
  assert.strictEqual(parseCloudinary('https://sillage-sv.com/img/a.png'), null);
  assert.strictEqual(parseCloudinary(''), null);
  assert.strictEqual(parseCloudinary(undefined), null);
});
t('un id con caracteres raros se descarta en vez de romper la imagen', () => {
  assert.strictEqual(parseCloudinary(B + 'v1/perfumes/ñandú (1).png'), null);
});

const A = B + 'v1/perfumes/a.png', Bb = B + 'v1/perfumes/b.png', C = B + 'v1/perfumes/c.png', D = B + 'v1/perfumes/d.png', E = B + 'v1/perfumes/e.png';
t('un collage de 2 reparte el lienzo 1200x630 en dos casilleros de 600', () => {
  const u = bundleCollageUrl([A, Bb]);
  assert.ok(u.startsWith(B) && u.endsWith('/perfumes/a'), u);
  assert.ok(/c_pad,w_1200,h_630,g_west/.test(u) && /l_perfumes:b\//.test(u) && /x_600/.test(u) && /f_jpg/.test(u), u);
});
t('3 y 4 perfumes: casilleros de 400 y 300 px', () => {
  assert.ok(/x_400/.test(bundleCollageUrl([A, Bb, C])) && /x_800/.test(bundleCollageUrl([A, Bb, C])));
  const u4 = bundleCollageUrl([A, Bb, C, D]);
  assert.ok(/x_300/.test(u4) && /x_600/.test(u4) && /x_900/.test(u4));
});
t('máximo 4 perfumes aunque el bundle tenga más', () => {
  const u = bundleCollageUrl([A, Bb, C, D, E]);
  assert.ok(!/perfumes:e/.test(u) && !/\/e$/.test(u));
});
t('el mismo perfume repetido (p. ej. dos decants) cuenta una sola vez', () => {
  assert.strictEqual(bundleCollageUrl([A, A]), null);
  assert.ok(bundleCollageUrl([A, A, Bb]).includes('l_perfumes:b'));
});
t('con menos de 2 fotos utilizables devuelve null (quien llama usa la foto de un perfume)', () => {
  assert.strictEqual(bundleCollageUrl([A]), null);
  assert.strictEqual(bundleCollageUrl([A, 'https://otro.com/x.png']), null);
  assert.strictEqual(bundleCollageUrl([]), null);
  assert.strictEqual(bundleCollageUrl(undefined), null);
});
t('fotos de nubes distintas de Cloudinary no se mezclan', () => {
  assert.strictEqual(bundleCollageUrl([A, 'https://res.cloudinary.com/otra/image/upload/v1/x.png']), null);
});

console.log(`\n${passed} pruebas pasaron`);
