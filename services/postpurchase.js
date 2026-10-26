'use strict';

// Seguimiento a quienes YA compraron: correo a los 14 días, de recompra a los 45 y de
// reactivación a los ~120. Lógica PURA (sin base de datos ni red): elige qué recomendar
// a partir de lo que la persona compró y arma el HTML. El envío, los horarios, los
// topes y las bajas viven en server.js (runPostPurchaseCron).
//
// Igual que services/nurture.js, cada razón sale de datos reales del catálogo (acordes,
// notas, estela, duración) mediante plantillas — un correo nunca afirma algo que el
// producto no tiene.

const nu = require('./nurture');
const { norm, esc, S, sameLine, available, decantOffered, effectivePrice, decantPrice,
  productCard, joinEs, displayNote, hoursEs, SILLAGE_ES, NOTE_ALIAS } = nu;

const DECANT_TYPES = ['decant', 'decant5', 'sample'];
const isDecantType = t => DECANT_TYPES.includes(String(t || '').toLowerCase());

// ── Representación de un perfume: acordes + notas normalizadas ───────────────
function noteTokens(p) {
  const out = new Set();
  [p.notes, p.top, p.mid, p.base].forEach(s => {
    String(s == null ? '' : s).split(',').forEach(raw => {
      let t = norm(raw).trim().replace(/^(madera de|acordes?( de)?)\s+/, '');
      if (!t) return;
      if (NOTE_ALIAS[t]) t = NOTE_ALIAS[t][0];          // vanilla → vainilla
      out.add(t);
    });
  });
  return out;
}
function chordMap(p) {   // acorde normalizado → etiqueta original ("Amaderado")
  const m = new Map();
  (p.chords || []).forEach(c => m.set(norm(c), c));
  return m;
}

// Peso por rareza: un acorde/nota que casi todos los perfumes tienen (p. ej. "Amaderado"
// o "almizcle") dice muy poco; uno raro dice mucho. df = en cuántos perfumes aparece.
function buildIndex(catalogue) {
  const N = catalogue.length || 1;
  const dfC = new Map(), dfN = new Map();
  const info = new Map();
  for (const p of catalogue) {
    const cm = chordMap(p), nt = noteTokens(p);
    info.set(p.id, { cm, nt });
    cm.forEach((_, c) => dfC.set(c, (dfC.get(c) || 0) + 1));
    nt.forEach(t => dfN.set(t, (dfN.get(t) || 0) + 1));
  }
  const idf = df => Math.max(0.15, Math.log((N + 1) / (df + 0.5)));
  return {
    N, info,
    wC: c => idf(dfC.get(c) || 0), wN: t => idf(dfN.get(t) || 0),
    commonChord: c => (dfC.get(c) || 0) / N > 0.45,    // demasiado común para dar una razón
  };
}

function weightedJaccard(a, b, w) {   // a, b: Set
  let inter = 0, union = 0;
  const seen = new Set();
  for (const k of a) { seen.add(k); const x = w(k); union += x; if (b.has(k)) inter += x; }
  for (const k of b) if (!seen.has(k)) union += w(k);
  return union ? inter / union : 0;
}

function similarity(idx, a, b) {
  const A = idx.info.get(a.id) || { cm: chordMap(a), nt: noteTokens(a) };
  const B = idx.info.get(b.id) || { cm: chordMap(b), nt: noteTokens(b) };
  const ch = weightedJaccard(new Set(A.cm.keys()), new Set(B.cm.keys()), idx.wC);
  const nt = weightedJaccard(A.nt, B.nt, idx.wN);
  return 0.6 * ch + 0.4 * nt;
}

// Lo que realmente comparten, para explicarlo: primero acordes poco comunes, luego notas.
function sharedLabels(idx, a, b) {
  const A = idx.info.get(a.id) || { cm: chordMap(a), nt: noteTokens(a) };
  const B = idx.info.get(b.id) || { cm: chordMap(b), nt: noteTokens(b) };
  const chords = [...A.cm.keys()].filter(c => B.cm.has(c) && !idx.commonChord(c) && c !== 'sensual')
    .sort((x, y) => idx.wC(y) - idx.wC(x)).map(c => A.cm.get(c).toLowerCase());
  const notes = [...A.nt].filter(t => B.nt.has(t)).sort((x, y) => idx.wN(y) - idx.wN(x)).map(displayNote);
  return { chords, notes };
}

// ── Recomendación a partir de lo comprado ────────────────────────────────────
// bought: [productos del catálogo]. Devuelve hasta `n` picks: las primeras "afines"
// (misma línea de aroma) y, si hay, una "otra dirección" (acorde principal distinto).
const MIN_SIMILAR = 0.18, MIN_DIFFERENT = 0.08;

function recommend(bought, catalogue, invMap, priceMap, opts) {
  const n = (opts && opts.n) || 3;
  const boughtList = (bought || []).filter(Boolean);
  if (!boughtList.length) return [];
  const idx = buildIndex(catalogue);
  const boughtIds = new Set(boughtList.map(b => Number(b.id)));
  const genders = new Set(boughtList.map(b => b.g).filter(g => g === 'M' || g === 'F'));
  const maxPrice = Math.max(...boughtList.map(b => effectivePrice(b, priceMap)));
  const primaries = new Set(boughtList.map(b => norm((b.chords || [])[0] || '')).filter(Boolean));

  const cands = [];
  for (const p of catalogue) {
    if (boughtIds.has(Number(p.id)) || !available(p, invMap)) continue;
    // Una versión hermana de lo comprado (Khamrah → Khamrah Qahwa) SÍ es una buena sugerencia:
    // "misma línea" solo se evita entre las propias sugerencias (ver brandOk).
    if (genders.size === 1 && p.g !== [...genders][0] && p.g !== 'U') continue;
    let best = null;
    const per = [];
    for (const b of boughtList) {
      const s = similarity(idx, b, p);
      per.push({ b, s });
      if (!best || s > best.s) best = { s, b };
    }
    let mult = 1;
    // Si todo lo comprado es unisex no sabemos para quién es: se prefieren los unisex y se
    // penaliza (sin descartar) lo marcado solo hombre o mujer.
    if (!genders.size && p.g !== 'U') mult *= 0.7;
    if (maxPrice && effectivePrice(p, priceMap) > maxPrice * 1.5) mult *= 0.8;   // mucho más caro: menos probable
    cands.push({ p, score: best.s * mult, via: best.b, shared: sharedLabels(idx, best.b, p),
      per: per.map(x => ({ b: x.b, score: x.s * mult })) });
  }
  cands.sort((a, b) => b.score - a.score);

  const brandCount = new Map();
  const picks = [];
  const take = (c, kind) => {
    brandCount.set(c.p.brand, (brandCount.get(c.p.brand) || 0) + 1);
    picks.push({ ...c, kind });
  };
  const brandOk = c => (brandCount.get(c.p.brand) || 0) < 2 && !picks.some(x => sameLine(x.p, c.p));

  // Con 3 o más perfumes comprados no hay lugar para "otra dirección": cada sugerencia sale de uno distinto.
  const wantDifferent = n >= 3 && boughtList.length < 3;
  const similarTarget = wantDifferent ? n - 1 : n;
  // Una sugerencia por cada perfume comprado, por turnos: así uno solo no acapara todas
  // (quien compró Khamrah y Man Ice recibe algo dulce Y algo fresco, no tres frescos).
  const lists = boughtList.map(b => ({
    b, list: cands.map(c => ({ c, s: c.per.find(x => x.b === b).score })).sort((x, y) => y.s - x.s),
  }));
  for (let progress = true; picks.length < similarTarget && progress;) {
    progress = false;
    for (const { b, list } of lists) {
      if (picks.length >= similarTarget) break;
      const hit = list.find(x => x.s >= MIN_SIMILAR && !picks.some(pk => pk.p.id === x.c.p.id) && brandOk(x.c));
      if (hit) {
        take({ ...hit.c, score: hit.s, via: b, shared: b === hit.c.via ? hit.c.shared : sharedLabels(idx, b, hit.c.p) }, 'similar');
        progress = true;
      }
    }
  }
  if (wantDifferent) {
    const diff = cands.find(c => !picks.some(x => x.p.id === c.p.id) && brandOk(c) && c.score >= MIN_DIFFERENT &&
      (c.p.chords || []).length && !primaries.has(norm(c.p.chords[0])) && (c.shared.chords.length || c.shared.notes.length));
    if (diff) take(diff, 'different');
  }
  for (const c of cands) {                      // completa si faltó alguno
    if (picks.length >= n) break;
    if (!picks.some(x => x.p.id === c.p.id) && c.score >= MIN_DIFFERENT && brandOk(c)) take(c, 'similar');
  }
  return picks.map(pk => ({ ...pk, reason: reasonFor(pk) }));
}

function lcFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

function reasonFor(pk) {
  const { p, via, shared, kind } = pk;
  const sh = joinEs([...shared.chords.slice(0, 2), ...shared.notes.slice(0, 2)].slice(0, 3));
  const tail = [SILLAGE_ES[norm(p.sillage)], hoursEs(p)].filter(Boolean).join(', ');
  let head;
  if (kind === 'different') {
    const prim = (p.chords || [])[0];
    const rest = [...shared.chords.filter(c => c !== (prim || '').toLowerCase()), ...shared.notes].slice(0, 2);
    head = `Otra dirección${prim ? ': ' + prim.toLowerCase() : ''}${rest.length ? `, pero comparte ${joinEs(rest)} con ${via.name}` : ''}`;
  } else {
    head = sh ? `Comparte ${sh} con ${via.name}` : `Del mismo estilo que ${via.name}`;
  }
  return head + (tail ? '; ' + lcFirst(tail) : '') + '.';
}

// Una incorporación reciente: el perfume con id más alto (se asignan en orden de alta) que esté
// disponible, no sea ya uno de los picks y le calce a quien compró (género y rango de precio).
function newestAvailable(catalogue, invMap, excludeIds, bought, priceMap) {
  const boughtList = (bought || []).filter(Boolean);
  const genders = new Set(boughtList.map(b => b.g).filter(g => g === 'M' || g === 'F'));
  const maxPrice = boughtList.length ? Math.max(...boughtList.map(b => effectivePrice(b, priceMap))) : 0;
  let best = null;
  for (const p of catalogue) {
    if (excludeIds.has(Number(p.id)) || !available(p, invMap)) continue;
    if (genders.size === 1 && p.g !== [...genders][0] && p.g !== 'U') continue;
    if (maxPrice && effectivePrice(p, priceMap) > maxPrice * 1.6) continue;
    if (!best || Number(p.id) > Number(best.id)) best = p;
  }
  return best;
}

// ── Correos ───────────────────────────────────────────────────────────────────
function mlOf(p) { const m = String(p.size || '').match(/(\d+)\s*ml/i); return m ? parseInt(m[1], 10) : 0; }
const money = x => '$' + (Math.round(x * 100) / 100).toFixed(2).replace(/\.00$/, '');

// Frasco completo de un perfume que la persona compró en decant: sin inventar ahorros,
// solo el precio por ml del catálogo si de verdad es menor.
function bottleReason(p, ctx) {
  const ep = effectivePrice(p, ctx.priceMap), ml = mlOf(p);
  if (!ml) return `Ya conoces su aroma. Frasco completo: ${money(ep)}.`;
  if (!decantOffered(p, ctx)) return `Ya conoces su aroma. Frasco de ${ml} ml: ${money(ep)}.`;
  const dp = decantPrice(p, ctx.priceMap), perBottle = ep / ml, perDecant = dp / 10;
  return perDecant > perBottle * 1.4
    ? `Ya conoces su aroma. El frasco de ${ml} ml (${money(ep)}) sale a ${money(perBottle)} por ml; el decant de 10 ml (${money(dp)}) a ${money(perDecant)}.`
    : `Ya conoces su aroma. Frasco de ${ml} ml: ${money(ep)}.`;
}

function joinNames(list) { return joinEs(list.map(p => p.name)); }

// Frase fija (no la escribe la IA) que explica POR QUÉ aparecen las recomendaciones y cuántas son.
function leadIn(names, picks, multi) {
  const n = picks.length;
  const count = { 1: 'una fragancia', 2: 'dos fragancias', 3: 'tres fragancias' }[n] || `${n} fragancias`;
  const diff = picks.some(pk => pk.kind === 'different');
  return `<p style="${S.p}">Como compraste ${esc(names)}, Nez eligió ${count} que van con ${multi ? 'lo que te llevaste' : 'ese gusto'}${diff ? ' (una va por otra dirección, por si quieres variar)' : ''}. Debajo de cada una te contamos con cuál de tus perfumes se parece y en qué:</p>`;
}
// Cierre según cuántas tarjetas hay de verdad.
function closingLine(picks, ctx) {
  if (picks.some(pk => decantOffered(pk.p, ctx))) return 'Si dudas, un decant te deja probar antes de comprar el frasco.';
  return picks.length === 1 ? 'Si tienes dudas, cuéntale a Nez y te ayuda a decidir.' : 'Si dudas entre ellas, cuéntale a Nez y te ayuda a decidir.';
}

// ctx: { kind:'followup'|'reorder'|'winback', firstName, bought:[{p,type}], picks, noteHtml?,
//        newArrival?, decantsEnabled, decantOut, priceMap, catalogue, invMap }
function buildPostPurchaseEmail(ctx) {
  const { kind, firstName } = ctx;
  const bought = (ctx.bought || []).filter(b => b && b.p);
  const names = joinNames(bought.map(b => b.p));
  const first = bought[0] && bought[0].p;
  const decantBought = bought.filter(b => isDecantType(b.type)).map(b => b.p);
  const hello = firstName ? `Hola ${esc(firstName)},` : 'Hola,';
  const campaign = kind === 'followup' ? 'pp14' : kind === 'reorder' ? 'pp45' : 'pp120';
  const med = 'postpurchase';
  const card = (p, why) => productCard(p, why, campaign, ctx, med);
  const nezQ = bought.length
    ? `Compré ${bought.map(b => b.p.brand + ' ' + b.p.name).slice(0, 2).join(' y ')} y quiero algo parecido, o distinto pero que me guste.`
    : 'Quiero que me ayudes a elegir mi próximo perfume.';
  const btn = label => `<a href="${esc(nu.nezUrl(campaign, nezQ, med))}" style="${S.btn}">${esc(label)}</a>`;
  let subject, body;

  if (kind === 'followup') {
    const picks = ctx.picks || [];
    const ideas = picks.length === 1 ? 'Una idea' : picks.length === 2 ? 'Dos ideas' : 'Tres ideas';
    subject = bought.length === 1 ? `¿Cómo te fue con ${first.name}? ${ideas} en la misma línea`
      : bought.length === 2 ? `¿Cómo te fue con ${names}? ${ideas} para seguir`
      : `¿Cómo te fue con tu pedido? ${ideas} para seguir`;
    const intro = ctx.noteHtml
      ? `<div style="border-left:3px solid #b8955a;padding:12px 16px;margin:0 0 20px;background:#faf8f4"><p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b8955a;margin:0 0 8px">Nez te escribe</p><p style="font-family:Georgia,serif;font-size:14px;color:#4a3f35;line-height:1.9;margin:0;font-style:italic">${ctx.noteHtml}</p></div>`
      : `<p style="${S.p}">Hace unas semanas recibiste ${esc(names)}. ¿Cómo te fue con ${bought.length === 1 ? 'él' : bought.length === 2 ? 'ambos' : 'ellos'}?</p>`;
    body = `<h2 style="${S.h}">Hola ${esc(firstName || '')}${firstName ? ' 👋' : ''}</h2>${intro}
      ${leadIn(names, picks, bought.length > 1)}
      ${picks.map(pk => card(pk.p, pk.reason)).join('')}
      <p style="${S.p}">${closingLine(picks, ctx)}</p>
      ${btn('Hablar con Nez')}`;
  } else if (kind === 'reorder') {
    const picks = ctx.picks || [];
    const bottle = decantBought.find(p => available(p, ctx.invMap) && mlOf(p) >= 30);
    if (bottle) {
      subject = `¿Ya se acaba tu decant de ${bottle.name}?`;
      body = `<h2 style="${S.h}">${esc(bottle.name)}, ahora en frasco</h2>
        <p style="${S.p}">${hello}</p>
        <p style="${S.p}">Hace unas semanas probaste ${esc(bottle.name)} en decant. Si te quedaste con ganas de más, esto es lo que sigue:</p>
        ${card(bottle, bottleReason(bottle, ctx))}
        ${picks.length ? `<p style="${S.p}">¿O prefieres probar algo distinto? Como probaste ${esc(bottle.name)}, estas ${picks.slice(0, 2).length === 1 ? 'es una opción' : 'son dos opciones'} que van con ese gusto:</p>${picks.slice(0, 2).map(pk => card(pk.p, pk.reason)).join('')}` : ''}
        ${btn('Pedirle ayuda a Nez')}`;
    } else {
      subject = bought.length === 1 ? `Para alternar con ${first.name}: ${picks.length === 1 ? 'una opción' : 'tres opciones'}` : 'Para alternar con tu pedido: tres opciones';
      body = `<h2 style="${S.h}">Para alternar con ${esc(first ? first.name : 'tu perfume')}</h2>
        <p style="${S.p}">${hello}</p>
        <p style="${S.p}">Quien usa un solo perfume suele querer otro para cambiar de aire.</p>
        ${leadIn(names, picks, bought.length > 1)}
        ${picks.map(pk => card(pk.p, pk.reason)).join('')}
        <p style="${S.p}">${closingLine(picks, ctx)}</p>
        ${btn('Hablar con Nez')}`;
    }
  } else {   // winback
    const picks = (ctx.picks || []).slice(0, 2);
    const extra = ctx.newArrival && !picks.some(x => x.p.id === ctx.newArrival.id) ? ctx.newArrival : null;
    subject = firstName ? `${firstName}, hace tiempo que no te vemos — esto sigue en stock` : 'Hace tiempo que no te vemos: fragancias que te pueden gustar';
    body = `<h2 style="${S.h}">Hace tiempo que no te vemos</h2>
      <p style="${S.p}">${hello}</p>
      <p style="${S.p}">${first ? `La última vez te llevaste ${esc(names)}. ` : ''}Por si quieres retomar, esto es lo que te recomendaría hoy.</p>
      ${picks.length ? leadIn(names, picks, bought.length > 1) : ''}
      ${picks.map(pk => card(pk.p, pk.reason)).join('')}
      ${extra ? `<p style="${S.p}">Y una de las últimas incorporaciones a la tienda, que va con tu rango de precio:</p>${card(extra, extra.tagline ? extra.tagline + '.' : (nu.notesLine(extra) || 'Novedad en la tienda.'))}` : ''}
      ${btn('Hablar con Nez')}`;
  }
  return { subject, bodyHtml: body, campaign };
}

module.exports = {
  recommend, buildPostPurchaseEmail, newestAvailable, isDecantType, similarity, buildIndex,
  MIN_SIMILAR, MIN_DIFFERENT,
};
