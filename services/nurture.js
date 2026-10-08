'use strict';

// Seguimiento por correo a clientes registrados que todavía no compran.
// Este módulo es lógica PURA (sin base de datos ni red): elige la variante del
// correo (A con perfil olfativo, B con señales de interés, C invitación a Nez),
// arma las recomendaciones y redacta el contenido. El envío, los horarios y los
// topes viven en server.js (runNurtureCron).
//
// Las razones por producto salen de PLANTILLAS a partir de datos reales del
// catálogo y del perfil — no de un modelo de lenguaje — para que un correo nunca
// afirme una nota, un precio o una duración que el producto no tiene.

const BASE = () => process.env.BASE_URL || 'https://sillage-sv.com';

// ── Utilidades ────────────────────────────────────────────────────────────────
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/pimi?enta rosa/g, 'pimienta');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function slugify(str) {
  return String(str).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}
function hasWord(text, w) {
  const safe = String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z])' + safe + '([^a-z]|$)').test(text);
}
function productText(p) { return norm([p.notes, p.top, p.mid, p.base].join(', ')); }
function chordList(p) { return (p.chords || []).map(norm); }

function effectivePrice(p, priceMap) {
  const pr = priceMap && priceMap[p.id];
  return (pr && pr.onSale && pr.salePrice) ? Math.round(+pr.salePrice) : parseFloat(p.price);
}
function decantPrice(p, priceMap) {
  return p.decantPrice ? parseFloat(p.decantPrice) : Math.round(effectivePrice(p, priceMap) * 0.30);
}
// El decant solo se ofrece si la venta de decants está activa (ajuste global) y
// a ese producto le quedan decants (decantOut = ids con stock 0 en decant_inventory).
function decantOffered(p, ctx) {
  return !!ctx.decantsEnabled && !(ctx.decantOut && ctx.decantOut.has(Number(p.id)));
}
function available(p, invMap) {
  return !(invMap && invMap[p.id] && invMap[p.id].outOfStock);
}
function productUrl(p, campaign) {
  return `${BASE()}/fragancia/${slugify(p.brand + '-' + p.name)}?utm_source=email&utm_medium=nurture&utm_campaign=${campaign}`;
}
function nezUrl(campaign, q) {
  return `${BASE()}/nez?utm_source=email&utm_medium=nurture&utm_campaign=${campaign}` +
    (q ? `&q=${encodeURIComponent(q)}` : '');
}

// ── Familias olfativas (vocabulario de Nez, en inglés) → acordes/notas del catálogo ─
const FAMILY_LABEL = {
  woody: 'amaderadas', floral: 'florales', oriental: 'orientales', citrus: 'cítricas',
  fresh: 'frescas', aquatic: 'acuáticas', gourmand: 'gourmand', chypre: 'chipre',
  fougere: 'fougère', spicy: 'especiadas', powdery: 'empolvadas', green: 'verdes',
};
const FAMILY_CHORDS = {
  woody: ['amaderado', 'terroso'], floral: ['floral', 'empolvado'],
  oriental: ['ambarado', 'oriental'], citrus: ['citrico'],
  fresh: ['fresco', 'aromatico', 'herbal'], aquatic: ['acuatico'],
  gourmand: ['gourmand', 'dulce'], chypre: ['terroso'], fougere: ['aromatico', 'herbal'],
  spicy: ['especiado'], powdery: ['empolvado'], green: ['herbal', 'verde'],
};
const FAMILY_NOTES = {
  woody: ['cedro', 'sandalo', 'vetiver', 'pachuli', 'oud', 'cachemira'],
  floral: ['rosa', 'jazmin', 'peonia', 'lirio', 'azahar', 'magnolia', 'violeta', 'iris'],
  oriental: ['ambar', 'incienso', 'vainilla', 'tonka', 'benjui', 'mirra', 'oud'],
  citrus: ['bergamota', 'limon', 'mandarina', 'naranja', 'pomelo', 'cidro'],
  fresh: ['menta', 'lavanda', 'salvia', 'manzana', 'melon', 'te verde'],
  aquatic: ['acuaticas', 'marino', 'agua de coco'],
  gourmand: ['vainilla', 'praline', 'caramelo', 'cafe', 'cacao', 'miel', 'tonka'],
  chypre: ['musgo de roble', 'pachuli', 'labdano'],
  fougere: ['lavanda', 'musgo de roble', 'cumarina'],
  spicy: ['canela', 'cardamomo', 'pimienta', 'jengibre', 'nuez moscada', 'clavo'],
  powdery: ['iris', 'heliotropo', 'almizcle blanco'],
  green: ['salvia', 'albahaca', 'hierba'],
};
// Nez guarda las notas del perfil en inglés; el catálogo está en español.
const NOTE_ALIAS = {
  vanilla: ['vainilla'], amber: ['ambar'], rose: ['rosa'], jasmine: ['jazmin'],
  musk: ['almizcle'], sandalwood: ['sandalo'], cedar: ['cedro'], lavender: ['lavanda'],
  bergamot: ['bergamota'], lemon: ['limon'], coffee: ['cafe'], caramel: ['caramelo'],
  cinnamon: ['canela'], tobacco: ['tabaco'], leather: ['cuero'], incense: ['incienso'],
  patchouli: ['pachuli'], saffron: ['azafran'], cardamom: ['cardamomo'], pepper: ['pimienta'],
  coconut: ['coco'], peach: ['durazno'], apple: ['manzana'], mint: ['menta'],
  grapefruit: ['pomelo'], orange: ['naranja'], mandarin: ['mandarina'], honey: ['miel'],
  chocolate: ['chocolate', 'cacao'], almond: ['almendra'], iris: ['iris'], oud: ['oud'],
  pear: ['pera'], fig: ['higo'], plum: ['ciruela'], rum: ['ron'], ginger: ['jengibre'],
};
// Forma de mostrar una nota: en español y con acento (norm() los quita para comparar).
const NOTE_DISPLAY = { ambar: 'ámbar', jazmin: 'jazmín', sandalo: 'sándalo', limon: 'limón', cafe: 'café',
  pachuli: 'pachulí', peonia: 'peonía', azafran: 'azafrán', benjui: 'benjuí', cipres: 'ciprés', melon: 'melón',
  almizcle: 'almizcle', te: 'té' };
function displayNote(t) {
  const es = (NOTE_ALIAS[t] || [t])[0];
  return NOTE_DISPLAY[es] || es;
}
const SILLAGE_ES = { light: 'proyección suave', moderate: 'proyección moderada', strong: 'proyección fuerte', 'very strong': 'proyección muy fuerte' };

function hoursEs(p) {
  const m = String(p.long || '').match(/\d+\+?/);
  return m ? `${m[0]} horas de duración` : '';
}

// ── Variante A: recomendaciones a partir del perfil ──────────────────────────
function hasUsefulProfile(profile) {
  return !!(profile && ((profile.families || []).length || (profile.notes || []).length));
}

function rankForProfile(profile, catalogue, invMap, priceMap) {
  const fams = (profile.families || []).map(norm).filter(Boolean);
  const noteTerms = (profile.notes || []).map(norm).filter(Boolean);
  const avoid = (profile.avoid || []).map(norm).filter(Boolean);
  const recommended = new Set((profile.recommended_ids || []).map(Number));
  const gender = String(profile.gender_pref || '').toUpperCase();
  const maxPrice = parseFloat(profile.price_max) || 0;
  const season = norm(profile.season || '');
  const intensity = norm(profile.intensity || '');

  const out = [];
  for (const p of catalogue) {
    if (!available(p, invMap)) continue;
    if ((gender === 'F' || gender === 'M') && p.g !== gender && p.g !== 'U') continue;
    const text = productText(p);
    if (avoid.some(a => hasWord(text, a) || (NOTE_ALIAS[a] || []).some(x => hasWord(text, x)))) continue;
    if (maxPrice && effectivePrice(p, priceMap) > maxPrice) continue;

    let score = 0;
    const chords = chordList(p);
    const famHits = [];
    fams.forEach((fam, idx) => {
      const byChord = (FAMILY_CHORDS[fam] || []).some(c => chords.includes(c));
      const byNotes = (FAMILY_NOTES[fam] || []).filter(n => hasWord(text, n)).length >= 2;
      if (byChord || byNotes) { score += Math.max(5 - idx, 2); famHits.push(fam); }
    });
    const noteHits = [];
    noteTerms.forEach(t => {
      const variants = [t].concat(NOTE_ALIAS[t] || []);
      const hit = variants.find(v => hasWord(text, v));
      if (hit) { score += 4; if (noteHits.length < 3) noteHits.push(displayNote(t)); }
    });
    const recommendedBefore = recommended.has(Number(p.id));
    if (recommendedBefore) score += 6;
    const pSeason = norm(p.season || '');
    if (season && season !== 'any' && season !== 'all') {
      if (pSeason.includes(season)) score += 2; else if (pSeason.includes('all')) score += 1;
    }
    if (intensity && norm(p.sillage) === intensity) score += 2;

    out.push({ p, score, famHits, noteHits, recommendedBefore });
  }
  return out.sort((a, b) => b.score - a.score);
}

function sameLine(a, b) { // "Khamrah" y "Khamrah Qahwa" no deben salir juntos
  return a.brand === b.brand && norm(a.name).split(' ')[0] === norm(b.name).split(' ')[0];
}

function pickForProfile(profile, catalogue, invMap, priceMap, n = 3) {
  const picks = [];
  for (const r of rankForProfile(profile, catalogue, invMap, priceMap)) {
    if (r.score < 5) break;
    if (picks.some(x => sameLine(x.p, r.p))) continue;
    picks.push(r);
    if (picks.length >= n) break;
  }
  return picks;
}

function joinEs(list) {
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + ' y ' + list[list.length - 1];
}

function reasonForPick(r) {
  const parts = [];
  if (r.recommendedBefore) parts.push('Nez ya te la había recomendado');
  if (r.famHits.length) parts.push(`va con tu gusto por las fragancias ${joinEs(r.famHits.slice(0, 2).map(f => FAMILY_LABEL[f] || f))}`);
  if (r.noteHits.length) parts.push(`lleva ${joinEs(r.noteHits.slice(0, 2))}`);
  const tail = [SILLAGE_ES[norm(r.p.sillage)], hoursEs(r.p)].filter(Boolean).join(', ');
  if (tail) parts.push(tail);
  const s = parts.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// ── Variante B: señales de interés (carrito, favoritos, vistos) ──────────────
function pickSignalProducts(signals, catalogue, invMap, max = 2) {
  const byId = new Map(catalogue.map(p => [Number(p.id), p]));
  const out = [];
  const seen = new Set();
  const add = (ids, source) => {
    for (const id of ids || []) {
      const p = byId.get(Number(id));
      if (!p || seen.has(p.id) || !available(p, invMap)) continue;
      if (out.some(x => sameLine(x.p, p))) continue;
      seen.add(p.id); out.push({ p, source });
      if (out.length >= max) return;
    }
  };
  add(signals.cartIds, 'cart'); if (out.length < max) add(signals.favIds, 'fav'); if (out.length < max) add(signals.viewIds, 'view');
  return out;
}

function findSimilar(base, catalogue, invMap, priceMap, excludeIds) {
  const bc = new Set(chordList(base));
  const bOrig = new Map((base.chords || []).map(c => [norm(c), c]));
  const bp = effectivePrice(base, priceMap);
  let best = null;
  for (const p of catalogue) {
    if (p.id === base.id || excludeIds.has(p.id) || !available(p, invMap)) continue;
    if (sameLine(base, p)) continue;
    if (!(p.g === base.g || p.g === 'U' || base.g === 'U')) continue;
    const price = effectivePrice(p, priceMap);
    if (bp && Math.abs(price - bp) / bp > 0.4) continue;
    const pc = new Set(chordList(p));
    const inter = [...bc].filter(x => pc.has(x));
    const union = new Set([...bc, ...pc]).size || 1;
    const score = (inter.length / union) * 10 + (p.brand === base.brand ? 1 : 0);
    if (score >= 3 && (!best || score > best.score)) best = { p, score, shared: inter.filter(x => x !== 'sensual').map(x => (bOrig.get(x) || x).toLowerCase()).slice(0, 3) };
  }
  return best;
}

const SOURCE_ES = { cart: 'Lo dejaste en tu carrito', fav: 'Lo guardaste en favoritos', view: 'Lo estuviste mirando' };

// ── Elección de variante ──────────────────────────────────────────────────────
function chooseNurture({ profile, signals, catalogue, invMap, priceMap }) {
  if (hasUsefulProfile(profile)) {
    const picks = pickForProfile(profile, catalogue, invMap, priceMap);
    if (picks.length >= 2) return { variant: 'A', picks, profile };
  }
  const main = pickSignalProducts(signals || {}, catalogue, invMap);
  if (main.length) {
    const similar = findSimilar(main[0].p, catalogue, invMap, priceMap, new Set(main.map(m => m.p.id)));
    return { variant: 'B', main, similar };
  }
  return { variant: 'C' };
}

// ── HTML del correo ───────────────────────────────────────────────────────────
const S = {
  h: 'font-family:Georgia,serif;font-size:22px;font-weight:300;color:#1a1714;margin:0 0 14px',
  p: 'font-size:13px;color:#6b6258;line-height:1.8;margin:0 0 16px',
  card: 'border:1px solid #e8d8b8;background:#faf8f4;margin:0 0 12px',
  brand: 'font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#b8955a',
  name: 'font-family:Georgia,serif;font-size:18px;color:#1a1714;text-decoration:none',
  small: 'font-size:12px;color:#6b6258;line-height:1.7;margin:6px 0 0',
  price: 'font-size:12px;color:#1a1714;margin:8px 0 0',
  btn: 'display:inline-block;padding:12px 26px;border:1px solid #b8955a;color:#b8955a;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;margin:4px 6px 4px 0',
};

function thumb(p) {
  const u = p.photos && p.photos[0];
  if (!u) return '';
  const src = u.indexOf('res.cloudinary.com') !== -1 ? u.replace('/upload/', '/upload/w_200,c_limit,q_auto:good/') : u;
  return `<td width="84" style="padding:12px 0 12px 12px;vertical-align:top"><img src="${esc(src)}" width="72" alt="${esc(p.brand + ' ' + p.name)}" style="display:block;max-width:72px;height:auto;border:0"/></td>`;
}

function productCard(p, why, campaign, ctx) {
  const ep = effectivePrice(p, ctx.priceMap);
  const priceLine = decantOffered(p, ctx)
    ? `Frasco $${ep} &nbsp;·&nbsp; <strong>Decant 10 ml $${decantPrice(p, ctx.priceMap)}</strong>`
    : `Frasco $${ep}`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="${S.card}"><tr>${thumb(p)}
    <td style="padding:12px 14px;vertical-align:top">
      <div style="${S.brand}">${esc(p.brand)}</div>
      <a href="${esc(productUrl(p, campaign))}" style="${S.name}">${esc(p.name)}</a>
      <div style="${S.small}">${esc(why)}</div>
      <div style="${S.price}">${priceLine}</div>
    </td></tr></table>`;
}

function couponBlock(code, expires) {
  if (!code) return '';
  const when = expires
    ? new Date(expires).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', timeZone: 'America/El_Salvador' })
    : '';
  return `<div style="border:1px dashed #b8955a;padding:14px 16px;margin:18px 0;text-align:center">
    <div style="${S.brand}">Envío gratis en tu primer pedido</div>
    <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:3px;color:#1a1714;margin:6px 0">${esc(code)}</div>
    <div style="font-size:11px;color:#6b6258">Un solo uso${when ? ' · vence el ' + esc(when) : ''}. Aplícalo en el paso de pago.</div>
  </div>`;
}

function minDecant(catalogue, invMap, priceMap, decantOut) {
  const prices = catalogue.filter(p => available(p, invMap) && !(decantOut && decantOut.has(Number(p.id))))
    .map(p => decantPrice(p, priceMap)).filter(x => x > 0);
  return prices.length ? Math.min(...prices) : 0;
}

const OCCASIONS = [
  { label: 'Para la oficina', q: 'Busco un perfume para la oficina: discreto y limpio, que no sature.' },
  { label: 'Para una primera cita', q: 'Busco un perfume para una primera cita: suave y que invite a acercarse.' },
  { label: 'Para regalar', q: 'Quiero regalar un perfume y no sé cuál elegir.' },
];

// ctx: { step, choice, firstName, code, codeExpires, decantsEnabled, priceMap, catalogue, invMap }
function buildNurtureEmail(ctx) {
  const { step, choice, firstName } = ctx;
  const v = choice.variant;
  const campaign = `${v}${step}`;
  const hello = firstName ? `Hola ${esc(firstName)},` : 'Hola,';
  const coupon = step === 2 ? couponBlock(ctx.code, ctx.codeExpires) : '';
  let subject, body;

  if (v === 'A') {
    const prof = choice.profile || {};
    const recall = [];
    const fl = (prof.families || []).map(f => FAMILY_LABEL[norm(f)]).filter(Boolean).slice(0, 2);
    if (fl.length) recall.push(`fragancias ${joinEs(fl)}`);
    const nt = (prof.notes || []).map(norm).map(displayNote).slice(0, 3);
    if (nt.length) recall.push(`notas como ${joinEs(nt)}`);
    const n = choice.picks.length;
    const nWord = n === 2 ? 'Dos' : 'Tres';
    const anyDecant = choice.picks.some(r => decantOffered(r.p, ctx));
    // Encabezado específico: usa lo que la persona le dijo a Nez (familias o notas).
    const what = fl.length ? `fragancias ${joinEs(fl)}` : (nt.length ? `opciones con ${joinEs(nt.slice(0, 2))}` : 'opciones');
    const heading = step === 1
      ? `${nWord} ${what}${fl.length ? ' que siguen en stock' : ''}`
      : `Siguen disponibles: ${nWord.toLowerCase()} ${what}`;
    subject = step === 1 ? `Nez guardó ${n} opciones que van contigo`
      : `Tus ${n} opciones siguen disponibles — y el envío del primer pedido va por nuestra cuenta`;
    body = `<h2 style="${S.h}">${esc(heading)}</h2>
      <p style="${S.p}">${hello}</p>
      <p style="${S.p}">Nez recuerda lo que le contaste${recall.length ? ': ' + esc(joinEs(recall)) : ''}. Con eso, estas ${choice.picks.length} están en stock ahora mismo:</p>
      ${choice.picks.map(r => productCard(r.p, reasonForPick(r), campaign, ctx)).join('')}
      <p style="${S.p}">${anyDecant ? 'Si dudas entre dos, el decant te deja probar antes de comprar el frasco.' : 'Si dudas entre dos, cuéntale a Nez y te ayuda a decidir.'}</p>
      ${coupon}
      <a href="${esc(nezUrl(campaign))}" style="${S.btn}">Seguir con Nez</a>`;
  } else if (v === 'B') {
    const m = choice.main;
    const first = m[0].p;
    subject = step === 1
      ? (decantOffered(first, ctx) ? `${first.name}: ¿lo pruebas en decant antes de decidir?` : `Lo que estabas mirando: ${first.name}`)
      : `${first.name} sigue disponible — y el envío del primer pedido va por nuestra cuenta`;
    const sim = choice.similar;
    const cmpQ = sim ? `Estoy dudando entre ${first.brand} ${first.name} y ${sim.p.brand} ${sim.p.name}. ¿Cuál me conviene?`
      : `Me interesa ${first.brand} ${first.name}. ¿Qué me recomiendas parecido?`;
    body = `<h2 style="${S.h}">${esc(first.name)} sigue disponible</h2>
      <p style="${S.p}">${hello}</p>
      <p style="${S.p}">${decantOffered(first, ctx) ? 'Un frasco completo es una compra a ciegas; el decant no.' : 'Esto es lo que dejaste pendiente.'}</p>
      ${m.map(x => productCard(x.p, SOURCE_ES[x.source] + '.', campaign, ctx)).join('')}
      ${sim ? `<p style="${S.p}">Si quieres comparar con algo parecido:</p>
        ${productCard(sim.p, sim.shared.length ? `Comparte lo ${joinEs(sim.shared.slice(0, 3))} de ${first.name} y está en un precio similar.` : `Es del mismo estilo que ${first.name} y está en un precio similar.`, campaign, ctx)}` : ''}
      ${coupon}
      <a href="${esc(nezUrl(campaign, cmpQ))}" style="${S.btn}">${sim ? 'Preguntarle a Nez cuál va mejor' : 'Preguntarle a Nez'}</a>`;
  } else {
    const md = minDecant(ctx.catalogue || [], ctx.invMap, ctx.priceMap, ctx.decantOut);
    subject = step === 1 ? 'Dime una ocasión y te doy tres opciones'
      : 'Todavía sin elegir — el envío del primer pedido va por nuestra cuenta';
    body = `<h2 style="${S.h}">Dime una ocasión y una nota que te guste</h2>
      <p style="${S.p}">${hello}</p>
      <p style="${S.p}">Creaste tu cuenta pero todavía no le has preguntado nada a Nez. Es simple: me dices para qué es y qué te gusta, y en un minuto te devuelvo tres opciones del catálogo que sí están en stock.</p>
      <p style="${S.p}">Empieza por una de estas:</p>
      <div>${OCCASIONS.map(o => `<a href="${esc(nezUrl(campaign, o.q))}" style="${S.btn}">${esc(o.label)}</a>`).join('')}</div>
      ${md && ctx.decantsEnabled ? `<p style="${S.p}">Sin compromiso: probar una fragancia en decant cuesta desde $${md}.</p>` : ''}
      ${coupon}`;
  }
  return { subject, bodyHtml: body, variant: v };
}

module.exports = {
  norm, slugify, esc, effectivePrice, decantPrice, hasUsefulProfile,
  rankForProfile, pickForProfile, pickSignalProducts, findSimilar,
  chooseNurture, buildNurtureEmail, reasonForPick, productUrl, nezUrl,
};
