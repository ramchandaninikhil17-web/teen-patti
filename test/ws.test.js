'use strict';
const assert = require('assert');
const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');
const engine = require('../game/room');

function waitMsg(ws, filterFn, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for WS message')), timeoutMs);
    const onMessage = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (!filterFn || filterFn(m)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(m);
        }
      } catch (e) { /* ignore */ }
    };
    ws.on('message', onMessage);
  });
}

async function startEphemeralServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    const transport = { ws, send };
    let room = null, player = null;

    const enter = (r, p, resumed) => {
      room = r; player = p;
      send({ t: 'joined', code: r.code, token: p.token, id: p.id, resumed: !!resumed });
      engine.broadcast(r);
    };

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'create') {
        const { room: r, player: p } = engine.createRoom(m.name, m.settings, transport);
        enter(r, p, false);
      } else if (m.t === 'join' || m.t === 'resume') {
        const res = engine.joinRoom(m.code, m.name, m.token, transport);
        if (res.error) { send({ t: 'error', msg: res.error, fatal: m.t === 'resume' }); return; }
        enter(res.room, res.player, res.resumed);
      } else if (m.t === 'act' && room && player) {
        const err = engine.handle(room, player, m.a || {});
        if (err === 'silent') return;
        if (err) { send({ t: 'error', msg: err }); return; }
        engine.broadcast(room);
      }
    });

    ws.on('close', () => {
      if (room && player) engine.disconnect(room, player, ws);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    close: () => new Promise((resolve) => {
      wss.close();
      server.close(resolve);
    }),
  };
}

async function runLiveTest() {
  console.log('\n--- Real-time WebSocket Protocol Test ---');
  let ephemeral = null;
  let targetUrl = 'ws://localhost:3000/ws';

  try {
    const testWs = new WebSocket(targetUrl);
    await new Promise((resolve, reject) => {
      testWs.once('open', () => { testWs.close(); resolve(); });
      testWs.once('error', reject);
    });
  } catch (e) {
    ephemeral = await startEphemeralServer();
    targetUrl = ephemeral.url;
  }

  // 1. Host creates room
  const ws1 = new WebSocket(targetUrl);
  await new Promise((res) => ws1.once('open', res));
  ws1.send(JSON.stringify({ t: 'create', name: 'Nikhil', settings: { maxPlayers: 3, boot: 100, timer: 15 } }));
  const join1 = await waitMsg(ws1, (m) => m.t === 'joined');
  assert(join1.code, 'Should receive room code');
  const code = join1.code;
  const token1 = join1.token;
  console.log(`  ok  room created with short code (${code})`);

  // 2. Player 2 joins
  const ws2 = new WebSocket(targetUrl);
  await new Promise((res) => ws2.once('open', res));
  ws2.send(JSON.stringify({ t: 'join', code, name: 'Rahul' }));
  const join2 = await waitMsg(ws2, (m) => m.t === 'joined');
  const token2 = join2.token;
  console.log(`  ok  second player joined`);

  // 3. Player 3 joins
  const ws3 = new WebSocket(targetUrl);
  await new Promise((res) => ws3.once('open', res));
  ws3.send(JSON.stringify({ t: 'join', code, name: 'Meet' }));
  await waitMsg(ws3, (m) => m.t === 'joined');
  console.log(`  ok  third player joined`);

  // 4. Verify state broadcast contains 3 players with ready states
  const st1 = await waitMsg(ws1, (m) => m.t === 'state' && m.s.players.length === 3);
  assert.strictEqual(st1.s.players.length, 3);
  assert.strictEqual(st1.s.players.find((p) => p.name === 'Nikhil').ready, true);
  assert.strictEqual(st1.s.players.find((p) => p.name === 'Rahul').ready, false);

  // 5. Rahul toggles ready
  ws2.send(JSON.stringify({ t: 'act', a: { type: 'ready' } }));
  const stReady = await waitMsg(ws1, (m) => m.t === 'state' && m.s.players.find((p) => p.name === 'Rahul').ready === true);
  assert(stReady.s.players.find((p) => p.name === 'Rahul').ready);
  console.log(`  ok  player ready state broadcast`);

  // 6. Host starts game
  ws1.send(JSON.stringify({ t: 'act', a: { type: 'start' } }));
  const stDealing = await waitMsg(ws1, (m) => m.t === 'state' && m.s.phase === 'dealing');
  assert.strictEqual(stDealing.s.game.pot, 300);
  console.log(`  ok  game started into dealing phase`);

  // 7. Host marks physical cards dealt
  ws1.send(JSON.stringify({ t: 'act', a: { type: 'cardsDealt' } }));
  const stBetting = await waitMsg(ws1, (m) => m.t === 'state' && m.s.phase === 'betting');
  assert.strictEqual(stBetting.s.phase, 'betting');
  const turn1Id = stBetting.s.game.turnId;
  assert(turn1Id);
  console.log(`  ok  physical cards dealt, betting begins`);

  const clientMap = {
    [stBetting.s.players[0].id]: ws1,
    [stBetting.s.players[1].id]: ws2,
    [stBetting.s.players[2].id]: ws3,
  };
  const curWs1 = clientMap[turn1Id];

  // 8. First player calls blind for 100
  curWs1.send(JSON.stringify({ t: 'act', a: { type: 'call' } }));
  const stAfterCall = await waitMsg(ws1, (m) => m.t === 'state' && m.s.game.pot === 400);
  assert.strictEqual(stAfterCall.s.game.pot, 400);
  console.log(`  ok  blind call processed`);

  // 9. Second player sees cards and calls seen
  const turn2Id = stAfterCall.s.game.turnId;
  const curWs2 = clientMap[turn2Id];
  curWs2.send(JSON.stringify({ t: 'act', a: { type: 'seen' } }));
  await waitMsg(curWs2, (m) => m.t === 'state' && m.s.players.find((p) => p.id === turn2Id).seen === true);
  curWs2.send(JSON.stringify({ t: 'act', a: { type: 'call' } }));
  const stAfterSeenCall = await waitMsg(ws1, (m) => m.t === 'state' && m.s.game.pot === 600);
  assert.strictEqual(stAfterSeenCall.s.game.pot, 600);
  console.log(`  ok  seen player pays double stake`);

  // 10. Third player folds
  const turn3Id = stAfterSeenCall.s.game.turnId;
  const curWs3 = clientMap[turn3Id];
  curWs3.send(JSON.stringify({ t: 'act', a: { type: 'fold' } }));
  const stAfterFold = await waitMsg(ws1, (m) => m.t === 'state' && m.s.players.find((p) => p.id === turn3Id).folded === true);
  console.log(`  ok  fold processed`);

  // 11. 2 players remain: fourth turn requests SHOW
  const turn4Id = stAfterFold.s.game.turnId;
  const curWs4 = clientMap[turn4Id];
  curWs4.send(JSON.stringify({ t: 'act', a: { type: 'show' } }));
  const stShowdown = await waitMsg(ws1, (m) => m.t === 'state' && m.s.phase === 'showdown');
  assert.strictEqual(stShowdown.s.phase, 'showdown');
  assert.strictEqual(stShowdown.s.game.showdown.contenders.length, 2);
  console.log(`  ok  showdown reached`);

  // 12. Host confirms winner
  const winnerId = stShowdown.s.game.showdown.contenders[0];
  ws1.send(JSON.stringify({ t: 'act', a: { type: 'winner', winnerId } }));
  const stSettled = await waitMsg(ws1, (m) => m.t === 'state' && m.s.phase === 'settled');
  assert.strictEqual(stSettled.s.phase, 'settled');
  assert.strictEqual(stSettled.s.game.result.winnerIds[0], winnerId);
  console.log(`  ok  winner confirmed and settled`);

  // 13. Host triggers next round
  ws1.send(JSON.stringify({ t: 'act', a: { type: 'next' } }));
  const stRound2 = await waitMsg(ws1, (m) => m.t === 'state' && m.s.game && m.s.game.round === 2);
  assert.strictEqual(stRound2.s.game.round, 2);
  console.log(`  ok  next round triggered`);

  // 14. Disconnect & reconnect test for Rahul
  ws2.close();
  await new Promise((r) => setTimeout(r, 150));
  const ws2Reconnect = new WebSocket(targetUrl);
  await new Promise((res) => ws2Reconnect.once('open', res));
  ws2Reconnect.send(JSON.stringify({ t: 'resume', code, token: token2 }));
  const resumedMsg = await waitMsg(ws2Reconnect, (m) => m.t === 'joined');
  assert(resumedMsg.resumed, 'Should be resumed');
  console.log(`  ok  reconnect with token restored seat`);

  ws1.close();
  ws2Reconnect.close();
  ws3.close();

  if (ephemeral) await ephemeral.close();
  console.log('All WebSocket protocol tests passed!\n');
}

runLiveTest().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
