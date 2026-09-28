'use strict';
const crypto = require('crypto');
const { RANKS, VARIANTS, getRules } = require('./variants');
const { evaluateHand, compareHands, validCard, cardLabel } = require('./hands');

const rooms = new Map();
const COLORS = ['#e4572e', '#f2b134', '#2fa39a', '#4f7cac', '#9b6dd6', '#e26fa9', '#3fbbe0', '#8cbf3f', '#ff8f3c', '#a3a9b8'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const now = () => Date.now();

const DEFAULTS = {
  maxPlayers: 3,           // default room is 3 players
  startCoins: 10000,
  boot: 100,
  timer: 15,
  timeoutAction: 'fold',   // fold | call
  variant: 'classic',
  customWild: [],
  customLowest: false,
  direction: 'cw',         // cw | ccw
  firstPlayer: 'rotate',   // host | rotate | random
  sideShow: true,
  verify: false,           // Verify mode: contenders enter their cards, server compares
  maxStakeMult: 64,        // max stake = boot * this
};

const clampInt = (v, lo, hi, d) => {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, v));
};
const pick = (v, list, d) => (list.includes(v) ? v : d);

function sanitizeSettings(i = {}, prev = DEFAULTS) {
  const s = { ...DEFAULTS, ...prev };
  if (i.maxPlayers !== undefined) s.maxPlayers = clampInt(i.maxPlayers, 2, 10, s.maxPlayers);
  if (i.startCoins !== undefined) s.startCoins = clampInt(i.startCoins, 100, 10000000, s.startCoins);
  if (i.boot !== undefined) s.boot = clampInt(i.boot, 1, 1000000, s.boot);
  if (s.boot > s.startCoins) s.boot = s.startCoins;
  if (i.timer !== undefined) s.timer = clampInt(i.timer, 5, 120, s.timer);
  if (i.timeoutAction !== undefined) s.timeoutAction = pick(i.timeoutAction, ['fold', 'call'], s.timeoutAction);
  if (i.variant !== undefined) s.variant = VARIANTS[i.variant] ? i.variant : s.variant;
  if (Array.isArray(i.customWild)) s.customWild = [...new Set(i.customWild.filter((r) => RANKS.includes(r)))].slice(0, 6);
  if (i.customLowest !== undefined) s.customLowest = !!i.customLowest;
  if (i.direction !== undefined) s.direction = pick(i.direction, ['cw', 'ccw'], s.direction);
  if (i.firstPlayer !== undefined) s.firstPlayer = pick(i.firstPlayer, ['host', 'rotate', 'random'], s.firstPlayer);
  if (i.sideShow !== undefined) s.sideShow = !!i.sideShow;
  if (i.verify !== undefined) s.verify = !!i.verify;
  if (i.maxStakeMult !== undefined) s.maxStakeMult = clampInt(i.maxStakeMult, 2, 10000, s.maxStakeMult);
  return s;
}

// ---------- helpers ----------
function genCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function newPlayer(room, name, color) {
  let id;
  do { id = 'P-' + crypto.randomInt(1000, 10000); } while (room.players.some((p) => p.id === id));
  return {
    id,
    token: crypto.randomBytes(12).toString('hex'),   // secret: proves identity on reconnect
    name: cleanName(name),
    color,
    coins: room.settings.startCoins,
    connected: true,
    left: false,
    ready: false,
    lastActionId: null,
    ws: null,
    send: null,
    inRound: false, folded: false, seen: false, contributed: 0,
    cards: null,
    stats: { games: 0, wins: 0, losses: 0, coinsWon: 0, coinsLost: 0, bestPot: 0 },
  };
}

function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return n || 'Player';
}

const byId = (room, id) => room.players.find((p) => p.id === id);
const log = (room, text) => {
  room.logN += 1;
  room.log.push({ n: room.logN, text });
  if (room.log.length > 60) room.log.shift();
};

function active(room) {
  const g = room.game;
  if (!g) return [];
  return g.order.map((id) => byId(room, id)).filter((p) => p && !p.folded);
}

function stepFrom(room, fromId, dir) {
  const g = room.game;
  const n = g.order.length;
  let i = g.order.indexOf(fromId);
  if (i < 0) i = 0;
  const step = (room.settings.direction === 'cw' ? 1 : -1) * dir;
  for (let k = 1; k <= n; k++) {
    const p = byId(room, g.order[(((i + step * k) % n) + n) % n]);
    if (p && !p.folded) return p;
  }
  return null;
}
const nextActive = (room, id) => stepFrom(room, id, 1);
const prevActive = (room, id) => stepFrom(room, id, -1);

const callAmount = (g, p) => (p.seen ? g.stake * 2 : g.stake);
const mult = (p) => (p.seen ? 2 : 1);

function pay(room, p, amt) {
  amt = Math.min(amt, p.coins);
  p.coins -= amt;
  p.contributed += amt;
  room.game.pot += amt;
  return amt;
}

function setDeadline(room, seconds) {
  room.game.deadline = now() + seconds * 1000;
}

function raiseInfo(room, p) {
  const g = room.game;
  const boot = room.settings.boot;
  const maxStake = boot * room.settings.maxStakeMult;
  const m = mult(p);
  const lo = g.stake + 1;
  const hi = Math.min(g.stake * 2, maxStake, Math.floor(p.coins / m));
  if (hi < lo) return null;
  let list = [];
  for (let v = g.stake + boot; v <= hi; v += boot) list.push(v);
  if (!list.length) list = [hi];
  if (list.length > 8) {
    const out = [];
    for (let i = 0; i < 8; i++) out.push(list[Math.round((i * (list.length - 1)) / 7)]);
    list = [...new Set(out)];
  }
  return { options: list, min: lo, max: hi, mult: m };
}

// ---------- room lifecycle ----------
function createRoom(name, settingsIn, transport) {
  const settings = sanitizeSettings(settingsIn, DEFAULTS);
  const code = genCode();
  const room = {
    code, settings, players: [], hostId: null,
    phase: 'lobby', paused: false, started: false,
    game: null, rot: 0, log: [], logN: 0, chat: [],
    emptySince: null,
  };
  rooms.set(code, room);
  const p = newPlayer(room, name, COLORS[0]);
  room.players.push(p);
  room.hostId = p.id;
  attach(room, p, transport);
  log(room, `${p.name} created the room`);
  return { room, player: p };
}

function attach(room, p, transport) {
  if (p.ws && p.ws !== transport.ws) { try { p.ws.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
  p.ws = transport.ws;
  p.send = transport.send;
  p.connected = true;
  room.emptySince = null;
}

function joinRoom(code, name, token, transport) {
  const room = rooms.get(String(code || '').toUpperCase().trim());
  if (!room) return { error: 'Room not found. Check the code.' };
  if (token) {
    const existing = room.players.find((p) => p.token === token && !p.left);
    if (existing) {
      attach(room, existing, transport);
      log(room, `${existing.name} reconnected`);
      return { room, player: existing, resumed: true };
    }
  }
  if (!name) return { error: 'Enter your name first.' };
  const live = room.players.filter((p) => !p.left);
  if (live.length >= room.settings.maxPlayers) return { error: 'Room is full.' };
  const used = new Set(room.players.map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[room.players.length % COLORS.length];
  const p = newPlayer(room, name, color);
  room.players.push(p);
  attach(room, p, transport);
  log(room, `${p.name} joined`);
  return { room, player: p };
}

function disconnect(room, p, ws) {
  if (p.ws !== ws) return;               // already replaced by a newer connection
  p.connected = false;
  p.ws = null;
  p.send = null;
  if (!p.left) log(room, `${p.name} disconnected`);
  if (room.players.every((x) => !x.connected)) room.emptySince = now();
  reassignHost(room);
  broadcast(room);
}

function reassignHost(room) {
  const h = byId(room, room.hostId);
  if (h && !h.left && h.connected) return;
  const next = room.players.find((p) => !p.left && p.connected);
  if (next) { room.hostId = next.id; log(room, `${next.name} is now the host`); }
}

function removePlayer(room, p) {
  room.players = room.players.filter((x) => x !== p);
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) {
    const next = room.players.find((x) => !x.left && x.connected) || room.players.find((x) => !x.left) || room.players[0];
    room.hostId = next.id;
    log(room, `${next.name} is now the host`);
  }
}

function leave(room, p) {
  const playing = room.game && p.inRound && !p.folded &&
    ['dealing', 'betting', 'sideshow', 'showdown'].includes(room.phase);
  log(room, `${p.name} left`);
  if (room.phase === 'lobby' || !room.game || !p.inRound) {
    removePlayer(room, p);
    return;
  }
  p.left = true;
  p.connected = false;
  p.ws = null; p.send = null;
  if (playing) { p.folded = true; afterRemoval(room, p); }
  reassignHost(room);
  if (room.hostId === p.id) {
    const next = room.players.find((x) => !x.left);
    if (next) room.hostId = next.id;
  }
}

// ---------- round flow ----------
function startRound(room) {
  room.players = room.players.filter((p) => !p.left);
  const boot = room.settings.boot;
  const parts = room.players.filter((p) => p.coins >= boot);
  if (parts.length < 2) return 'Need at least 2 players with enough coins for the boot.';
  room.players.forEach((p) => { p.inRound = false; p.folded = false; p.seen = false; p.contributed = 0; p.cards = null; p.ready = false; });
  parts.forEach((p) => { p.inRound = true; p.coins -= boot; p.contributed = boot; });

  let first;
  const fp = room.settings.firstPlayer;
  if (fp === 'host') first = parts.find((p) => p.id === room.hostId) || parts[0];
  else if (fp === 'random') first = parts[crypto.randomInt(parts.length)];
  else { first = parts[room.rot % parts.length]; room.rot += 1; }

  const rules = getRules(room.settings);
  const wildRanks = rules.randomJoker ? [RANKS[crypto.randomInt(RANKS.length)]] : rules.wild;
  room.game = {
    round: ((room.game && room.game.round) || 0) + 1,
    pot: boot * parts.length,
    stake: boot,
    order: parts.map((p) => p.id),
    firstId: first.id,
    turnId: null,
    deadline: null, remaining: null,
    sideshow: null, showdown: null, result: null,
    wildRanks, lowestWild: rules.lowestWild, lowest: rules.lowest,
  };
  room.phase = 'dealing';
  room.started = true;
  log(room, `Round ${room.game.round}: boot ${boot} from ${parts.length} players. Pot ${room.game.pot}.`);
  if (wildRanks.length && rules.randomJoker) log(room, `Joker this round: ${wildRanks[0]}`);
  return null;
}

function cardsDealt(room) {
  const g = room.game;
  let first = byId(room, g.firstId);
  if (!first || first.folded) first = nextActive(room, g.firstId);
  room.phase = 'betting';
  g.turnId = first.id;
  setDeadline(room, room.settings.timer);
  log(room, `Cards dealt. ${first.name} acts first.`);
}

function advanceFrom(room, id) {
  const g = room.game;
  const next = nextActive(room, id);
  g.turnId = next.id;
  setDeadline(room, room.settings.timer);
}

function afterRemoval(room, p) {
  const g = room.game;
  const act = active(room);
  if (act.length <= 1) {
    if (act.length === 1) endRound(room, [act[0]], 'Last player standing');
    else { room.phase = 'settled'; g.deadline = null; g.result = { winnerIds: [], pot: g.pot, reason: 'Everyone left', hands: null }; }
    return;
  }
  if (room.phase === 'sideshow' && g.sideshow && (g.sideshow.fromId === p.id || g.sideshow.toId === p.id)) {
    const from = g.sideshow.fromId;
    g.sideshow = null;
    room.phase = 'betting';
    advanceFrom(room, from);
    return;
  }
  if (room.phase === 'betting' && g.turnId === p.id) advanceFrom(room, p.id);
}

function endRound(room, winners, reason, hands) {
  const g = room.game;
  const share = Math.floor(g.pot / winners.length);
  const rem = g.pot - share * winners.length;
  winners.forEach((w, i) => { w.coins += share + (i === 0 ? rem : 0); });
  const parts = g.order.map((id) => byId(room, id)).filter(Boolean);
  for (const p of parts) {
    p.stats.games += 1;
    const isWinner = winners.includes(p);
    const got = isWinner ? share : 0;
    const net = got - p.contributed;
    if (isWinner) { p.stats.wins += 1; p.stats.bestPot = Math.max(p.stats.bestPot, g.pot); } else p.stats.losses += 1;
    if (net > 0) p.stats.coinsWon += net; else p.stats.coinsLost += -net;
  }
  g.result = { winnerIds: winners.map((w) => w.id), pot: g.pot, reason, hands: hands || null };
  g.deadline = null;
  g.sideshow = null;
  room.phase = 'settled';
  log(room, `${winners.map((w) => w.name).join(' & ')} won ${g.pot} (${reason})`);
}

// ---------- player actions ----------
function doFold(room, p, why) {
  p.folded = true;
  log(room, `${p.name} folded${why ? ` (${why})` : ''}`);
  afterRemoval(room, p);
}

function doCall(room, p) {
  const g = room.game;
  const amt = callAmount(g, p);
  pay(room, p, amt);
  log(room, `${p.name} ${p.seen ? 'called' : 'played blind for'} ${amt}`);
  advanceFrom(room, p.id);
}

function onTimeout(room) {
  const g = room.game;
  g.deadline = null;
  if (room.phase === 'betting') {
    const p = byId(room, g.turnId);
    if (!p) return;
    if (room.settings.timeoutAction === 'call' && p.coins >= callAmount(g, p)) {
      log(room, `${p.name} timed out`);
      doCall(room, p);
    } else doFold(room, p, 'timeout');
  } else if (room.phase === 'sideshow' && g.sideshow && g.sideshow.stage === 'ask') {
    rejectSideShow(room, 'timeout');
  }
}

function rejectSideShow(room, why) {
  const g = room.game;
  const ss = g.sideshow;
  const to = byId(room, ss.toId);
  log(room, `${to ? to.name : 'Target'} rejected the side show${why ? ` (${why})` : ''}`);
  g.sideshow = null;
  room.phase = 'betting';
  advanceFrom(room, ss.fromId);
}

function handle(room, p, a) {
  if (!a || typeof a.type !== 'string') return 'Bad action.';
  if (a.aid && a.aid === p.lastActionId) return 'silent';
  if (a.aid) p.lastActionId = a.aid;
  const g = room.game;
  const host = room.hostId === p.id;
  const alwaysOk = ['resume', 'leave', 'chat', 'react', 'ready'];
  if (room.paused && !alwaysOk.includes(a.type)) return 'Game is paused.';

  switch (a.type) {
    case 'ready': {
      if (room.phase !== 'lobby') return 'Can only toggle ready in the lobby.';
      p.ready = a.ready !== undefined ? !!a.ready : !p.ready;
      log(room, `${p.name} is ${p.ready ? 'ready' : 'waiting'}`);
      return null;
    }
    case 'settings': {
      if (!host || room.phase !== 'lobby') return 'Only the host can change rules, before the game starts.';
      const prevStart = room.settings.startCoins;
      room.settings = sanitizeSettings(a.settings, room.settings);
      const live = room.players.filter((x) => !x.left).length;
      if (room.settings.maxPlayers < live) room.settings.maxPlayers = live;
      if (!room.started && room.settings.startCoins !== prevStart) room.players.forEach((x) => { x.coins = room.settings.startCoins; });
      return null;
    }
    case 'resetCoins': {
      if (!host || room.phase !== 'lobby') return 'Only the host can do that in the lobby.';
      room.players.forEach((x) => {
        x.coins = room.settings.startCoins;
        x.stats = { games: 0, wins: 0, losses: 0, coinsWon: 0, coinsLost: 0, bestPot: 0 };
      });
      log(room, 'Balances and stats reset');
      return null;
    }
    case 'topUp': {
      if (!host) return 'Only the host can top up players.';
      const amt = room.settings.startCoins;
      room.players.forEach((x) => {
        if (x.coins < room.settings.boot) x.coins = amt;
      });
      log(room, `Broke players topped up to ${amt} coins`);
      return null;
    }
    case 'start': {
      if (!host || room.phase !== 'lobby') return 'Only the host can start the game.';
      if (!room.started) room.players.forEach((x) => { x.coins = room.settings.startCoins; });
      return startRound(room);
    }
    case 'cardsDealt': {
      if (!host || room.phase !== 'dealing') return 'Only the host can confirm the deal.';
      cardsDealt(room);
      return null;
    }
    case 'seen': {
      if (!['betting', 'sideshow'].includes(room.phase)) return 'Cards are not dealt yet.';
      if (!p.inRound || p.folded) return 'You are not in this round.';
      if (p.seen) return null;
      p.seen = true;
      log(room, `${p.name} has seen their cards`);
      return null;
    }
    case 'call': {
      if (room.phase !== 'betting' || g.turnId !== p.id) return 'Not your turn.';
      if (p.coins < callAmount(g, p)) return 'Not enough coins to call. Fold or Show.';
      doCall(room, p);
      return null;
    }
    case 'raise': {
      if (room.phase !== 'betting' || g.turnId !== p.id) return 'Not your turn.';
      const info = raiseInfo(room, p);
      const stake = Math.floor(Number(a.stake));
      if (!info || !Number.isFinite(stake) || stake < info.min || stake > info.max) return 'That raise is not allowed.';
      const amt = stake * info.mult;
      g.stake = stake;
      pay(room, p, amt);
      log(room, `${p.name} raised the stake to ${stake} (paid ${amt})`);
      advanceFrom(room, p.id);
      return null;
    }
    case 'fold': {
      if (room.phase !== 'betting' || g.turnId !== p.id) return 'Not your turn.';
      doFold(room, p);
      return null;
    }
    case 'show': {
      if (room.phase !== 'betting' || g.turnId !== p.id) return 'Not your turn.';
      const act = active(room);
      if (act.length !== 2) return 'Show is only allowed when 2 players are left.';
      const amt = pay(room, p, callAmount(g, p));
      const other = act.find((x) => x !== p);
      g.showdown = { contenders: [p.id, other.id], requesterId: p.id, submitted: {} };
      room.phase = 'showdown';
      g.deadline = null;
      log(room, `${p.name} asked for a SHOW against ${other.name} (paid ${amt})`);
      return null;
    }
    case 'sideshow': {
      if (!room.settings.sideShow) return 'Side show is off in this room.';
      if (room.phase !== 'betting' || g.turnId !== p.id) return 'Not your turn.';
      if (active(room).length < 3) return 'Side show needs 3 or more players.';
      const target = prevActive(room, p.id);
      if (!p.seen || !target || !target.seen) return 'Both players must have seen their cards.';
      const amt = callAmount(g, p);
      if (p.coins < amt) return 'Not enough coins.';
      pay(room, p, amt);
      g.sideshow = { fromId: p.id, toId: target.id, stage: 'ask' };
      room.phase = 'sideshow';
      setDeadline(room, room.settings.timer);
      log(room, `${p.name} asked ${target.name} for a side show (paid ${amt})`);
      return null;
    }
    case 'sideshowReply': {
      const ss = g && g.sideshow;
      if (room.phase !== 'sideshow' || !ss || ss.stage !== 'ask' || ss.toId !== p.id) return 'No side show request for you.';
      if (a.accept) {
        ss.stage = 'resolve';
        g.deadline = null;
        log(room, `${p.name} accepted the side show. Compare cards, then host picks the loser.`);
      } else rejectSideShow(room, '');
      return null;
    }
    case 'sideshowResult': {
      const ss = g && g.sideshow;
      if (room.phase !== 'sideshow' || !ss || ss.stage !== 'resolve') return 'No side show to resolve.';
      if (!host) return 'Only the host can pick the side show loser.';
      if (![ss.fromId, ss.toId].includes(a.loserId)) return 'Pick one of the two players.';
      const loser = byId(room, a.loserId);
      loser.folded = true;
      log(room, `${loser.name} lost the side show and is out`);
      g.sideshow = null;
      room.phase = 'betting';
      const act = active(room);
      if (act.length === 1) { endRound(room, [act[0]], 'Last player standing'); return null; }
      advanceFrom(room, ss.fromId);
      return null;
    }
    case 'cards': {
      if (room.phase !== 'showdown' || !room.settings.verify) return 'Verify mode is not active.';
      const sd = g.showdown;
      if (!sd.contenders.includes(p.id)) return 'Only the two players in the show enter cards.';
      if (!Array.isArray(a.cards) || a.cards.length !== 3 || !a.cards.every(validCard)) return 'Enter 3 valid cards.';
      const keys = new Set(a.cards.map((c) => c.r + c.s));
      if (keys.size !== 3) return 'A hand cannot repeat a card.';
      p.cards = a.cards.map((c) => ({ r: c.r, s: c.s }));
      sd.submitted[p.id] = true;
      log(room, `${p.name} entered their cards`);
      if (sd.contenders.every((id) => sd.submitted[id])) {
        const [a1, b1] = sd.contenders.map((id) => byId(room, id));
        const rules = { wild: g.wildRanks, lowestWild: g.lowestWild };
        const ha = evaluateHand(a1.cards, rules);
        const hb = evaluateHand(b1.cards, rules);
        const c = compareHands(ha, hb, g.lowest);
        const hands = {
          [a1.id]: { cards: a1.cards.map(cardLabel), name: ha.name },
          [b1.id]: { cards: b1.cards.map(cardLabel), name: hb.name },
        };
        if (c === 0) {
          const winner = sd.requesterId === a1.id ? b1 : a1;
          endRound(room, [winner], 'Tie: the player who asked for the show loses', hands);
        } else endRound(room, [c > 0 ? a1 : b1], `${(c > 0 ? ha : hb).name} wins`, hands);
      }
      return null;
    }
    case 'winner': {
      if (!host) return 'Only the host can pick the winner.';
      if (room.phase !== 'showdown') return 'No showdown is in progress.';
      const sd = g.showdown;
      if (a.winnerId === 'split') { endRound(room, sd.contenders.map((id) => byId(room, id)), 'Pot split by host'); return null; }
      if (!sd.contenders.includes(a.winnerId)) return 'Pick one of the two players in the show.';
      endRound(room, [byId(room, a.winnerId)], 'Host confirmed the winner');
      return null;
    }
    case 'next': {
      if (!host || room.phase !== 'settled') return 'Only the host can start the next round.';
      return startRound(room);
    }
    case 'end': {
      if (!host || !['settled', 'dealing', 'betting', 'showdown', 'sideshow'].includes(room.phase)) return 'Only the host can end the game.';
      if (room.phase !== 'settled') {
        // refund everyone's contributions for the aborted round
        room.players.forEach((x) => { if (x.inRound) { x.coins += x.contributed; x.contributed = 0; } });
        log(room, 'Round cancelled, coins refunded');
      }
      room.players = room.players.filter((x) => !x.left);
      room.players.forEach((x) => { x.inRound = false; x.folded = false; x.seen = false; x.cards = null; });
      room.game = null;
      room.phase = 'lobby';
      room.paused = false;
      log(room, 'Back in the lobby');
      return null;
    }
    case 'pause': {
      if (!host || room.phase === 'lobby') return 'Only the host can pause a running game.';
      if (room.paused) return null;
      room.paused = true;
      if (g && g.deadline) { g.remaining = Math.max(0, g.deadline - now()); g.deadline = null; }
      log(room, 'Game paused');
      return null;
    }
    case 'resume': {
      if (!host) return 'Only the host can resume.';
      if (!room.paused) return null;
      room.paused = false;
      if (g && g.remaining != null) { g.deadline = now() + Math.max(1000, g.remaining); g.remaining = null; }
      log(room, 'Game resumed');
      return null;
    }
    case 'kick': {
      if (!host) return 'Only the host can remove players.';
      const t = byId(room, a.playerId);
      if (!t || t.id === p.id) return 'Cannot remove that player.';
      const ws = t.ws;
      const sendFn = t.send;
      if (sendFn) sendFn({ t: 'kicked' });
      leave(room, t);
      if (ws) { try { ws.close(4001, 'kicked'); } catch (e) { /* ignore */ } }
      return null;
    }
    case 'chat': {
      const text = String(a.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
      if (!text) return null;
      const t = now();
      if (p.lastChat && t - p.lastChat < 800) return 'Slow down a little.';
      p.lastChat = t;
      room.chat.push({ id: p.id, name: p.name, color: p.color, text, ts: t });
      if (room.chat.length > 40) room.chat.shift();
      return null;
    }
    case 'react': {
      const allowed = ['😂', '🔥', '😎', '👀', 'GG'];
      if (!allowed.includes(a.emoji)) return null;
      const t = now();
      if (p.lastReact && t - p.lastReact < 700) return null;
      p.lastReact = t;
      for (const x of room.players) if (x.send) x.send({ t: 'react', id: p.id, emoji: a.emoji });
      return 'silent';
    }
    default:
      return 'Unknown action.';
  }
}

// ---------- views ----------
function actionsFor(room, p) {
  const g = room.game;
  const out = {};
  if (!g || !p.inRound || p.folded || room.paused) return out;
  if (room.phase === 'betting') {
    if (!p.seen) out.canSeen = true;
    if (g.turnId === p.id) {
      const amt = callAmount(g, p);
      out.call = { amount: amt, ok: p.coins >= amt, blind: !p.seen };
      out.raise = raiseInfo(room, p);
      out.fold = true;
      const act = active(room);
      out.show = act.length === 2 ? { amount: Math.min(amt, p.coins) } : null;
      if (room.settings.sideShow && act.length >= 3 && p.seen && p.coins >= amt) {
        const t = prevActive(room, p.id);
        if (t && t.seen) out.sideshow = { targetId: t.id, amount: amt };
      }
    }
  } else if (room.phase === 'sideshow') {
    if (!p.seen) out.canSeen = true;
  }
  return out;
}

function view(room, me) {
  const g = room.game;
  const resultIds = g && g.result ? g.result.winnerIds : [];
  return {
    code: room.code,
    now: now(),
    you: me.id,
    hostId: room.hostId,
    phase: room.phase,
    paused: room.paused,
    started: room.started,
    settings: room.settings,
    rules: getRules(room.settings),
    variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, { label: v.label, desc: v.desc }])),
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, coins: p.coins,
      contributed: p.contributed || 0,
      connected: p.connected, left: p.left,
      isHost: p.id === room.hostId,
      ready: p.id === room.hostId ? true : !!p.ready,
      inRound: p.inRound, folded: p.folded, seen: p.seen,
      winner: resultIds.includes(p.id),
      stats: p.stats,
    })),
    game: g ? {
      round: g.round, pot: g.pot, stake: g.stake, turnId: g.turnId, firstId: g.firstId,
      deadline: g.deadline, remaining: g.remaining,
      wildRanks: g.wildRanks, lowestWild: g.lowestWild, lowest: g.lowest,
      sideshow: g.sideshow,
      showdown: g.showdown ? {
        contenders: g.showdown.contenders, requesterId: g.showdown.requesterId,
        submitted: Object.keys(g.showdown.submitted),
      } : null,
      result: g.result,
      order: g.order,
    } : null,
    actions: actionsFor(room, me),
    log: room.log.slice(-25),
    chat: room.chat,
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.send && p.connected) {
      try { p.send({ t: 'state', s: view(room, p) }); } catch (e) { /* socket gone */ }
    }
  }
}

// ---------- server clock ----------
let ticker = null;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const t = now();
    for (const [code, room] of rooms) {
      if (room.emptySince && t - room.emptySince > 15 * 60 * 1000) { rooms.delete(code); continue; }
      const g = room.game;
      if (g && g.deadline && !room.paused && t >= g.deadline) {
        try { onTimeout(room); } catch (e) { console.error('timeout error', e); }
        broadcast(room);
      }
    }
  }, 500);
  ticker.unref && ticker.unref();
}

function stats() {
  let players = 0;
  for (const r of rooms.values()) players += r.players.filter((p) => p.connected).length;
  return { rooms: rooms.size, players };
}

module.exports = {
  createRoom, joinRoom, disconnect, leave, handle, broadcast, startTicker, stats,
  // exposed for tests
  _rooms: rooms, _view: view, _onTimeout: onTimeout,
};
