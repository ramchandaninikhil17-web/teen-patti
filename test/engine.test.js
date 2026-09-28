'use strict';
const assert = require('assert');
const engine = require('../game/room');
const { evaluateHand, compareHands } = require('../game/hands');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('FAIL  ' + name + '\n', e);
    process.exitCode = 1;
  }
};

const H = (s) => s.split(' ').map((x) => ({ r: x.slice(0, -1), s: x.slice(-1) }));
const beats = (a, b, rules = {}, lowest = false) => compareHands(evaluateHand(H(a), rules), evaluateHand(H(b), rules), lowest) > 0;

console.log('--- Hand Evaluator & Rules Tests ---');
test('standard hand ranking hierarchy (Trail > Pure Seq > Seq > Color > Pair > High Card)', () => {
  assert(beats('AS AH AD', 'KS KH KD'));           // Trail rank
  assert(beats('2S 2H 2D', 'AS KS QS'));           // lowest trail beats highest pure sequence
  assert(beats('AS KS QS', 'AS 2S 3S'));           // Pure Seq: AKQ > A23
  assert(beats('AS 2S 3S', 'KS QS JS'));           // Pure Seq: A23 > KQJ
  assert(beats('KS QS JS', '4S 3S 2S'));           // Pure Seq: KQJ > 432
  assert(beats('4S 3S 2S', 'AS KH QD'));           // lowest pure sequence beats highest normal sequence
  assert(beats('AS KH QD', 'AS 2H 3D'));           // Seq: AKQ > A23
  assert(beats('AS 2H 3D', 'KS QH JD'));           // Seq: A23 > KQJ
  assert(beats('4S 3H 2D', 'AS KS JS'));           // lowest sequence beats highest color/flush
  assert(beats('AS KS JS', 'AS KS 9S'));           // Color: kicker comparison
  assert(beats('AS 5S 2S', 'AS AH KD'));           // lowest color beats highest pair
  assert(beats('3S 3H 2D', '2S 2H AD'));           // Pair rank
  assert(beats('AS AH KD', 'AC AD QH'));           // Pair kicker: K beats Q
  assert(beats('2S 2H AD', 'AS KD 9H'));           // lowest pair beats highest high-card
  assert(beats('AS KH 9D', 'AC KD 8H'));           // High card: 9 kicker beats 8
});

test('exact tie comparisons return 0', () => {
  const a = evaluateHand(H('AS KH 9D')), b = evaluateHand(H('AC KD 9H'));
  assert.strictEqual(compareHands(a, b, false), 0);
  const t1 = evaluateHand(H('KS KH KD')), t2 = evaluateHand(H('KC KD KS'));
  assert.strictEqual(compareHands(t1, t2, false), 0);
});

test('muflis variant correctly reverses hand rankings', () => {
  // In Muflis, lowest hand wins
  assert(beats('2S 3H 5D', 'AS KH QD', {}, true)); // 5-3-2 unsuited beats AKQ
  assert(beats('AS KH QD', 'AS AH AD', {}, true)); // High card beats Trail
  assert(!beats('AS AH AD', '2S 3H 5D', {}, true));
});

test('wild cards in AK47, Joker, and Lowest Joker', () => {
  // AK47: A, K, 4, 7 are wild
  const akHand = evaluateHand(H('AS 4H 9D'), { wild: ['A', 'K', '4', '7'] });
  assert(akHand.name.startsWith('Trail'));
  // Single wild card making trail
  const r = evaluateHand(H('7S 9H 9D'), { wild: ['7'] });
  assert(r.name.includes('Trail of 9s') || r.name.includes('Trail'));
  // Lowest joker makes lowest card wild
  const lj = evaluateHand(H('2S 9H 9D'), { lowestWild: true });
  assert(lj.name.includes('Trail'));
  // 3 wild cards returns Trail of Aces instantly
  const allWild = evaluateHand(H('AS KH 4D'), { wild: ['A', 'K', '4', '7'] });
  assert(allWild.name.includes('Trail of As'));
});

console.log('\n--- Room Engine & Multiplayer Tests ---');
function mkPlayer() {
  const inbox = [];
  const t = { ws: { close() {} }, send: (m) => inbox.push(m) };
  return { t, inbox };
}

function setup(n, settings = {}) {
  const t0 = mkPlayer();
  const { room, player } = engine.createRoom('P0', { maxPlayers: n, ...settings }, t0.t);
  const ps = [player];
  for (let i = 1; i < n; i++) {
    const r = engine.joinRoom(room.code, 'P' + i, null, mkPlayer().t);
    assert(!r.error, r.error);
    ps.push(r.player);
  }
  return { room, ps };
}

const act = (room, p, a) => engine.handle(room, p, a);
const turn = (room) => room.players.find((p) => p.id === room.game.turnId);
const begin = (room, ps) => {
  assert.strictEqual(act(room, ps[0], { type: 'start' }), null);
  assert.strictEqual(act(room, ps[0], { type: 'cardsDealt' }), null);
};

// Test all player counts 2 to 10
for (let count = 2; count <= 10; count++) {
  test(`engine supports ${count} players in room`, () => {
    const { room, ps } = setup(count, { boot: 100 });
    assert.strictEqual(room.players.length, count);
    begin(room, ps);
    assert.strictEqual(room.game.pot, 100 * count);
    assert.strictEqual(room.phase, 'betting');
    const cur = turn(room);
    assert(cur);
    // current player calls
    assert.strictEqual(act(room, cur, { type: 'call' }), null);
    assert.strictEqual(room.game.pot, 100 * count + 100);
  });
}

test('lobby: room maxPlayers enforces limit, reject when full', () => {
  const { room } = setup(3, { maxPlayers: 3 });
  const extra = engine.joinRoom(room.code, 'ExtraPlayer', null, mkPlayer().t);
  assert(extra.error && extra.error.includes('full'), 'Should reject 4th player in 3-player room');
});

test('lobby: ready state toggle works and is visible in view', () => {
  const { room, ps } = setup(3);
  const p1 = ps[1];
  assert.strictEqual(act(room, p1, { type: 'ready' }), null);
  assert.strictEqual(p1.ready, true);
  const v = engine._view(room, p1);
  const p1View = v.players.find((x) => x.id === p1.id);
  assert.strictEqual(p1View.ready, true);
  // toggle off
  assert.strictEqual(act(room, p1, { type: 'ready' }), null);
  assert.strictEqual(p1.ready, false);
});

test('idempotency: duplicate action IDs are ignored silently', () => {
  const { room, ps } = setup(2, { firstPlayer: 'host' });
  begin(room, ps);
  const cur = turn(room);
  assert.strictEqual(act(room, cur, { type: 'call', aid: 'act-101' }), null);
  const potAfterCall = room.game.pot;
  // Send same action again with same aid
  const duplicateResult = act(room, cur, { type: 'call', aid: 'act-101' });
  assert.strictEqual(duplicateResult, 'silent');
  assert.strictEqual(room.game.pot, potAfterCall, 'Duplicate action should not change pot');
});

test('blind/seen call amounts, raise limits', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  let p = turn(room);
  assert.strictEqual(p, ps[0]);
  assert(act(room, ps[1], { type: 'call' }));                 // not your turn
  act(room, p, { type: 'seen' });
  const v = engine._view(room, p);
  assert.strictEqual(v.actions.call.amount, 200);             // seen pays double
  assert.strictEqual(v.actions.raise.options[0], 200);        // stake 100 -> max 200
  assert(act(room, p, { type: 'raise', stake: 300 }));        // more than double not allowed
  assert.strictEqual(act(room, p, { type: 'raise', stake: 200 }), null);
  assert.strictEqual(room.game.stake, 200);
  assert.strictEqual(room.game.pot, 300 + 400);               // seen paid 2*200
  assert.strictEqual(p.coins, 10000 - 100 - 400);
  p = turn(room);
  assert.strictEqual(p, ps[1]);                               // blind next
  assert.strictEqual(engine._view(room, p).actions.call.amount, 200);
});

test('fold to last player ends round and pays pot', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  act(room, turn(room), { type: 'call' });
  act(room, turn(room), { type: 'fold' });
  act(room, turn(room), { type: 'fold' });
  assert.strictEqual(room.phase, 'settled');
  assert.strictEqual(room.game.result.winnerIds[0], ps[0].id);
  assert.strictEqual(ps[0].coins, 10000 - 100 - 100 + 400);
  assert.strictEqual(ps[0].stats.wins, 1);
  assert.strictEqual(act(room, ps[0], { type: 'next' }), null);
  assert.strictEqual(room.phase, 'dealing');
  assert.strictEqual(room.game.round, 2);
});

test('dealer rotation', () => {
  const { room, ps } = setup(3, { firstPlayer: 'rotate' });
  begin(room, ps);
  const first1 = room.game.turnId;
  act(room, turn(room), { type: 'fold' }); act(room, turn(room), { type: 'fold' });
  act(room, ps[0], { type: 'next' }); act(room, ps[0], { type: 'cardsDealt' });
  assert.notStrictEqual(room.game.turnId, first1);
});

test('side show accept + host result', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  ps.forEach((p) => act(room, p, { type: 'seen' }));
  act(room, ps[0], { type: 'call' });            // seat order cw: P0 -> P1 -> P2
  const req = turn(room);                        // P1
  const v = engine._view(room, req);
  assert(v.actions.sideshow);
  assert.strictEqual(v.actions.sideshow.targetId, ps[0].id);   // previous active player
  assert.strictEqual(act(room, req, { type: 'sideshow' }), null);
  assert.strictEqual(room.phase, 'sideshow');
  assert(act(room, ps[2], { type: 'sideshowReply', accept: true }));          // wrong player
  assert.strictEqual(act(room, ps[0], { type: 'sideshowReply', accept: true }), null);
  assert(act(room, ps[1], { type: 'sideshowResult', loserId: ps[0].id }));     // not host
  assert.strictEqual(act(room, ps[0], { type: 'sideshowResult', loserId: ps[0].id }), null);
  assert(ps[0].folded);
  assert.strictEqual(room.phase, 'betting');
  assert.strictEqual(room.game.turnId, ps[2].id);
});

test('side show reject moves on', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  ps.forEach((p) => act(room, p, { type: 'seen' }));
  act(room, ps[0], { type: 'call' });
  act(room, ps[1], { type: 'sideshow' });
  act(room, ps[0], { type: 'sideshowReply', accept: false });
  assert.strictEqual(room.phase, 'betting');
  assert.strictEqual(room.game.turnId, ps[2].id);
});

test('show only with 2 left; host picks winner', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  assert(act(room, turn(room), { type: 'show' }));
  act(room, turn(room), { type: 'call' });
  act(room, turn(room), { type: 'fold' });
  assert.strictEqual(engine._view(room, turn(room)).actions.show.amount, 100);
  const showing = turn(room);
  assert.strictEqual(act(room, showing, { type: 'show' }), null);
  assert.strictEqual(room.phase, 'showdown');
  assert(act(room, ps[2], { type: 'winner', winnerId: showing.id }));
  const other = room.game.showdown.contenders.find((id) => id !== showing.id);
  assert.strictEqual(act(room, ps[0], { type: 'winner', winnerId: 'P-0000' }) !== null, true);
  assert.strictEqual(act(room, ps[0], { type: 'winner', winnerId: other }), null);
  assert.strictEqual(room.game.result.winnerIds[0], other);
});

test('verify mode compares physical cards entered by both', () => {
  const { room, ps } = setup(2, { firstPlayer: 'host', verify: true });
  begin(room, ps);
  act(room, turn(room), { type: 'call' });
  const shower = turn(room);
  act(room, shower, { type: 'show' });
  const other = ps.find((p) => p !== shower);
  assert.strictEqual(act(room, shower, { type: 'cards', cards: H('AS KS QS') }), null);
  assert(!engine._view(room, other).game.result);
  assert(act(room, other, { type: 'cards', cards: H('AS AH AD').slice(0, 2) }));   // needs 3
  assert.strictEqual(act(room, other, { type: 'cards', cards: H('9S 9H KD') }), null);
  assert.strictEqual(room.phase, 'settled');
  assert.strictEqual(room.game.result.winnerIds[0], shower.id);
  assert(room.game.result.hands[shower.id].name.includes('Pure Sequence'));
});

test('verify tie: requester of show loses', () => {
  const { room, ps } = setup(2, { firstPlayer: 'host', verify: true });
  begin(room, ps);
  act(room, turn(room), { type: 'call' });
  const shower = turn(room);
  act(room, shower, { type: 'show' });
  const other = ps.find((p) => p !== shower);
  act(room, shower, { type: 'cards', cards: H('AS KH 9D') });
  act(room, other, { type: 'cards', cards: H('AC KD 9H') });
  assert.strictEqual(room.game.result.winnerIds[0], other.id);
});

test('timeout auto-folds, or calls when configured', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  room.game.deadline = Date.now() - 1;
  engine._onTimeout(room);
  assert(ps[0].folded);
  assert.strictEqual(room.game.turnId, ps[1].id);
  const c = setup(3, { firstPlayer: 'host', timeoutAction: 'call' });
  begin(c.room, c.ps);
  engine._onTimeout(c.room);
  assert(!c.ps[0].folded);
  assert.strictEqual(c.room.game.pot, 400);
});

test('pause blocks actions, resume restores timer', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  assert(act(room, ps[1], { type: 'pause' }));
  assert.strictEqual(act(room, ps[0], { type: 'pause' }), null);
  assert(act(room, ps[0], { type: 'call' }));
  assert.strictEqual(room.game.deadline, null);
  assert.strictEqual(act(room, ps[0], { type: 'resume' }), null);
  assert(room.game.deadline > Date.now());
  assert.strictEqual(act(room, ps[0], { type: 'call' }), null);
});

test('leaving mid-game folds; disconnect keeps seat; reconnect resumes', () => {
  const { room, ps } = setup(3, { firstPlayer: 'host' });
  begin(room, ps);
  engine.leave(room, ps[0]);                       // host & current player leaves
  assert(ps[0].folded);
  assert.notStrictEqual(room.hostId, ps[0].id);
  assert.strictEqual(room.game.turnId, ps[1].id);
  const t = mkPlayer();
  const old = ps[2].ws;
  engine.disconnect(room, ps[2], old);
  assert.strictEqual(ps[2].connected, false);
  const r = engine.joinRoom(room.code, null, ps[2].token, t.t);
  assert(r.resumed);
  assert.strictEqual(r.player, ps[2]);
});

test('topUp broke players restored to starting coins', () => {
  const { room, ps } = setup(2, { firstPlayer: 'host', startCoins: 10000, boot: 100 });
  ps[1].coins = 10; // broke
  assert.strictEqual(act(room, ps[0], { type: 'topUp' }), null);
  assert.strictEqual(ps[1].coins, 10000);
});

console.log(`\nAll ${passed} tests passed!`);
