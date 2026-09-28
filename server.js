'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const engine = require('./game/room');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const CORS_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, ...engine.stats(), uptime: Math.round(process.uptime()) }));
    return;
  }
  let file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403, CORS_HEADERS); res.end('Forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(PUBLIC, 'index.html');   // single-page app fallback
    fs.readFile(file, (e2, data) => {
      if (e2) { res.writeHead(404, CORS_HEADERS); res.end('Not found'); return; }
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
        ...CORS_HEADERS,
      });
      res.end(data);
    });
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const transport = { ws, send };
  let room = null;
  let player = null;
  let bucket = { t: Date.now(), n: 0 };

  const enter = (r, p, resumed) => {
    room = r; player = p;
    send({ t: 'joined', code: r.code, token: p.token, id: p.id, resumed: !!resumed });
    engine.broadcast(r);
  };

  ws.on('message', (raw) => {
    // crude flood protection: 40 messages / 5 s
    const t = Date.now();
    if (t - bucket.t > 5000) bucket = { t, n: 0 };
    if (++bucket.n > 40) return;

    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    try {
      if (m.t === 'ping') { send({ t: 'pong' }); return; }

      if (m.t === 'create') {
        if (room) return;
        const { room: r, player: p } = engine.createRoom(m.name, m.settings, transport);
        enter(r, p, false);
        return;
      }
      if (m.t === 'join' || m.t === 'resume') {
        if (room) return;
        const res = engine.joinRoom(m.code, m.name, m.token, transport);
        if (res.error) { send({ t: 'error', msg: res.error, fatal: m.t === 'resume' }); return; }
        enter(res.room, res.player, res.resumed);
        return;
      }
      if (!room || !player) return;

      if (m.t === 'act') {
        const a = m.a || {};
        if (a.type === 'leave') {
          engine.leave(room, player);
          const r = room;
          room = null; player = null;
          send({ t: 'left' });
          engine.broadcast(r);
          return;
        }
        const err = engine.handle(room, player, a);
        if (err === 'silent') return;
        if (err) { send({ t: 'error', msg: err }); return; }
        engine.broadcast(room);
      }
    } catch (e) {
      console.error('message error', e);
      send({ t: 'error', msg: 'Something went wrong on the server.' });
    }
  });

  ws.on('close', () => {
    if (room && player) engine.disconnect(room, player, ws);
  });
  ws.on('error', () => {});
});

// keep connections alive through Railway's proxy and detect dead phones
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, 25000).unref();

engine.startTicker();
server.listen(PORT, '0.0.0.0', () => console.log(`Teen Patti table listening on :${PORT}`));

process.on('SIGTERM', () => { wss.close(); server.close(() => process.exit(0)); });
