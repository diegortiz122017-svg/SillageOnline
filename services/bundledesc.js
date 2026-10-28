'use strict';

// Descripción de un bundle redactada por IA cuando nadie la escribe a mano. Lógica PURA (sin red ni base
// de datos): arma el pedido a la IA con datos reales del catálogo, limpia lo que responde y decide cuándo
// hay que (re)generar. Quien llama (server.js) hace la llamada a OpenAI y guarda el resultado.

const MAX_LEN = 160;   // cabe en la vista previa al compartir (110 + precio) y en el modal sin cortes feos

const clean1 = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// Una línea con los datos reales de un perfume. Solo lo que existe: la IA no debe inventar notas.
function productFacts(p) {
  const bits = [
    `${p.brand} ${p.name}`,
    p.g === 'M' ? 'para hombre' : p.g === 'F' ? 'para mujer' : p.g ? 'unisex' : null,
    p.family ? `familia: ${clean1(p.family)}` : null,
    p.notes ? `notas: ${clean1(p.notes)}` : null,
    p.top ? `salida: ${clean1(p.top)}` : null, p.mid ? `corazón: ${clean1(p.mid)}` : null, p.base ? `fondo: ${clean1(p.base)}` : null,
    p.sillage ? `estela: ${clean1(p.sillage)}` : null, p.season ? `temporada: ${clean1(p.season)}` : null,
    p.tagline ? `frase: "${clean1(p.tagline)}"` : null,
  ];
  return bits.filter(Boolean).join(' | ');
}

const SYSTEM = `Eres Nez, sommelier de Sillage Parfumerie. Escribe la descripción corta de un bundle (un set de perfumes) para su ficha en la tienda.

FORMATO: una o dos oraciones, máximo ${MAX_LEN} caracteres en total. Texto plano en español: sin comillas, sin emojis, sin negritas, sin listas, sin firma.
CONTENIDO: qué tienen en común los perfumes del set o para qué ocasión o tipo de persona funciona, apoyándote SOLO en los datos que se te dan (notas, familia, estela, temporada, género). Si los datos son pocos, sé general y no inventes notas ni características.
VOZ: directa, seca, útil. Sin metáforas, sin poesía, sin frases de marketing ("experiencia única", "descubre", "viaje sensorial").
NO menciones: precios, ahorro ni descuentos, formato (frasco, decant, muestra), autenticidad ni originalidad, envíos, ni el nombre del bundle. Tampoco repitas la lista de perfumes completa: ya aparece justo debajo.`;

// bundle: { name, items:[{productId,name,type,size}] } · catalogue: lista de productos.
// → { messages, count } con count = perfumes del bundle que se encontraron en el catálogo (0 → no vale la pena llamar a la IA).
function buildMessages(bundle, catalogue) {
  const seen = new Set(), facts = [];
  for (const it of (bundle && bundle.items) || []) {
    const p = (catalogue || []).find(x => Number(x.id) === parseInt(it && it.productId, 10));
    if (p && !seen.has(p.id)) { seen.add(p.id); facts.push(productFacts(p)); }
  }
  return {
    count: facts.length,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Perfumes del bundle (${facts.length}):\n${facts.map(f => '- ' + f).join('\n')}\n\nEscribe la descripción.` },
    ],
  };
}

// Limpia la respuesta de la IA. Devuelve '' si no sirve (vacía, con precios, demasiado corta…): quien llama
// deja entonces la descripción en blanco en vez de publicar algo dudoso.
function cleanDescription(text) {
  let s = clean1(text)
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s*[—–-]\s*Nez\.?$/i, '')
    .trim();
  if (s.length > MAX_LEN) {
    const head = s.slice(0, MAX_LEN);
    const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.'));
    s = end >= 40 ? head.slice(0, end + 1) : head.replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '') + '.';
  }
  if (s.length < 20 || /[$]|https?:|www\./i.test(s)) return '';
  return s;
}

// ¿Qué hacer con la descripción al guardar un bundle?
//   existing: null (bundle nuevo) o { description, description_ai, items:[…] } tal como está guardado
//   body:     { description?, items? } lo que llegó del admin (undefined = no vino)
// → { action: 'keep' | 'set' | 'generate', description?, ai }   (ai = valor de description_ai que debe quedar)
//   · 'generate': hay que pedir texto a la IA (si falla, queda en blanco, ai 0).
//   · 'set': texto escrito a mano (ai 0).  · 'keep': no se toca nada.
const itemKey = items => JSON.stringify((Array.isArray(items) ? items : []).map(i => [String(i && i.productId), String((i && i.type) || ''), String((i && i.size) || '').trim()]));

function planDescription(existing, body) {
  const given = body.description === undefined ? undefined : String(body.description || '').trim();
  if (!existing) return given ? { action: 'set', description: given, ai: 0 } : { action: 'generate', ai: 1 };

  const cur = String(existing.description || '').trim();
  const aiOwned = !!existing.description_ai && !!cur;
  const itemsChanged = body.items !== undefined && itemKey(body.items) !== itemKey(existing.items);

  if (given === undefined) {
    // No tocaron el texto: solo se rehace si lo había escrito la IA y cambiaron los perfumes, o si seguía vacío.
    if ((aiOwned && itemsChanged) || (!cur && itemsChanged)) return { action: 'generate', ai: 1 };
    return { action: 'keep', ai: existing.description_ai ? 1 : 0 };
  }
  if (!given) return { action: 'generate', ai: 1 };                       // lo borraron: que lo redacte la IA
  if (given === cur) return aiOwned && itemsChanged ? { action: 'generate', ai: 1 } : { action: 'keep', ai: aiOwned ? 1 : 0 };
  return { action: 'set', description: given, ai: 0 };                    // lo editaron a mano: ya es de la persona
}

module.exports = { MAX_LEN, productFacts, buildMessages, cleanDescription, planDescription };
