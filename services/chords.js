'use strict';

/**
 * chords.js — Sillage Parfumerie
 *
 * Deriva los ACORDES / FAMILIAS OLFATIVAS de un producto a partir de sus notas
 * (salida, corazón, fondo) y de su estela. Devuelve de 1 a 5 etiquetas en español.
 *
 * Vocabulario (20): Cítrico · Acuático · Verde · Aromático · Herbal · Floral · Frutal
 *   · Empolvado · Especiado · Amaderado · Terroso · Ahumado · Ambarado · Oriental
 *   · Dulce · Gourmand  (FAMILIAS)   y   Fresco · Cálido · Sensual · Animalic  (MATICES)
 *
 * Cómo se mide
 *  1. Cada nota se normaliza (minúsculas, sin acentos) y se busca en NOTE_TABLE por
 *     PALABRA COMPLETA, la coincidencia más larga primero, y lo ya reconocido se consume:
 *     "pimienta rosa" cuenta una vez (no también "pimienta" ni "rosa"), "azafrán" no
 *     contiene "ron", "ámbar gris" no cuenta además "ámbar".
 *  2. Cada nota aporta PESOS por acorde (1.0 = señal principal, 0.3–0.7 = secundaria),
 *     multiplicados por el peso del nivel: fondo ×2.0, corazón ×1.5, salida ×1.0.
 *  3. Las FAMILIAS se reparten el 100% del puntaje de familias: se conservan las que
 *     pesan ≥ 12% (máx. 4). La primera es la familia PRINCIPAL.
 *  4. Los MATICES (Fresco, Cálido, Sensual, Animalic) solo se agregan si su puntaje es
 *     al menos el 40% del de la familia líder — antes Sensual salía en ~70% del catálogo.
 *  5. La estela suma un poco a un matiz (muy fuerte → Sensual, fuerte → Cálido, ligera → Fresco).
 *
 * `analyzeChords(product)` devuelve además los puntajes y las notas que NO reconoció, para
 * ampliar la tabla (ver GET /api/admin/chords-report).
 */

// ── Vocabulario ───────────────────────────────────────────────────────────────
const FAMILIES  = ['Cítrico', 'Acuático', 'Verde', 'Aromático', 'Floral', 'Frutal', 'Empolvado', 'Especiado',
                   'Amaderado', 'Terroso', 'Ahumado', 'Ambarado', 'Oriental', 'Dulce', 'Gourmand'];
const MODIFIERS = ['Fresco', 'Herbal', 'Cálido', 'Sensual', 'Animalic'];

// ── Tabla de notas ────────────────────────────────────────────────────────────
// E('alias1|alias2', { Acorde: peso, ... })  — alias en minúsculas y SIN acentos
// (español e inglés; incluye las variantes y erratas que aparecen en el catálogo).
const NOTE_TABLE = [];
function E(aliases, weights) {
  aliases.split('|').forEach(a => NOTE_TABLE.push({ alias: a.trim(), weights }));
}

// Cítricos
E('bergamota|bergamot|bergamotte|limon|lemon|lima|lime|pomelo|toronja|grapefruit|mandarina|mandarin|tangerine|naranja|orange|' +
  'naranja sanguinea|blood orange|naranja amarga|bitter orange|cidro|citron|cedrat|yuzu|citricos|citrico|citrus|' +
  'limon caviar|mandarina verde|verbena|lemongrass|hierba limon', { Cítrico: 1, Fresco: 0.5 });
E('petitgrain', { Cítrico: 0.7, Verde: 0.4 });
E('neroli', { Floral: 0.8, Cítrico: 0.5 });
// Acuáticos / minerales
E('notas acuaticas|acuatico|acuaticas|aquatic|marine|notas marinas|marino|ozono|ozonic|lluvia|rain', { Acuático: 2, Fresco: 1 });
E('sal|sea salt|sal marina|salt', { Acuático: 0.7, Fresco: 0.3 });
E('notas minerales|mineral|minerales|metalico|metallic', { Fresco: 1, Acuático: 0.4 });
E('notas solares|solar', { Fresco: 0.6, Dulce: 0.3, Floral: 0.3 });
E('aloe vera|aloe', { Verde: 0.6, Acuático: 0.4, Fresco: 0.3 });
E('agua de coco', { Acuático: 0.5, Frutal: 0.3, Dulce: 0.3 });
// Verdes
E('galbano|galbanum', { Verde: 1, Aromático: 0.3 });
E('hierba|pasto|grass|hojas verdes|green leaves|notas verdes|bambu|bamboo|pepino|cucumber', { Verde: 1, Fresco: 0.4 });
E('pino|pine', { Verde: 0.7, Amaderado: 0.5, Fresco: 0.4 });
E('hoja de violeta|violet leaf', { Verde: 0.6, Floral: 0.5, Empolvado: 0.3 });
E('angelica', { Verde: 0.5, Especiado: 0.5, Terroso: 0.3 });
E('te verde|green tea', { Verde: 0.7, Fresco: 0.5 });
// Aromáticos / herbales
E('lavanda|lavender|lavand|lavandin', { Aromático: 1, Fresco: 0.3 });
E('salvia|sage|salvia romana|clary sage', { Aromático: 0.9, Herbal: 0.4 });
E('esclarea|clary', { Aromático: 0.8, Herbal: 0.3 });
E('romero|rosemary', { Aromático: 0.9, Herbal: 0.5 });
E('albahaca|basil', { Herbal: 0.8, Aromático: 0.5, Fresco: 0.3 });
E('tomillo|thyme|estragon|tarragon', { Herbal: 0.9, Aromático: 0.4 });
E('abrotano|southernwood|artemisa|artemisia', { Aromático: 0.8, Herbal: 0.5 });
E('menta|mint|hierbabuena|spearmint', { Fresco: 0.8, Aromático: 0.6 });
E('hoja de laurel|laurel|bay leaf', { Aromático: 0.8, Especiado: 0.3, Verde: 0.3 });
E('ginebra|gin', { Aromático: 0.6, Fresco: 0.4, Verde: 0.2 });
E('bayas de enebro|enebro|juniper', { Aromático: 0.7, Verde: 0.4, Fresco: 0.3 });
E('siempreviva|inmortal|immortelle', { Aromático: 0.6, Dulce: 0.4, Floral: 0.3 });
E('geranio|geranium', { Floral: 0.6, Aromático: 0.6, Verde: 0.3 });
E('te negro|black tea|te|tea', { Aromático: 0.5, Ahumado: 0.3, Herbal: 0.3 });
// Florales
E('rosa|rose|rosas|rosa damascena', { Floral: 1 });
E('jazmin|jasmine|jasmin|jazmin sambac|sambac', { Floral: 1, Sensual: 0.2 });
E('peonia|peony|lirio|lily|azucena|azucena roja|lirio de los valles|lily of the valley|lino de los valles|muguet|fresia|freesia|' +
  'gardenia|magnolia|orquidea|orchid|flores blancas|white flowers|flor blanca|madreselva|honeysuckle|camelia|camellia|' +
  'lila|lilac|frangipani|plumeria|mimosa|cerezo en flor', { Floral: 1 });
E('tuberosa|tuberose|nardo|nardos', { Floral: 1, Sensual: 0.3 });
E('ylang|ylang ylang|ilang ilang', { Floral: 0.9, Dulce: 0.2 });
E('azahar|flor de azahar|flor de azahar de naranjo|orange blossom|flor de naranjo', { Floral: 0.9, Cítrico: 0.3 });
E('osmanto|osmanthus', { Floral: 0.8, Frutal: 0.4 });
E('flor de pomelo|flor de loto|loto|lotus|lotus flower', { Floral: 0.7, Acuático: 0.3 });
E('heliotropo|heliotrope', { Floral: 0.7, Empolvado: 0.5, Dulce: 0.3 });
E('violeta|violet', { Floral: 0.7, Empolvado: 0.5 });
E('mahonial', { Floral: 0.6, Verde: 0.5 });
E('hedione|hedion', { Floral: 0.6, Fresco: 0.4 });
E('iris|orris|lirio florentino', { Empolvado: 1, Floral: 0.5 });
// Frutales
E('manzana|apple|durazno|peach|chabacano|albaricoque|apricot|pera|pear|grosella|blackcurrant|cassis|currant|' +
  'fresa|strawberry|frambuesa|raspberry|frutos rojos|red fruits|bayas silvestres|bayas|berries|berry|moras|mora|' +
  'uvas|grape|guayaba|guava|mango|cereza|cherry|frutas|fruta|frutos tropicales', { Frutal: 1 });
E('pina|pineapple', { Frutal: 1 });
E('hoja de pina', { Frutal: 0.6, Verde: 0.5 });
E('frutas tropicales|tropical fruits', { Frutal: 1, Dulce: 0.3 });
E('higo|fig', { Frutal: 0.6, Verde: 0.4, Dulce: 0.3 });
E('melon|sandia|watermelon', { Frutal: 0.7, Acuático: 0.4, Fresco: 0.4 });
E('lichi|lychee', { Frutal: 0.8, Floral: 0.4 });
E('mirabel|mirabelle|ciruela|plum', { Frutal: 1, Especiado: 0.2 });
E('candied fruits|frutas confitadas|frutas cristalizadas', { Frutal: 0.6, Dulce: 0.8 });
E('helado de pera', { Frutal: 0.7, Dulce: 0.7, Gourmand: 0.3 });
E('davana', { Frutal: 0.5, Aromático: 0.5, Dulce: 0.3 });
E('dátiles|datiles|dates|datil', { Dulce: 0.7, Frutal: 0.5, Gourmand: 0.3 });
E('coco|coconut', { Dulce: 0.6, Gourmand: 0.5, Frutal: 0.3 });
// Especiados
E('pimienta rosa|pimenta rosa|pink pepper', { Especiado: 0.8, Fresco: 0.3 });
E('pimienta negra|black pepper|pimienta|pimenta|pepper', { Especiado: 1 });
E('pimienta de sichuan|pimenta de sichuan|sichuan pepper|pimienta sichuan', { Especiado: 0.9, Cítrico: 0.3 });
E('nuez moscada|nutmeg|macis|mace', { Especiado: 1 });
E('cardamomo|cardamom', { Especiado: 0.8, Aromático: 0.4 });
E('canela|cinnamon', { Especiado: 0.9, Cálido: 0.4 });
E('clavo|clove|clavo de olor', { Especiado: 0.9, Cálido: 0.4 });
E('gengibre|jengibre|ginger', { Especiado: 0.7, Fresco: 0.5 });
E('azafran|saffron', { Especiado: 0.7, Ambarado: 0.5 });
E('ron|rum', { Gourmand: 0.7, Dulce: 0.4, Especiado: 0.3 });
// Amaderados / terrosos
E('cedro|cedar|cedro de virginia|cedarwood|madera de cedro|virginia cedar|atlas cedar', { Amaderado: 1 });
E('sandalo|sandalwood|sandal|madera de sandalo', { Amaderado: 0.8, Dulce: 0.3, Sensual: 0.3 });
E('madera|maderas|notas amaderadas|notas de madera|woody notes|wood|woods|amaderado|maderas nobles|maderas preciosas', { Amaderado: 1 });
E('madera de cachemira|cachemira|cashmere|cashmeran|cashmere wood|cachemirán', { Amaderado: 0.7, Sensual: 0.3 });
E('maderas blancas|white woods|madera blanca', { Amaderado: 0.8, Sensual: 0.2 });
E('madera de secuoya roja|secuoya|redwood|secuoya roja', { Amaderado: 0.9 });
E('palisandro|rosewood|palo de rosa', { Amaderado: 0.8, Floral: 0.2 });
E('palo santo', { Amaderado: 0.7, Ambarado: 0.3, Ahumado: 0.2 });
E('madera de akigala|akigalawood|akigala', { Amaderado: 0.8, Terroso: 0.5 });
E('cipres|cypress', { Amaderado: 0.7, Verde: 0.5, Aromático: 0.3 });
E('iso e super', { Amaderado: 0.7, Sensual: 0.3 });
E('ambroxan|ambrox|ambroxide', { Amaderado: 0.5, Ambarado: 0.6, Sensual: 0.4 });
E('vetiver|vetiver de madagascar|vetiver de haiti', { Terroso: 0.8, Amaderado: 0.6 });
E('pachuli|patchouli', { Terroso: 1, Amaderado: 0.6 });
E('musgo de roble|oakmoss|musgo|moss', { Terroso: 1, Verde: 0.3 });
E('turba|peat', { Terroso: 0.7, Ahumado: 0.6 });
E('tierra|earth|terroso', { Terroso: 1 });
E('abedul|birch', { Ahumado: 0.7, Amaderado: 0.6 });
// Ahumados / cuero / resinas / orientales
E('cuero|leather', { Ahumado: 0.8, Sensual: 0.3, Animalic: 0.3 });
E('gamuza|suede', { Empolvado: 0.5, Ahumado: 0.3, Sensual: 0.3 });
E('tabaco|tobacco', { Ahumado: 0.8, Cálido: 0.5, Dulce: 0.3 });
E('incienso|incense|olibano|olibanum|frankincense', { Ahumado: 0.8, Oriental: 0.5 });
E('mirra|myrrh', { Oriental: 0.7, Ambarado: 0.5, Ahumado: 0.3 });
E('oud|oudh|agarwood|agar|madera de agar', { Oriental: 0.7, Amaderado: 0.7, Ahumado: 0.3 });
E('benjui|benzoin', { Ambarado: 0.8, Dulce: 0.4, Cálido: 0.3 });
E('ladano|labdanum|labdano', { Ambarado: 0.9, Oriental: 0.4, Animalic: 0.2 });
E('ambar gris|ambergris', { Ambarado: 0.5, Sensual: 0.4, Acuático: 0.3, Animalic: 0.3 });
E('ambar|amber', { Ambarado: 1, Cálido: 0.3 });
E('madera de ambar|maderas ambaradas|amberwood|maderas ambarinas|notas ambaradas', { Ambarado: 0.8, Amaderado: 0.5 });
E('castoreo|castoreum|civeta|civet|animalic|animal', { Animalic: 1, Sensual: 0.4 });
// Dulces / gourmand
E('vainilla|vanilla|vainilla bourbon|vainilla de madagascar', { Dulce: 1, Cálido: 0.4, Gourmand: 0.3 });
E('tonka|haba tonka|tonka bean|haba de tonka|cumarina|coumarin', { Dulce: 0.8, Ambarado: 0.4, Gourmand: 0.3 });
E('praline|praliné|pralin', { Gourmand: 0.9, Dulce: 0.8 });
E('caramelo|caramel', { Gourmand: 1, Dulce: 0.8 });
E('miel|honey', { Dulce: 0.8, Gourmand: 0.3 });
E('cacao|chocolate|cocoa', { Gourmand: 1, Dulce: 0.6 });
E('cafe|coffee', { Gourmand: 0.9, Aromático: 0.3, Ahumado: 0.2 });
E('leche|milk|crema|cream', { Gourmand: 0.8, Dulce: 0.5 });
E('azucar|sugar|algodon de azucar|cotton candy', { Dulce: 1, Gourmand: 0.6 });
E('almendra|almond', { Gourmand: 0.8, Dulce: 0.5 });
E('acordes gourmand|notas gourmand|gourmand', { Gourmand: 2 });
// Almizcles
E('almizcle blanco|white musk|musk blanco', { Fresco: 0.4, Empolvado: 0.4, Sensual: 0.3 });
E('almizcle|musk|almizcle negro', { Sensual: 0.5, Empolvado: 0.3 });

// Alias más largos primero: la coincidencia más específica se consume antes que la corta
NOTE_TABLE.sort((a, b) => b.alias.length - a.alias.length);

// ── Pesos por nivel y por estela ─────────────────────────────────────────────
const TIER_WEIGHT = { base: 1.6, mid: 1.3, top: 1.0, notes: 1.0 };
const SILLAGE_BONUS = { 'very strong': 'Sensual', 'strong': 'Cálido', 'light': 'Fresco' };
const SILLAGE_WEIGHT = 0.5;
const FAMILY_MIN_RATIO  = 0.35;   // una familia debe pesar ≥ 35% de la líder
const MODIFIER_MIN_RATIO = 0.40;   // un matiz debe pesar ≥ 40% de la familia líder
const MAX_FAMILIES = 4, MAX_TOTAL = 5;

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Reconoce una nota (frase) en la tabla; devuelve los pesos sumados o null si no reconoce nada.
function matchPhrase(phrase) {
  let rest = ' ' + norm(phrase) + ' ';
  if (rest.trim() === '') return null;
  const found = {};
  let any = false;
  for (const { alias, weights } of NOTE_TABLE) {
    const needle = ' ' + alias + ' ';
    while (rest.includes(needle)) {
      rest = rest.replace(needle, '  ');
      any = true;
      for (const [c, w] of Object.entries(weights)) found[c] = (found[c] || 0) + w;
    }
  }
  return any ? found : null;
}

function scoreTier(str, tierWeight, scores, unknown) {
  if (!str) return;
  String(str).split(/[,;/]/).map(s => s.trim()).filter(Boolean).forEach(phrase => {
    const hit = matchPhrase(phrase);
    if (!hit) { unknown.push(phrase); return; }
    for (const [c, w] of Object.entries(hit)) scores[c] = (scores[c] || 0) + w * tierWeight;
  });
}

// → { chords: [...], primary, scores, unknown: [notas sin reconocer] }
function analyzeChords(product) {
  const scores = {}, unknown = [];
  scoreTier(product.base,  TIER_WEIGHT.base,  scores, unknown);
  scoreTier(product.mid,   TIER_WEIGHT.mid,   scores, unknown);
  scoreTier(product.top,   TIER_WEIGHT.top,   scores, unknown);
  scoreTier(product.notes, TIER_WEIGHT.notes, scores, unknown);

  // La estela empuja un poco a un matiz (nunca crea una familia)
  const sil = String(product.sillage || '').toLowerCase();
  const silKey = Object.keys(SILLAGE_BONUS).find(k => sil.includes(k));
  if (silKey) scores[SILLAGE_BONUS[silKey]] = (scores[SILLAGE_BONUS[silKey]] || 0) + SILLAGE_WEIGHT;

  // Familias: se conservan las que pesan ≥ 35% de la líder (máx. 4); la líder siempre
  const fams = FAMILIES.filter(f => (scores[f] || 0) > 0)
    .sort((a, b) => scores[b] - scores[a] || FAMILIES.indexOf(a) - FAMILIES.indexOf(b));   // desempate fijo
  const chosen = fams.filter((f, i) => i === 0 || scores[f] >= scores[fams[0]] * FAMILY_MIN_RATIO).slice(0, MAX_FAMILIES);

  // Matices: solo si pesan lo suficiente frente a la familia líder
  const lead = chosen.length ? scores[chosen[0]] : 0;
  const mods = MODIFIERS.filter(m => lead > 0 && (scores[m] || 0) >= lead * MODIFIER_MIN_RATIO)
    .sort((a, b) => scores[b] - scores[a] || MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));

  const chords = chosen.concat(mods).slice(0, MAX_TOTAL);
  return { chords, primary: chords[0] || null, scores, unknown };
}

function calcChords(product) { return analyzeChords(product).chords; }

module.exports = { calcChords, analyzeChords, FAMILIES, MODIFIERS };
