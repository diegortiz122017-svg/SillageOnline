'use strict';

/**
 * noteIntensity.js — Sillage Parfumerie
 *
 * Multi-factor intensity scoring model:
 *   1. Sillage anchor    — primary signal, human-verified per product
 *   2. Concentration     — EDP vs EDT vs Cologne multiplier
 *   3. Powerhouse bonus  — ambroxan, iso e super, cashmeran, etc. project beyond weight
 *   4. Note count signal — fewer notes = each more prominent
 *   5. Ingredient weights — keyword scoring for fine-tuning within tier
 *
 * Returns top_intensity, mid_intensity, base_intensity (0–100).
 */

// ── Sillage → base intensity range ───────────────────────────────────────────
// Each tier defines a midpoint; ingredient scoring nudges within ±15 points
const SILLAGE_BASE = {
  'intimate':         15,
  'light':            25,
  'light to moderate':38,
  'moderate':         52,
  'strong':           70,
  'very strong':      88,
};

// ── Concentration multiplier ──────────────────────────────────────────────────
const CONC_MULT = {
  'extrait de parfum':  1.20,
  'extrait':            1.20,
  'parfum':             1.15,
  'eau de parfum':      1.00,
  'edp':                1.00,
  'eau de toilette':    0.82,
  'edt':                0.82,
  'eau de cologne':     0.68,
  'cologne':            0.68,
  'edc':                0.68,
  'eau fraiche':        0.55,
  'body mist':          0.40,
};

// ── Powerhouse synthetics — project far beyond their ingredient weight ─────────
const POWERHOUSES = [
  'ambroxan','ambróxan','ambrox','ambrofix',
  'iso e super','iso-e-super',
  'cashmeran','cachemirán',
  'hedione',
  'galaxolide','habanolide',
  'ebanol',
  'akigalawood',
  'jungle essence',
  'clearwood',
];

// ── Ingredient weight tables ──────────────────────────────────────────────────

const TOP_WEIGHTS = {
  // Heavy / projecting tops
  'pink pepper':9,'pimienta rosa':9,'black pepper':8,'pimienta negra':8,'pimienta':7,
  'saffron':9,'azafrán':9,'azafran':9,'cardamom':8,'cardamomo':8,
  'ginger':7,'jengibre':7,'nutmeg':7,'nuez moscada':7,
  'cinnamon':7,'canela':7,'clove':7,'clavo':7,'elemi':7,
  'aldehydes':8,'aldehyde':8,'aldehydic':7,
  // Herbs
  'clary sage':6,'sage':6,'salvia':6,'thyme':6,'tomillo':6,
  'basil':6,'albahaca':6,'tarragon':6,'estragón':6,
  'rosemary':5,'romero':5,'lavender':5,'lavanda':5,'lavandin':5,
  'artemisia':4,'ajenjo':4,'davana':5,
  'violet leaf':6,'hoja de violeta':6,'hay':5,'heno':5,
  // Citrus
  'bergamot':4,'bergamota':4,'lemon':4,'limón':4,'limon':4,
  'lime':4,'lima':4,'grapefruit':4,'pomelo':4,'toronja':4,
  'orange':5,'naranja':5,'blood orange':5,'mandarin':5,'mandarina':5,
  'tangerine':5,'yuzu':5,'cedrat':5,'petitgrain':5,'neroli':5,
  'clementine':4,'kumquat':4,'lemon verbena':4,'verbena':4,
  // Fruits
  'pineapple':6,'piña':6,'apple':4,'manzana':4,'manzana verde':4,
  'peach':5,'melocotón':5,'durazno':5,'pear':4,'pera':4,
  'plum':6,'ciruela':6,'mango':5,'raspberry':5,'frambuesa':5,
  'blackcurrant':6,'grosella negra':6,'cassis':6,'blackberry':5,'mora':5,
  'strawberry':4,'fresa':4,'cherry':5,'cereza':5,
  'passion fruit':5,'maracuyá':5,'guava':4,'lychee':4,'fig':5,'higo':5,
  // Aquatic
  'aquatic':2,'acuático':2,'marine':2,'marino':2,'sea':2,'mar':2,
  'ozonic':2,'water':2,'rain':2,'mint':3,'menta':3,'spearmint':3,'peppermint':3,
  // Green
  'green':3,'verde':3,'grass':3,'cucumber':3,'bamboo':3,'tea':3,'té':3,
  // Gourmand tops
  'coffee':6,'café':6,'cafe':6,'cocoa':5,'cacao':5,'chocolate':5,
  'caramel':4,'caramelo':4,'almond':5,'almendra':5,'almendrada':5,
  'praline':4,'pralinada':4,
};

const HEART_WEIGHTS = {
  // Heavy hearts
  'oud':10,'agarwood':10,'madera de agar':10,
  'incense':9,'incienso':9,'frankincense':9,'olibanum':9,
  'myrrh':9,'mirra':9,'labdanum':8,'labdano':8,'cistus':7,
  'tobacco':9,'tabaco':9,'leather':8,'cuero':8,'smoke':8,'humo':8,
  'cinnamon':8,'canela':8,'clove':8,'clavo':8,'cardamom':7,'cardamomo':7,
  'pepper':6,'pimienta':6,'saffron':8,'azafrán':8,'azafran':8,
  'nutmeg':6,'ginger':6,'jengibre':6,'cumin':7,'comino':7,
  // Rich florals
  'ylang':7,'ylang-ylang':7,'tuberose':7,'tuberosa':7,
  'narcissus':7,'narciso':7,'carnation':7,'clavel':7,
  'jasmine':7,'jazmín':7,'jazmin':7,'sambac':7,
  'rose':6,'rosa':6,'bulgarian rose':7,'rosa búlgara':7,
  'iris':6,'orris':6,'violet':6,'violeta':6,
  'heliotrope':6,'heliotropo':6,'immortelle':8,'inmortal':8,
  'gardenia':6,'osmanthus':6,'frangipani':6,'champaca':7,
  'magnolia':5,'geranium':5,'geranio':5,
  'orange blossom':5,'flor de azahar':5,'azahar':5,'neroli':5,'mimosa':5,
  // Lighter florals
  'peony':4,'peonía':4,'freesia':4,'cyclamen':4,'lily':4,'lirio':4,
  'lily of the valley':4,'muguet':4,'lotus':4,'cherry blossom':4,
  // Earthy
  'patchouli':6,'pachulí':6,'pachuli':6,'vetiver':6,
  'oakmoss':6,'musgo de roble':6,'moss':5,'musgo':5,
  'sandalwood':6,'sándalo':6,'sandalo':6,'cedar':5,'cedro':5,
  'guaiac wood':5,'madera de guaíaco':5,'birch':6,'abedul':6,
  // Synthetics
  'ambrox':5,'ambroxan':5,'ambróxan':5,'hedione':4,
  'iso e super':5,'cashmeran':5,'galaxolide':4,
  // Herbs
  'lavender':5,'lavanda':5,'sage':5,'salvia':5,'davana':5,
  // Gourmand
  'coffee':6,'café':6,'cocoa':5,'cacao':5,'chocolate':5,
  'vanilla':5,'vainilla':5,'tonka':6,'haba tonka':6,'tonka bean':6,
  'honey':5,'miel':5,
};

const BASE_WEIGHTS = {
  // Oud & agarwood
  'oud':10,'agarwood':10,'madera de agar':10,
  // Amber & resins
  'amber':9,'ámbar':9,'ambar':9,'ambergris':9,'ámbar gris':9,
  'labdanum':9,'labdano':9,'benzoin':9,'benjuí':9,'benjoin':9,
  'resin':8,'resina':8,'fir resin':8,'resina de abeto':8,'abeto':7,
  'balsam':8,'bálsamo':8,'balsamo':8,'peru balsam':8,'tolu balsam':8,
  'styrax':8,'olibanum':7,'incienso':7,'myrrh':7,'mirra':7,
  'elemi':6,'copal':7,'cistus':7,'castoreum':9,'civet':9,
  'ambrox':6,'ambroxan':6,'ambróxan':6,'ambrofix':6,'iso e super':6,
  // Musks
  'musk':6,'almizcle':6,'musks':6,'white musk':4,'almizcle blanco':4,
  'clean musk':3,'solar musk':3,'woody musk':5,'ambrette':4,'malva almizclera':4,
  // Tonka & vanilla
  'tonka':8,'tonka bean':8,'haba tonka':8,
  'vanilla':7,'vainilla':7,'madagascar vanilla':8,'vainilla de madagascar':8,
  'coumarin':6,'cumarina':6,
  // Woods
  'sandalwood':7,'sándalo':7,'sandalo':7,'mysore sandalwood':8,
  'cedar':7,'cedro':7,'virginia cedar':7,'atlas cedar':7,'cedarwood':7,
  'vetiver':7,'patchouli':7,'pachulí':7,'pachuli':7,
  'guaiac wood':5,'madera de guaíaco':5,'gaiac':5,
  'birch':6,'abedul':6,'birch tar':8,
  'oakmoss':6,'musgo de roble':6,'moss':5,'treemoss':5,
  'woody notes':5,'notas maderosas':5,'madera':5,'maderas':5,
  'cashmeran':5,'cachemirán':5,
  // Leather & tobacco
  'leather':8,'cuero':8,'suede':6,'ante':6,
  'tobacco':8,'tabaco':8,'smoke':7,'humo':7,'tar':7,
  // Gourmand
  'caramel':5,'caramelo':5,'chocolate':5,'cocoa':5,'cacao':5,
  'coffee':5,'café':5,'honey':5,'miel':5,
  'praline':4,'pralinada':4,'almond':4,'almendra':4,
  'sugar':3,'azúcar':3,'marshmallow':4,'milk':4,'cream':4,
  'rum':5,'ron':5,'whiskey':5,'cachemira':5,
  // Spices
  'cinnamon':6,'canela':6,'clove':6,'clavo':6,'pepper':5,'pimienta':5,
  'cardamom':5,'cardamomo':5,'nutmeg':5,'ginger':4,'saffron':6,'azafrán':6,
  // Florals anchoring
  'iris':4,'orris':4,'rose':4,'rosa':4,'jasmine':4,'jazmín':4,
  'heliotrope':5,'heliotropo':5,'immortelle':6,'inmortal':6,
  // Earthy
  'earth':5,'tierra':5,'mushroom':5,'hay':5,'heno':5,
  'animalic':7,'animalico':7,
};

// ── Scoring helpers ───────────────────────────────────────────────────────────

function scoreNotes(notesStr, weightTable) {
  if (!notesStr || typeof notesStr !== 'string') return { score: 0, count: 0, hasPowerhouse: false };
  const notes = notesStr.toLowerCase();
  let score = 0, count = 0, hasPowerhouse = false;

  // Count individual note items (comma/bullet separated)
  const items = notes.split(/[,•·\/]+/).map(s => s.trim()).filter(Boolean);
  count = items.length;

  for (const [keyword, weight] of Object.entries(weightTable)) {
    if (notes.includes(keyword)) score += weight;
  }
  for (const ph of POWERHOUSES) {
    if (notes.includes(ph)) { hasPowerhouse = true; break; }
  }
  return { score, count, hasPowerhouse };
}

function getConcentrationMultiplier(conc) {
  if (!conc) return 1.0;
  const c = conc.toLowerCase().trim();
  for (const [key, mult] of Object.entries(CONC_MULT)) {
    if (c.includes(key)) return mult;
  }
  return 1.0;
}

function getSillageBase(sillage) {
  if (!sillage) return 52; // default to moderate
  const s = sillage.toLowerCase().trim();
  for (const [key, base] of Object.entries(SILLAGE_BASE)) {
    if (s.includes(key)) return base;
  }
  return 52;
}

/**
 * Calculate all three intensity scores for a product.
 *
 * Algorithm per tier:
 *   1. Get sillage base (midpoint of the tier)
 *   2. Apply concentration multiplier
 *   3. Score ingredients → normalize to -15..+15 nudge
 *   4. Add powerhouse bonus (+8 if present)
 *   5. Note count: fewer items = higher prominence (+5 if ≤2 notes, -3 if ≥6)
 *   6. Clamp to 5–98
 */
function calcIntensity(product) {
  const sillageBase = getSillageBase(product.sillage);
  const concMult    = getConcentrationMultiplier(product.conc);

  function tierScore(notesStr, weightTable) {
    const { score, count, hasPowerhouse } = scoreNotes(notesStr, weightTable);

    // Anchored base: sillage midpoint × concentration
    let base = Math.round(sillageBase * concMult);

    // Ingredient nudge: normalize raw score to ±15 window
    // Raw ceiling ~50 for very heavy ingredient lists
    const nudge = score > 0 ? Math.round((score / 50) * 15) - 7 : 0;

    // Powerhouse bonus
    const phBonus = hasPowerhouse ? 8 : 0;

    // Note count signal: sparse = more prominent, dense = shared space
    let countAdj = 0;
    if (count <= 2)      countAdj = +5;
    else if (count >= 6) countAdj = -4;
    else if (count >= 4) countAdj = -2;

    const final = base + nudge + phBonus + countAdj;
    return Math.min(98, Math.max(5, final));
  }

  return {
    top_intensity:  tierScore(product.top,  TOP_WEIGHTS),
    mid_intensity:  tierScore(product.mid,  HEART_WEIGHTS),
    base_intensity: tierScore(product.base, BASE_WEIGHTS),
  };
}

module.exports = { calcIntensity, scoreNotes };
