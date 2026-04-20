'use strict';

/**
 * noteIntensity.js — Sillage Parfumerie
 * Estimates top/heart/base note intensity (0–100) from keyword matching.
 * Supports English and Spanish note names, including niche, mainstream,
 * and Arabic/oriental house conventions.
 */

const TOP_WEIGHTS = {
  // Spices & heavy tops
  'pink pepper':9,'pimienta rosa':9,'black pepper':8,'pimienta negra':8,'pimienta':7,
  'saffron':9,'azafrán':9,'azafran':9,'cardamom':8,'cardamomo':8,
  'ginger':7,'jengibre':7,'nutmeg':7,'nuez moscada':7,
  'cinnamon':7,'canela':7,'clove':7,'clavo':7,'elemi':7,
  'aldehydes':8,'aldehyde':8,'aldehídos':8,'aldehydic':7,
  // Herbs
  'clary sage':6,'salvia romana':6,'sage':6,'salvia':6,
  'thyme':6,'tomillo':6,'basil':6,'albahaca':6,'tarragon':6,'estragón':6,
  'rosemary':5,'romero':5,'lavender':5,'lavanda':5,'lavandin':5,
  'artemisia':4,'ajenjo':4,'davana':5,
  'violet leaf':6,'hoja de violeta':6,'green leaves':3,'hojas verdes':3,
  'hay':5,'heno':5,
  // Citrus
  'bergamot':4,'bergamota':4,'lemon':4,'limón':4,'limon':4,
  'lime':4,'lima':4,'grapefruit':4,'pomelo':4,'toronja':4,
  'orange':5,'naranja':5,'blood orange':5,'mandarin':5,'mandarina':5,
  'tangerine':5,'tangerina':5,'yuzu':5,'cedrat':5,
  'lemon verbena':4,'verbena':4,'petitgrain':5,'neroli':5,
  'clementine':4,'clementina':4,'kumquat':4,
  // Fruits
  'pineapple':6,'piña':6,'apple':4,'manzana':4,'manzana verde':4,
  'peach':5,'melocotón':5,'durazno':5,'pear':4,'pera':4,
  'plum':6,'ciruela':6,'mango':5,'raspberry':5,'frambuesa':5,
  'blackcurrant':6,'grosella negra':6,'cassis':6,'blackberry':5,'mora':5,
  'strawberry':4,'fresa':4,'cherry':5,'cereza':5,
  'passion fruit':5,'maracuyá':5,'maracuya':5,'guava':4,'guayaba':4,
  'lychee':4,'lichi':4,'fig':5,'higo':5,
  // Aquatic & fresh
  'aquatic':2,'acuático':2,'acuatico':2,'marine':2,'marino':2,
  'sea':2,'mar':2,'ozonic':2,'water':2,'agua':2,'rain':2,'lluvia':2,
  'mint':3,'menta':3,'spearmint':3,'hierbabuena':3,'peppermint':3,
  // Green & vegetal
  'green':3,'verde':3,'grass':3,'hierba':3,'tomato leaf':4,
  'cucumber':3,'pepino':3,'bamboo':3,'bambú':3,'tea':3,'té':3,'green tea':3,
  // Gourmand tops
  'coffee':6,'café':6,'cafe':6,'cocoa':5,'cacao':5,'chocolate':5,
  'caramel':4,'caramelo':4,'almond':5,'almendra':5,'almendrada':5,
  'praline':4,'pralinada':4,'praliné':4,
};

const HEART_WEIGHTS = {
  // Oud & resins
  'oud':10,'agarwood':10,'madera de agar':10,
  'incense':9,'incienso':9,'frankincense':9,'olibanum':9,'olíbano':9,
  'myrrh':9,'mirra':9,'labdanum':8,'labdano':8,'labdáno':8,'cistus':7,
  // Tobacco & leather
  'tobacco':9,'tabaco':9,'leather':8,'cuero':8,'smoke':8,'humo':8,'smoky':8,
  // Spices
  'cinnamon':8,'canela':8,'clove':8,'clavo':8,'cardamom':7,'cardamomo':7,
  'pepper':6,'pimienta':6,'pink pepper':6,'pimienta rosa':6,
  'saffron':8,'azafrán':8,'azafran':8,'nutmeg':6,'nuez moscada':6,
  'ginger':6,'jengibre':6,'cumin':7,'comino':7,'coriander':5,'cilantro':5,
  // Rich florals
  'ylang':7,'ylang-ylang':7,'tuberose':7,'tuberosa':7,
  'narcissus':7,'narciso':7,'carnation':7,'clavel':7,
  'jasmine':7,'jazmín':7,'jazmin':7,'sambac':7,'sambac de jazmín':7,
  'rose':6,'rosa':6,'bulgarian rose':7,'rosa búlgara':7,'rosa bulgara':7,
  'iris':6,'orris':6,'orris root':6,'violet':6,'violeta':6,
  'heliotrope':6,'heliotropo':6,'immortelle':8,'inmortal':8,
  'gardenia':6,'osmanthus':6,'osmanto':6,'frangipani':6,'plumeria':6,
  'champaca':7,'magnolia':5,'geranium':5,'geranio':5,
  'orange blossom':5,'flor de azahar':5,'azahar':5,'neroli':5,'mimosa':5,
  // Lighter florals
  'peony':4,'peonía':4,'peonia':4,'freesia':4,'cyclamen':4,'ciclamen':4,
  'lily':4,'lirio':4,'lily of the valley':4,'muguet':4,
  'lotus':4,'loto':4,'cherry blossom':4,'flor de cerezo':4,
  'wisteria':4,'glicinia':4,
  // Earthy & woods
  'patchouli':6,'pachulí':6,'pachuli':6,'vetiver':6,
  'oakmoss':6,'musgo de roble':6,'moss':5,'musgo':5,
  'sandalwood':6,'sándalo':6,'sandalo':6,'cedar':5,'cedro':5,
  'guaiac wood':5,'madera de guaíaco':5,'madera de guaiac':5,
  'birch':6,'abedul':6,'papyrus':5,'papiro':5,
  // Synthetic & modern
  'ambrox':5,'ambroxan':5,'ambróxan':5,'hedione':4,
  'iso e super':5,'cashmeran':5,'cachemirán':5,'galaxolide':4,
  // Herbs & aromatics
  'lavender':5,'lavanda':5,'sage':5,'salvia':5,
  'rosemary':4,'romero':4,'thyme':4,'tomillo':4,'davana':5,'artemisia':4,
  // Gourmand
  'coffee':6,'café':6,'cocoa':5,'cacao':5,'chocolate':5,
  'vanilla':5,'vainilla':5,'tonka':6,'haba tonka':6,'tonka bean':6,
  'honey':5,'miel':5,'beeswax':5,'cera de abeja':5,
};

const BASE_WEIGHTS = {
  // Oud & agarwood
  'oud':10,'agarwood':10,'madera de agar':10,
  // Amber & resins
  'amber':9,'ámbar':9,'ambar':9,'ambergris':9,'ámbar gris':9,
  'labdanum':9,'labdano':9,'labdáno':9,
  'benzoin':9,'benjuí':9,'benjoin':9,
  'resin':8,'resina':8,'fir resin':8,'resina de abeto':8,'abeto':7,
  'balsam':8,'bálsamo':8,'balsamo':8,'peru balsam':8,'tolu balsam':8,
  'styrax':8,'frankincense':7,'olibanum':7,'incienso':7,
  'myrrh':7,'mirra':7,'elemi':6,'copal':7,'cistus':7,
  'castoreum':9,'castóreo':9,'civet':9,
  'ambrox':6,'ambroxan':6,'ambróxan':6,'ambrofix':6,'iso e super':6,
  // Musks
  'musk':6,'almizcle':6,'muscs':6,'musks':6,
  'white musk':4,'almizcle blanco':4,'clean musk':3,'solar musk':3,
  'woody musk':5,'animalistic musk':7,'ambrette':4,'malva almizclera':4,
  // Tonka & vanilla
  'tonka':8,'tonka bean':8,'haba tonka':8,
  'vanilla':7,'vainilla':7,'madagascar vanilla':8,'vainilla de madagascar':8,
  'coumarin':6,'cumarina':6,
  // Woods
  'sandalwood':7,'sándalo':7,'sandalo':7,'mysore sandalwood':8,
  'cedar':7,'cedro':7,'virginia cedar':7,'cedro de virginia':7,
  'atlas cedar':7,'cedro del atlas':7,'cedarwood':7,
  'vetiver':7,'patchouli':7,'pachulí':7,'pachuli':7,
  'guaiac wood':5,'madera de guaíaco':5,'gaiac':5,
  'birch':6,'abedul':6,'birch tar':8,
  'oakmoss':6,'musgo de roble':6,'moss':5,'musgo':5,'treemoss':5,
  'woody notes':5,'notas maderosas':5,'madera':5,'maderas':5,
  'cashmeran':5,'cachemirán':5,
  // Leather & tobacco
  'leather':8,'cuero':8,'suede':6,'ante':6,
  'tobacco':8,'tabaco':8,'smoke':7,'humo':7,'smoky':7,'tar':7,'alquitrán':7,
  // Gourmand base
  'caramel':5,'caramelo':5,'chocolate':5,'cocoa':5,'cacao':5,
  'coffee':5,'café':5,'honey':5,'miel':5,
  'praline':4,'pralinada':4,'praliné':4,'almond':4,'almendra':4,
  'sugar':3,'azúcar':3,'azucar':3,'marshmallow':4,'malvavisco':4,
  'milk':4,'leche':4,'cream':4,'crema':4,'rum':5,'ron':5,
  'whiskey':5,'whisky':5,'cachemira':5,
  // Spices (base)
  'cinnamon':6,'canela':6,'clove':6,'clavo':6,'pepper':5,'pimienta':5,
  'cardamom':5,'cardamomo':5,'nutmeg':5,'nuez moscada':5,
  'ginger':4,'jengibre':4,'saffron':6,'azafrán':6,
  // Florals anchoring
  'iris':4,'orris':4,'rose':4,'rosa':4,'jasmine':4,'jazmín':4,
  'heliotrope':5,'heliotropo':5,'immortelle':6,'inmortal':6,
  // Earthy & animalic
  'earth':5,'tierra':5,'mushroom':5,'seta':5,'hongo':5,
  'hay':5,'heno':5,'animalic':7,'animalico':7,
  // Synthetics
  'galaxolide':4,'habanolide':4,'hedione':3,'jungle essence':5,
};

// ── Scoring function ──────────────────────────────────────────────────────────

function scoreNotes(notesStr, weightTable) {
  if (!notesStr || typeof notesStr !== 'string') return 0;
  const notes = notesStr.toLowerCase();
  let score = 0, matches = 0;
  for (const [keyword, weight] of Object.entries(weightTable)) {
    if (notes.includes(keyword)) { score += weight; matches++; }
  }
  if (matches === 0) return 30;
  const normalized = Math.min(100, Math.round((score / 60) * 100));
  return Math.max(10, normalized);
}

function calcIntensity(product) {
  const top  = scoreNotes(product.top,  TOP_WEIGHTS);
  const mid  = scoreNotes(product.mid,  HEART_WEIGHTS);
  const base = scoreNotes(product.base, BASE_WEIGHTS);

  // Step 1: enforce pyramid — base >= mid >= top
  const enforcedBase = Math.max(base, mid, top);
  const enforcedMid  = Math.max(mid, top);
  const enforcedTop  = top;

  // Step 2: normalize so the heaviest layer (base) always = 100%
  // This makes bars stretch across the full width and shows
  // relative differences clearly between layers per product.
  // A minimum floor of 15 ensures no bar is invisible.
  const scale = enforcedBase > 0 ? 100 / enforcedBase : 1;

  return {
    top_intensity:  Math.max(15, Math.round(enforcedTop  * scale)),
    mid_intensity:  Math.max(25, Math.round(enforcedMid  * scale)),
    base_intensity: 100, // always full width after normalization
  };
}

module.exports = { calcIntensity, scoreNotes };
