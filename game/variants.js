'use strict';
// Variant engine: a variant is just a small rule bundle. The physical cards stay physical;
// these rules only tell the hand evaluator (Verify mode) how to treat wild cards / ordering.

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['S', 'H', 'D', 'C'];

const VARIANTS = {
  classic:     { label: 'Classic',       desc: 'Highest hand wins. No wild cards.' },
  muflis:      { label: 'Muflis',        desc: 'Lowest hand wins (ranking reversed).', lowest: true },
  ak47:        { label: 'AK47',          desc: 'A, K, 4 and 7 are wild.', wild: ['A', 'K', '4', '7'] },
  joker:       { label: 'Joker',         desc: 'A random rank is wild each round (announced when betting starts).', randomJoker: true },
  nine99:      { label: '999',           desc: 'All 9s are wild. (Use Custom to change this.)', wild: ['9'] },
  lowestJoker: { label: 'Lowest Joker',  desc: 'The lowest card(s) in each hand are wild.', lowestWild: true },
  custom:      { label: 'Custom',        desc: 'Pick your own wild ranks and choose whether lowest wins.' },
};

function getRules(settings) {
  const v = VARIANTS[settings.variant] || VARIANTS.classic;
  if (settings.variant === 'custom') {
    return {
      label: v.label, desc: v.desc,
      wild: settings.customWild || [],
      lowest: !!settings.customLowest,
      lowestWild: false, randomJoker: false,
    };
  }
  return {
    label: v.label, desc: v.desc,
    wild: v.wild || [], lowest: !!v.lowest,
    lowestWild: !!v.lowestWild, randomJoker: !!v.randomJoker,
  };
}

module.exports = { RANKS, SUITS, VARIANTS, getRules };
