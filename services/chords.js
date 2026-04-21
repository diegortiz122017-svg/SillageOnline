'use strict';

/**
 * chords.js — Sillage Parfumerie
 *
 * Derives olfactive chord tags from a product's notes, family signals,
 * concentration, and sillage. Returns an array of 3-5 Spanish chord labels.
 *
 * Chord vocabulary (Spanish, max ~15):
 *   Fresco · Cítrico · Acuático · Verde
 *   Floral · Empolvado · Frutal
 *   Especiado · Aromático · Herbal
 *   Amaderado · Terroso · Ahumado
 *   Ambarado · Oriental · Gourmand
 *   Dulce · Cálido · Sensual · Animalic
 */

// ── Keyword → chord signal tables ────────────────────────────────────────────
// Each entry: keyword (lowercase) → array of chords it signals
const NOTE_SIGNALS = {
  // FRESH / CITRUS
  bergamot:        ['Fresco','Cítrico'],
  bergamota:       ['Fresco','Cítrico'],
  lemon:           ['Fresco','Cítrico'],
  limón:           ['Fresco','Cítrico'],
  limon:           ['Fresco','Cítrico'],
  lime:            ['Fresco','Cítrico'],
  lima:            ['Fresco','Cítrico'],
  grapefruit:      ['Fresco','Cítrico'],
  pomelo:          ['Fresco','Cítrico'],
  toronja:         ['Fresco','Cítrico'],
  orange:          ['Fresco','Cítrico'],
  naranja:         ['Fresco','Cítrico'],
  mandarin:        ['Fresco','Cítrico'],
  mandarina:       ['Fresco','Cítrico'],
  yuzu:            ['Fresco','Cítrico'],
  cedrat:          ['Fresco','Cítrico'],
  petitgrain:      ['Fresco','Cítrico'],

  // AQUATIC / GREEN
  aquatic:         ['Acuático','Fresco'],
  marine:          ['Acuático','Fresco'],
  sea:             ['Acuático'],
  'sea salt':      ['Acuático','Fresco'],
  water:           ['Acuático','Fresco'],
  ozonic:          ['Acuático','Fresco'],
  cucumber:        ['Verde','Fresco'],
  grass:           ['Verde'],
  'green leaves':  ['Verde'],
  bamboo:          ['Verde','Fresco'],
  mint:            ['Fresco','Aromático'],
  menta:           ['Fresco','Aromático'],
  spearmint:       ['Fresco','Aromático'],

  // FLORAL
  rose:            ['Floral'],
  rosa:            ['Floral'],
  jasmine:         ['Floral','Sensual'],
  jazmín:          ['Floral','Sensual'],
  jasmin:          ['Floral','Sensual'],
  tuberose:        ['Floral','Sensual'],
  tuberosa:        ['Floral','Sensual'],
  lily:            ['Floral'],
  lirio:           ['Floral'],
  peony:           ['Floral'],
  peonía:          ['Floral'],
  gardenia:        ['Floral'],
  ylang:           ['Floral','Sensual'],
  iris:            ['Floral','Empolvado'],
  violet:          ['Floral','Empolvado'],
  violeta:         ['Floral','Empolvado'],
  heliotrope:      ['Floral','Empolvado'],
  lavender:        ['Aromático','Floral'],
  lavanda:         ['Aromático','Floral'],
  neroli:          ['Floral','Fresco'],
  'orange blossom':['Floral','Fresco'],
  azahar:          ['Floral','Fresco'],
  magnolia:        ['Floral'],
  osmanthus:       ['Floral','Frutal'],
  geranium:        ['Floral','Herbal'],
  geranio:         ['Floral','Herbal'],

  // POWDERY
  orris:           ['Empolvado'],
  powder:          ['Empolvado'],
  talc:            ['Empolvado'],
  musk:            ['Sensual'],
  almizcle:        ['Sensual'],
  'white musk':    ['Sensual','Fresco'],
  ambrette:        ['Empolvado','Sensual'],

  // FRUTAL
  pineapple:       ['Frutal'],
  piña:            ['Frutal'],
  apple:           ['Frutal'],
  manzana:         ['Frutal'],
  peach:           ['Frutal'],
  melocotón:       ['Frutal'],
  pear:            ['Frutal'],
  pera:            ['Frutal'],
  mango:           ['Frutal'],
  plum:            ['Frutal','Especiado'],
  ciruela:         ['Frutal','Especiado'],
  blackcurrant:    ['Frutal'],
  cassis:          ['Frutal'],
  berry:           ['Frutal'],
  cherry:          ['Frutal'],
  fig:             ['Frutal','Verde'],
  lychee:          ['Frutal','Floral'],

  // SPICY / AROMATIC
  pepper:          ['Especiado'],
  pimienta:        ['Especiado'],
  'pink pepper':   ['Especiado','Fresco'],
  'pimienta rosa': ['Especiado','Fresco'],
  cardamom:        ['Especiado','Aromático'],
  cardamomo:       ['Especiado','Aromático'],
  cinnamon:        ['Especiado','Cálido'],
  canela:          ['Especiado','Cálido'],
  clove:           ['Especiado','Cálido'],
  clavo:           ['Especiado','Cálido'],
  nutmeg:          ['Especiado'],
  ginger:          ['Especiado','Fresco'],
  jengibre:        ['Especiado','Fresco'],
  saffron:         ['Especiado','Ambarado'],
  azafrán:         ['Especiado','Ambarado'],
  azafran:         ['Especiado','Ambarado'],
  elemi:           ['Especiado','Aromático'],
  clary:           ['Aromático'],
  sage:            ['Aromático','Herbal'],
  salvia:          ['Aromático','Herbal'],
  thyme:           ['Herbal'],
  rosemary:        ['Herbal','Aromático'],
  romero:          ['Herbal','Aromático'],
  basil:           ['Herbal','Fresco'],
  tarragon:        ['Herbal'],
  davana:          ['Aromático','Frutal'],
  artemisia:       ['Aromático','Herbal'],
  tobacco:         ['Ahumado','Cálido'],
  tabaco:          ['Ahumado','Cálido'],

  // WOODY / EARTHY
  sandalwood:      ['Amaderado','Sensual'],
  sándalo:         ['Amaderado','Sensual'],
  sandalo:         ['Amaderado','Sensual'],
  cedar:           ['Amaderado'],
  cedro:           ['Amaderado'],
  vetiver:         ['Terroso','Amaderado'],
  patchouli:       ['Terroso','Amaderado'],
  pachulí:         ['Terroso','Amaderado'],
  pachuli:         ['Terroso','Amaderado'],
  birch:           ['Amaderado','Ahumado'],
  abedul:          ['Amaderado','Ahumado'],
  oakmoss:         ['Terroso'],
  'musgo de roble':['Terroso'],
  moss:            ['Terroso'],
  earth:           ['Terroso'],
  'guaiac wood':   ['Amaderado','Ahumado'],
  'madera de guaíaco':['Amaderado','Ahumado'],
  'woody':         ['Amaderado'],

  // AMBER / ORIENTAL / RESINOUS
  amber:           ['Ambarado','Cálido'],
  ámbar:           ['Ambarado','Cálido'],
  ambar:           ['Ambarado','Cálido'],
  ambergris:       ['Ambarado','Sensual'],
  labdanum:        ['Ambarado','Oriental'],
  labdano:         ['Ambarado','Oriental'],
  benzoin:         ['Ambarado','Cálido'],
  benjuí:          ['Ambarado','Cálido'],
  styrax:          ['Ambarado','Especiado'],
  frankincense:    ['Oriental','Ambarado'],
  incense:         ['Ahumado','Oriental'],
  incienso:        ['Ahumado','Oriental'],
  myrrh:           ['Oriental','Ambarado'],
  mirra:           ['Oriental','Ambarado'],
  oud:             ['Oriental','Amaderado'],
  leather:         ['Sensual','Ahumado'],
  cuero:           ['Sensual','Ahumado'],

  // GOURMAND / SWEET
  vanilla:         ['Dulce','Cálido'],
  vainilla:        ['Dulce','Cálido'],
  tonka:           ['Dulce','Ambarado'],
  'tonka bean':    ['Dulce','Ambarado'],
  'haba tonka':    ['Dulce','Ambarado'],
  coumarin:        ['Dulce','Aromático'],
  cumarina:        ['Dulce','Aromático'],
  caramel:         ['Gourmand','Dulce'],
  caramelo:        ['Gourmand','Dulce'],
  chocolate:       ['Gourmand','Dulce'],
  cocoa:           ['Gourmand','Dulce'],
  cacao:           ['Gourmand','Dulce'],
  coffee:          ['Gourmand','Aromático'],
  café:            ['Gourmand','Aromático'],
  cafe:            ['Gourmand','Aromático'],
  honey:           ['Dulce','Floral'],
  miel:            ['Dulce','Floral'],
  almond:          ['Gourmand','Dulce'],
  almendra:        ['Gourmand','Dulce'],
  praline:         ['Gourmand','Dulce'],
  rum:             ['Gourmand','Especiado'],
  ron:             ['Gourmand','Especiado'],

  // POWERHOUSE SYNTHETICS
  ambroxan:        ['Sensual','Ambarado'],
  ambróxan:        ['Sensual','Ambarado'],
  ambrox:          ['Sensual','Ambarado'],
  hedione:         ['Floral','Fresco'],
  cashmeran:       ['Amaderado','Sensual'],
  cachemirán:      ['Amaderado','Sensual'],
  'iso e super':   ['Amaderado','Sensual'],
};

// ── Sillage → chord bonus ─────────────────────────────────────────────────────
// Heavy sillage adds Sensual; light adds Fresco
const SILLAGE_BONUS = {
  'very strong':       'Sensual',
  'strong':            'Cálido',
  'light to moderate': 'Fresco',
  'light':             'Fresco',
  'intimate':          'Sensual',
};

// ── Score and rank ────────────────────────────────────────────────────────────
// Tier multipliers — base notes define the fragrance's character more than top notes
const TIER_WEIGHT = { base: 2.0, mid: 1.5, top: 1.0, notes: 1.0 };

function scoreNoteTier(notesStr, tierWeight, scores) {
  if (!notesStr) return;
  const notes = notesStr.toLowerCase();
  for (const [keyword, chords] of Object.entries(NOTE_SIGNALS)) {
    if (notes.includes(keyword)) {
      chords.forEach(c => {
        scores[c] = (scores[c] || 0) + tierWeight;
      });
    }
  }
}

function calcChords(product) {
  const scores = {};

  // Score each tier with its weight — base counts double, heart 1.5x, top 1x
  scoreNoteTier(product.base,  TIER_WEIGHT.base,  scores);
  scoreNoteTier(product.mid,   TIER_WEIGHT.mid,   scores);
  scoreNoteTier(product.top,   TIER_WEIGHT.top,   scores);
  scoreNoteTier(product.notes, TIER_WEIGHT.notes,  scores);

  // Sillage bonus
  if (product.sillage) {
    const s = product.sillage.toLowerCase();
    for (const [key, chord] of Object.entries(SILLAGE_BONUS)) {
      if (s.includes(key)) {
        scores[chord] = (scores[chord] || 0) + 0.75; // slightly heavier bonus
        break;
      }
    }
  }

  // Sort by score descending, take top 4-5
  const ranked = Object.entries(scores)
    .filter(([, v]) => v >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

  // Deduplicate overlapping chords — don't return both Cítrico and Fresco
  // if Fresco is already dominant
  const seen = new Set();
  const result = [];
  for (const chord of ranked) {
    if (result.length >= 5) break;
    if (!seen.has(chord)) {
      seen.add(chord);
      result.push(chord);
    }
  }

  // Minimum 3, maximum 5
  return result.slice(0, 5);
}

module.exports = { calcChords };
