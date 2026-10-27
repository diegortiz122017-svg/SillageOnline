'use strict';

// Imagen de vista previa (og:image) de una colección curada: la misma portada que ve quien abre la
// página de la colección (etiqueta "COLECCIÓN", nombre en Cormorant, frase en Jost, sobre el crema de
// la tienda), 1200x630. Se dibuja como SVG y se convierte a PNG con @resvg/resvg-js, que trae sus
// binarios ya compilados. Si la librería o las fuentes faltan, renderCollectionPng() devuelve null y
// quien llama usa el collage de fotos: la vista previa nunca queda sin imagen.

const path = require('path');
const crypto = require('crypto');

const W = 1200, H = 630;
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = ['CormorantGaramond_300Light.ttf', 'Jost_300Light.ttf', 'Jost_400Regular.ttf'].map(f => path.join(FONT_DIR, f));
const C = { bg: '#faf8f4', gold: '#b8955a', ink: '#1a1714', muted: '#8a7f72' };   // paleta de tienda.html

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

// Ancho aproximado de un texto (en em) para decidir tamaños y cortes de línea. Son medias de las
// fuentes usadas, con un pequeño margen: mejor quedar un poco corto que desbordar el lienzo.
const EM_TITLE = 0.5, EM_TAG = 0.53;

// Parte `text` en como máximo `maxLines` líneas de `maxChars` caracteres; null si no cabe.
function wrap(text, maxChars, maxLines) {
  const words = text.split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (next.length <= maxChars) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (cur.length > maxChars) return null;        // una sola palabra más ancha que la línea
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

// Nombre: lo más grande que quepa en una línea (hasta 150 px); si no, en dos líneas más chicas.
function layoutTitle(name) {
  const maxW = 1000;
  for (const size of [150, 132, 116, 102]) {
    const lines = wrap(name, Math.floor(maxW / (size * EM_TITLE)), 1);
    if (lines) return { size, lines };
  }
  for (const size of [100, 88, 76]) {
    const lines = wrap(name, Math.floor(maxW / (size * EM_TITLE)), 2);
    if (lines) return { size, lines };
  }
  // Nombre desmesurado: dos líneas pequeñas, cortado con puntos suspensivos.
  const size = 70, max = Math.floor(maxW / (size * EM_TITLE));
  const cut = name.slice(0, max * 2 - 3).replace(/\s+\S*$/, '').trim() + '…';
  return { size, lines: wrap(cut, max, 2) || [cut.slice(0, max)] };
}

function layoutTagline(text) {
  if (!text) return [];
  const max = Math.floor(900 / (30 * EM_TAG));
  const lines = wrap(text, max, 2);
  if (lines) return lines;
  const cut = text.slice(0, max * 2 - 2).replace(/\s+\S*$/, '').trim() + '…';
  return wrap(cut, max, 2) || [cut.slice(0, max)];
}

// SVG de la portada. Pura: no toca disco ni red.
function collectionCardSvg({ name, tagline }) {
  const title = layoutTitle(clean(name) || 'Colección');
  const tag = layoutTagline(clean(tagline));
  const LH = Math.round(title.size * 1.02), TAG_LH = 46;

  // Posiciones relativas al borde superior del bloque (línea base de cada texto); luego se centra todo.
  const eyebrowY = 18;
  let y = eyebrowY + 36 + Math.round(title.size * 0.74);
  const titleYs = title.lines.map((_, i) => y + i * LH);
  y = titleYs[titleYs.length - 1];
  let dividerY = null, tagYs = [];
  if (tag.length) {
    dividerY = y + Math.round(title.size * 0.3) + 20;
    tagYs = tag.map((_, i) => dividerY + 52 + i * TAG_LH);
    y = tagYs[tagYs.length - 1];
  }
  const blockH = y + 8;
  const top = Math.round((H - 70 - blockH) / 2) + 18;   // el pie ocupa la franja de abajo: se centra por encima de él

  const eyebrowSp = 9, footSp = 10;
  const parts = [
    `<text x="${W / 2 + eyebrowSp / 2}" y="${top + eyebrowY}" text-anchor="middle" font-family="Jost" font-weight="400" font-size="22" letter-spacing="${eyebrowSp}" fill="${C.gold}">COLECCIÓN</text>`,
    ...title.lines.map((line, i) => `<text x="${W / 2}" y="${top + titleYs[i]}" text-anchor="middle" font-family="Cormorant Garamond" font-weight="300" font-size="${title.size}" fill="${C.ink}">${esc(line)}</text>`),
  ];
  if (tag.length) {
    parts.push(`<rect x="${W / 2 - 30}" y="${top + dividerY}" width="60" height="1.5" fill="${C.gold}" opacity="0.7"/>`);
    tag.forEach((line, i) => parts.push(`<text x="${W / 2}" y="${top + tagYs[i]}" text-anchor="middle" font-family="Jost" font-weight="300" font-size="30" fill="${C.muted}">${esc(line)}</text>`));
  }
  parts.push(`<text x="${W / 2 + footSp / 2}" y="${H - 58}" text-anchor="middle" font-family="Jost" font-weight="400" font-size="17" letter-spacing="${footSp}" fill="${C.gold}">SILLAGE  PARFUMERIE</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect x="28" y="28" width="${W - 56}" height="${H - 56}" fill="none" stroke="${C.gold}" stroke-opacity="0.35" stroke-width="1.5"/>
${parts.join('\n')}
</svg>`;
}

// Huella corta del contenido: va en la URL de la imagen (?v=…) para que, si cambia el nombre o la frase,
// WhatsApp/Facebook vuelvan a descargarla en lugar de mostrar la anterior.
function cardVersion({ name, tagline }) {
  return crypto.createHash('sha1').update(clean(name) + '\n' + clean(tagline)).digest('hex').slice(0, 8);
}

let _Resvg;                                              // undefined = sin intentar · null = no disponible
function loadResvg() {
  if (_Resvg !== undefined) return _Resvg;
  try {
    const fs = require('fs');
    if (!FONT_FILES.every(f => fs.existsSync(f))) throw new Error('faltan fuentes en assets/fonts');
    _Resvg = require('@resvg/resvg-js').Resvg;
  } catch (e) {
    console.warn('collectionimg: imagen de colección no disponible (' + e.message + ')');
    _Resvg = null;
  }
  return _Resvg;
}
const available = () => !!loadResvg();

const cache = new Map();                                 // version → Buffer (pocas colecciones; tope por si acaso)
function renderCollectionPng(opts) {
  const R = loadResvg();
  if (!R) return null;
  const key = cardVersion(opts);
  if (cache.has(key)) return cache.get(key);
  try {
    const png = new R(collectionCardSvg(opts), {
      font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Jost' },
      fitTo: { mode: 'original' },
    }).render().asPng();
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, png);
    return png;
  } catch (e) {
    console.warn('collectionimg: no se pudo dibujar la imagen (' + e.message + ')');
    return null;
  }
}

module.exports = { collectionCardSvg, renderCollectionPng, cardVersion, available };
