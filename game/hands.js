'use strict';
const { RANKS, SUITS } = require('./variants');

const rv = (r) => RANKS.indexOf(r) + 2;       // 2..14 (A = 14)
const rn = (v) => RANKS[v - 2];

const DECK = [];
for (const s of SUITS) for (const r of RANKS) DECK.push({ v: rv(r), s });

// Hand value = array compared lexicographically.
// [category, ...tiebreakers]  6 Trail, 5 Pure Sequence, 4 Sequence, 3 Color, 2 Pair, 1 High Card
function evalFixed(cs) {
  const v = cs.map((c) => c.v).sort((a, b) => b - a);
  const flush = cs[0].s === cs[1].s && cs[1].s === cs[2].s;
  let seqVal = 0;
  if (v[0] - v[1] === 1 && v[1] - v[2] === 1) seqVal = v[0];
  else if (v[0] === 14 && v[1] === 3 && v[2] === 2) seqVal = 13.5; // A-2-3: below A-K-Q, above K-Q-J
  if (v[0] === v[1] && v[1] === v[2]) return [6, v[0]];
  if (seqVal && flush) return [5, seqVal];
  if (seqVal) return [4, seqVal];
  if (flush) return [3, ...v];
  if (v[0] === v[1]) return [2, v[0], v[2]];
  if (v[1] === v[2]) return [2, v[1], v[0]];
  return [1, ...v];
}

function cmp(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function seqName(top) {
  if (top === 13.5) return 'A-2-3';
  return `${rn(top)}-${rn(top - 1)}-${rn(top - 2)}`;
}

function describe(val) {
  switch (val[0]) {
    case 6: return `Trail of ${rn(val[1])}s`;
    case 5: return `Pure Sequence ${seqName(val[1])}`;
    case 4: return `Sequence ${seqName(val[1])}`;
    case 3: return `Color, ${rn(val[1])} high`;
    case 2: return `Pair of ${rn(val[1])}s`;
    default: return `High Card ${rn(val[1])}`;
  }
}

function validCard(c) {
  return c && typeof c === 'object' && RANKS.includes(c.r) && SUITS.includes(c.s);
}

// cards: [{r:'A', s:'S'} x3]; rules: {wild:[ranks], lowestWild:bool, lowest:bool}
function evaluateHand(cards, rules = {}) {
  const cs = cards.map((c) => ({ v: rv(c.r), s: c.s }));
  const wildIdx = [];
  if (rules.lowestWild) {
    const m = Math.min(...cs.map((c) => c.v));
    cs.forEach((c, i) => { if (c.v === m) wildIdx.push(i); });
  } else if (rules.wild && rules.wild.length) {
    const set = new Set(rules.wild.map(rv));
    cs.forEach((c, i) => { if (set.has(c.v)) wildIdx.push(i); });
  }

  // Fast path: if all 3 cards are wild
  if (wildIdx.length === 3) {
    const bestVal = rules.lowest ? [1, 5, 3, 2] : [6, 14];
    return {
      value: bestVal,
      name: (rules.lowest ? 'High Card 5' : 'Trail of As') + ' (3 wild)',
    };
  }

  let best = null;
  const isBetter = (val, curBest) => {
    if (!curBest) return true;
    const c = cmp(val, curBest);
    return rules.lowest ? c < 0 : c > 0;
  };

  const rec = (k, cur) => {
    if (k === wildIdx.length) {
      const val = evalFixed(cur);
      if (isBetter(val, best)) best = val;
      return;
    }
    for (const d of DECK) {
      const nx = cur.slice();
      nx[wildIdx[k]] = d;
      rec(k + 1, nx);
    }
  };
  rec(0, cs);
  return { value: best, name: describe(best) + (wildIdx.length ? ` (${wildIdx.length} wild)` : '') };
}

// returns >0 if a beats b, <0 if b beats a, 0 tie
function compareHands(a, b, lowest) {
  const c = cmp(a.value, b.value);
  return lowest ? -c : c;
}

const cardLabel = (c) => `${c.r}${{ S: '♠', H: '♥', D: '♦', C: '♣' }[c.s]}`;

module.exports = { evaluateHand, compareHands, validCard, cardLabel, evalFixed, cmp };
