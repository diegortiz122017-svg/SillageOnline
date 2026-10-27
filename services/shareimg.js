'use strict';

// Imagen de vista previa (og:image) de un bundle: un collage 1200x630 con las fotos de los perfumes
// que incluye, armado por Cloudinary solo con la URL (transformaciones + superposiciones): no se
// guarda ningún archivo nuevo. Lógica PURA: si algo no cuadra devuelve null y quien llama cae a la
// foto de un perfume, para que la vista previa nunca quede rota.

const CLOUD_RE = /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/;
const TRANSFORM_SEG = /^[a-z]{1,3}_[^,/]+(,[a-z]{1,3}_[^,/]+)*$/;   // "w_400,c_limit,q_auto"

// https://res.cloudinary.com/<nube>/image/upload/[transformaciones/][v123/]carpeta/nombre.png
//   → { base, publicId: 'carpeta/nombre', layerId: 'carpeta:nombre' }
function parseCloudinary(url) {
  const m = CLOUD_RE.exec(String(url || ''));
  if (!m) return null;
  const segs = m[2].split('?')[0].split('/');
  let i = 0;
  while (i < segs.length - 1 && (/^v\d+$/.test(segs[i]) || TRANSFORM_SEG.test(segs[i]))) i++;
  const publicId = segs.slice(i).join('/').replace(/\.[a-z0-9]{2,5}$/i, '');
  // Solo caracteres seguros: un id raro en una superposición rompería toda la imagen.
  if (!publicId || !/^[A-Za-z0-9_\-./]+$/.test(publicId)) return null;
  return { base: m[1], publicId, layerId: publicId.replace(/\//g, ':') };
}

// photoUrls: una foto por perfume del bundle (en orden). Devuelve la URL del collage o null.
function bundleCollageUrl(photoUrls, opts) {
  const o = Object.assign({ w: 1200, h: 630, bg: 'f2ede4', max: 4 }, opts);
  const seen = new Set(), parsed = [];
  for (const u of photoUrls || []) {
    const p = parseCloudinary(u);
    if (!p || seen.has(p.publicId)) continue;       // el mismo perfume dos veces no se repite
    seen.add(p.publicId); parsed.push(p);
    if (parsed.length >= o.max) break;
  }
  if (parsed.length < 2) return null;
  if (parsed.some(p => p.base !== parsed[0].base)) return null;   // todas deben estar en la misma nube

  const n = parsed.length;
  const slot = Math.round(o.w / n);
  const fitW = Math.round(slot * 0.78), fitH = Math.round(o.h * 0.84);
  const bg = `b_rgb:${o.bg}`;
  // Cada perfume se encuadra en su casillero (slot x alto) con el fondo crema de la ficha.
  const cell = `c_fit,w_${fitW},h_${fitH}/c_pad,w_${slot},h_${o.h},${bg}`;
  // Base = primer perfume, pegado al borde izquierdo de un lienzo del tamaño final.
  let t = `${cell}/c_pad,w_${o.w},h_${o.h},g_west,${bg}`;
  for (let i = 1; i < n; i++) t += `/l_${parsed[i].layerId}/${cell}/fl_layer_apply,g_west,x_${i * slot}`;
  t += '/f_jpg,q_auto:good';
  return `${parsed[0].base}${t}/${parsed[0].publicId}`;
}

module.exports = { parseCloudinary, bundleCollageUrl };
