(() => {
'use strict';

const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = [['S', '♠'], ['H', '♥'], ['D', '♦'], ['C', '♣']];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-IN');
const app = $('#app');
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

let ws = null, S = null, offset = 0, retry = 0, outbox = null;
let tab = 'create', overlay = null, cardDraft = [{}, {}, {}], soundOn = store.get('tp_sound', true);
let lastLogN = 0, lastTurn = null, chatSeenTs = 0, lastTickSec = -1, qrOn = false, actionSeq = 0;
let actionLocked = false;
let viewMode = store.get('tp_view', 'table'); // 'table' or 'list'
let pendingWinner = null;

const params = new URLSearchParams(location.search);
if (params.get('room')) tab = 'join';

/* ---------- connection ---------- */
function wsUrl() {
  const queryWs = params.get('ws');
  if (queryWs) { store.set('tp_ws', queryWs); return queryWs; }
  const storedWs = store.get('tp_ws', null);
  if (storedWs) return storedWs;
  if (window.TP_WS_URL) return window.TP_WS_URL;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

function connect() {
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    setTimeout(connect, 2000);
    return;
  }
  ws.onopen = () => {
    retry = 0; document.body.classList.remove('offline');
    if (outbox) { ws.send(JSON.stringify(outbox)); outbox = null; return; }
    const ses = store.get('tp_session', null);
    if (ses) ws.send(JSON.stringify({ t: 'resume', code: ses.code, token: ses.token }));
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    onMsg(m);
  };
  ws.onclose = () => {
    if (S) document.body.classList.add('offline');
    setTimeout(connect, Math.min(800 * 2 ** retry++, 8000));
  };
  ws.onerror = () => {};
}

function send(m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  else toast('Connecting to server… Retrying…');
}

function sendFirst(m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  else outbox = m;
}

const act = (a) => {
  if (actionLocked) return;
  actionLocked = true;
  setTimeout(() => { actionLocked = false; }, 350);
  a.aid = ++actionSeq + '-' + Date.now();
  send({ t: 'act', a });
};

setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 20000);

function onMsg(m) {
  actionLocked = false;
  switch (m.t) {
    case 'joined': store.set('tp_session', { code: m.code, token: m.token }); break;
    case 'state': onState(m.s); break;
    case 'error':
      toast(m.msg);
      if (m.fatal) { store.del('tp_session'); S = null; render(); }
      break;
    case 'left': case 'kicked':
      store.del('tp_session'); S = null; overlay = null; closeOverlay(); render();
      if (m.t === 'kicked') toast('The host removed you from the room.');
      break;
    case 'react': floatEmoji(m.id, m.emoji); break;
    default: break;
  }
}

function onState(s) {
  const prev = S;
  S = s; offset = s.now - Date.now();
  if (s.phase !== 'showdown') pendingWinner = null;

  // sounds from new log lines
  const fresh = s.log.filter((l) => l.n > lastLogN);
  if (prev && fresh.length) {
    const t = fresh.map((l) => l.text).join(' ');
    if (/won/.test(t)) win(); else if (/folded/.test(t)) tone(190, .18, 'triangle'); else tone(520, .07, 'square');
  }
  if (s.log.length) lastLogN = s.log[s.log.length - 1].n;
  const turn = s.game && s.phase === 'betting' ? s.game.turnId : null;
  if (turn && turn === s.you && turn !== lastTurn) { tone(880, .12); setTimeout(() => tone(1175, .14), 140); if (navigator.vibrate) navigator.vibrate(80); }
  lastTurn = turn;
  render();
  if (overlay === 'chat') fillChat();
  else if (overlay === 'menu') openMenu();
  else if (overlay === 'raise' && !(s.actions && s.actions.raise)) closeOverlay();
  else if (overlay === 'handGuide') updateHandGuideDisplay();
}

/* ---------- sound ---------- */
let actx = null;
function tone(f, d = .1, type = 'sine') {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = f; g.gain.value = .06;
    o.connect(g); g.connect(actx.destination);
    g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + d);
    o.start(); o.stop(actx.currentTime + d);
  } catch (e) { /* audio blocked */ }
}
function win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, .18, 'triangle'), i * 120)); }

/* ---------- ui helpers ---------- */
let toastT;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastT); toastT = setTimeout(() => { el.className = ''; }, 2600);
}
function closeOverlay() { overlay = null; $('#overlay').innerHTML = ''; }
function openOverlay(html, kind) {
  overlay = kind;
  $('#overlay').innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
}
const nameOf = (id) => { const p = S && S.players.find((x) => x.id === id); return p ? p.name : '—'; };
const link = () => `${location.origin}${location.pathname}?room=${S.code}`;
const isHost = () => S && S.hostId === S.you;
const meP = () => S && S.players ? S.players.find((p) => p.id === S.you) : null;
const liveCount = () => S ? S.players.filter((p) => !p.left).length : 0;

function wildText() {
  const g = S.game;
  if (!g) return S.rules.label;
  const bits = [S.rules.label];
  if (g.lowestWild) bits.push('lowest wild');
  else if (g.wildRanks && g.wildRanks.length) bits.push('wild ' + g.wildRanks.join(' '));
  if (g.lowest) bits.push('lowest wins');
  return bits.join(', ');
}

/* ---------- hand evaluation helper (client side) ---------- */
function evalClientHand(cards) {
  if (!cards || cards.length !== 3 || cards.some((c) => !c.r || !c.s)) return null;
  const v = cards.map((c) => RANK_VALUES[c.r]).sort((a, b) => b - a);
  const flush = cards[0].s === cards[1].s && cards[1].s === cards[2].s;
  let seqVal = 0;
  if (v[0] - v[1] === 1 && v[1] - v[2] === 1) seqVal = v[0];
  else if (v[0] === 14 && v[1] === 3 && v[2] === 2) seqVal = 13.5;

  const rn = (n) => Object.keys(RANK_VALUES).find((k) => RANK_VALUES[k] === n) || n;
  if (v[0] === v[1] && v[1] === v[2]) return { rank: 1, name: `Trail of ${rn(v[0])}s`, desc: 'Highest Teen Patti hand category' };
  if (seqVal && flush) return { rank: 2, name: `Pure Sequence ${seqVal === 13.5 ? 'A-2-3' : `${rn(seqVal)}-${rn(seqVal-1)}-${rn(seqVal-2)}`}`, desc: 'Straight Flush in physical cards' };
  if (seqVal) return { rank: 3, name: `Sequence ${seqVal === 13.5 ? 'A-2-3' : `${rn(seqVal)}-${rn(seqVal-1)}-${rn(seqVal-2)}`}`, desc: 'Three consecutive ranks' };
  if (flush) return { rank: 4, name: `Color (${rn(v[0])} high)`, desc: 'Three cards of the same suit' };
  if (v[0] === v[1]) return { rank: 5, name: `Pair of ${rn(v[0])}s`, desc: `Kicker: ${rn(v[2])}` };
  if (v[1] === v[2]) return { rank: 5, name: `Pair of ${rn(v[1])}s`, desc: `Kicker: ${rn(v[0])}` };
  return { rank: 6, name: `High Card ${rn(v[0])}`, desc: `Kickers: ${rn(v[1])}, ${rn(v[2])}` };
}

/* ---------- render ---------- */
function render() {
  if (!S) return renderHome();
  if (S.phase === 'lobby') return renderLobby();
  return renderGame();
}

function renderHome() {
  const name = store.get('tp_name', '');
  app.innerHTML = `
  <div class="home">
    <div class="brand-badge">Physical Card Companion</div>
    <h1>Teen Patti<br>Companion</h1>
    <p class="sub">Shuffle and deal your <b>physical cards</b>. The app handles rooms, turns, bets, pot, timers, fake coins, and winner settlement.</p>
    <div class="card"><div class="field" style="margin:0"><label for="name">Your player name</label>
      <input id="name" maxlength="16" autocomplete="nickname" value="${esc(name)}" placeholder="e.g. Nikhil"></div></div>
    <div class="tabs">
      <button class="btn ${tab === 'create' ? 'on' : ''}" data-a="tab" data-v="create">Create room</button>
      <button class="btn ${tab === 'join' ? 'on' : ''}" data-a="tab" data-v="join">Join room</button>
    </div>
    ${tab === 'create' ? `
    <div class="card">
      <div class="row">
        <div class="field"><label for="c-players">Players (2–10)</label>
          <select id="c-players">${[2,3,4,5,6,7,8,9,10].map((n) => `<option ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label for="c-timer">Turn timer (sec)</label><input id="c-timer" type="number" inputmode="numeric" value="15" min="5" max="120"></div>
      </div>
      <div class="row">
        <div class="field"><label for="c-coins">Starting fake coins</label><input id="c-coins" type="number" inputmode="numeric" value="10000"></div>
        <div class="field"><label for="c-boot">Boot amount</label><input id="c-boot" type="number" inputmode="numeric" value="100"></div>
      </div>
      <p class="muted" style="margin:0 0 12px;font-size:.85rem">Variants (Classic, Muflis, AK47, Joker, 999, Lowest Joker), side-show, and hand verification can be adjusted in the lobby.</p>
      <button class="btn primary" style="width:100%" data-a="create">Create room</button>
    </div>` : `
    <div class="card">
      <div class="field"><label for="j-code">6-digit room code</label>
        <input id="j-code" class="codeinput" maxlength="6" autocapitalize="characters" autocomplete="off" value="${esc((params.get('room') || '').toUpperCase())}" placeholder="TP7K29"></div>
      <button class="btn primary" style="width:100%" data-a="join">Join room</button>
    </div>`}
    <div class="disclaimer-card">
      <b>⚠️ Physical Cards Only · Virtual Coins Only</b><br>
      No real money, no deposits, no withdrawals. All coins are 100% fake for home entertainment.
    </div>
  </div>`;
}

const SETTING_FIELDS = [
  ['maxPlayers', 'Max players', 'number', { min: 2, max: 10 }],
  ['startCoins', 'Starting fake coins', 'number', {}],
  ['boot', 'Boot', 'number', {}],
  ['timer', 'Turn timer (sec)', 'number', { min: 5, max: 120 }],
  ['maxStakeMult', 'Max stake (× boot)', 'number', { min: 2 }],
  ['timeoutAction', 'When time runs out', 'select', { opts: [['fold', 'Auto-fold'], ['call', 'Auto-call']] }],
  ['direction', 'Turn direction', 'select', { opts: [['cw', 'Clockwise'], ['ccw', 'Anti-clockwise']] }],
  ['firstPlayer', 'First player', 'select', { opts: [['rotate', 'Rotate every round'], ['host', 'Fixed: host'], ['random', 'Random']] }],
];

function settingsForm() {
  const s = S.settings, edit = isHost();
  if (!edit) {
    const label = (k, v) => { const f = SETTING_FIELDS.find((x) => x[0] === k); const o = f && f[3].opts && f[3].opts.find((x) => x[0] === v); return o ? o[1] : fmt(v); };
    return `<div>
      ${SETTING_FIELDS.map((f) => `<div class="ro"><span class="muted">${f[1]}</span><span>${esc(label(f[0], s[f[0]]))}</span></div>`).join('')}
      <div class="ro"><span class="muted">Variant</span><span>${esc(S.rules.label)}</span></div>
      <div class="ro"><span class="muted">Side show</span><span>${s.sideShow ? 'On' : 'Off'}</span></div>
      <div class="ro"><span class="muted">Verify mode</span><span>${s.verify ? 'On' : 'Off'}</span></div>
      <p class="muted" style="font-size:.85rem;margin:10px 0 0">${esc(S.rules.desc)}</p></div>`;
  }
  const field = ([k, l, type, o]) => type === 'number'
    ? `<div class="field"><label for="s-${k}">${l}</label><input id="s-${k}" data-s="${k}" type="number" inputmode="numeric" value="${s[k]}" ${o.min ? `min="${o.min}"` : ''} ${o.max ? `max="${o.max}"` : ''} ${k === 'startCoins' && S.started ? 'disabled' : ''}></div>`
    : `<div class="field"><label for="s-${k}">${l}</label><select id="s-${k}" data-s="${k}">${o.opts.map(([v, t]) => `<option value="${v}" ${s[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
  return `<div id="settings">
    ${SETTING_FIELDS.map(field).join('')}
    <div class="field"><label for="s-variant">Variant</label>
      <select id="s-variant" data-s="variant">${Object.entries(S.variants).map(([k, v]) => `<option value="${k}" ${s.variant === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      <span class="muted" style="font-size:.82rem">${esc(S.rules.desc)}</span></div>
    ${s.variant === 'custom' ? `
      <div class="field"><span class="lbl">Wild ranks</span><div class="chips">${RANKS.map((r) => `<label class="chip"><input type="checkbox" data-wild="${r}" ${s.customWild.includes(r) ? 'checked' : ''}><span>${r}</span></label>`).join('')}</div></div>
      <label class="switch"><span>Lowest hand wins</span><input type="checkbox" data-s="customLowest" ${s.customLowest ? 'checked' : ''}></label>` : ''}
    <label class="switch"><span>Side show<br><span class="muted" style="font-size:.8rem">Seen players can request comparison with previous player</span></span><input type="checkbox" data-s="sideShow" ${s.sideShow ? 'checked' : ''}></label>
    <label class="switch"><span>Verify mode<br><span class="muted" style="font-size:.8rem">Optional: enter cards at show for automatic hand evaluation</span></span><input type="checkbox" data-s="verify" ${s.verify ? 'checked' : ''}></label>
  </div>`;
}

function renderLobby() {
  const host = isHost();
  const me = meP();
  const live = S.players.filter((p) => !p.left);
  const readyCount = live.filter((p) => p.ready || p.id === S.hostId).length;

  app.innerHTML = `
  <div class="lobby">
    <div class="roomcode">
      <div class="muted">Room Code</div>
      <div class="code">${S.code}</div>
      <div class="lobby-host-line">Host: <b>${esc(nameOf(S.hostId))}</b> 👑</div>
    </div>
    <div class="share">
      <button class="btn" data-a="copyLink">Copy link</button>
      <button class="btn" data-a="copyCode">Copy code</button>
      <button class="btn" data-a="qr">QR code</button>
      ${navigator.share ? '<button class="btn" data-a="share">Share</button>' : ''}
    </div>
    ${qrOn ? `<img class="qr" width="180" height="180" alt="QR code to join room ${S.code}" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(link())}">` : ''}
    
    <div class="card">
      <div class="row" style="align-items:baseline;margin-bottom:8px">
        <h2 style="flex:1">Players (${live.length} / ${S.settings.maxPlayers})</h2>
        <span class="muted" style="flex:none;font-size:.85rem">${readyCount} of ${live.length} ready</span>
      </div>
      <ul class="plist">
        ${live.map((p) => `
        <li>
          <span class="dot" style="background:${p.color}"></span>
          <span class="who">${esc(p.name)}${p.isHost ? ' 👑' : ''}${p.id === S.you ? ' <b>(you)</b>' : ''}</span>
          ${p.id === S.hostId ? '<span class="tag tag-host">Host 👑</span>' : (p.ready ? '<span class="tag tag-ready">Ready 🟢</span>' : '<span class="tag tag-wait">Waiting ⏳</span>')}
          ${p.connected ? '' : '<span title="Disconnected" style="font-size:.85rem">📴</span>'}
          <span class="num muted">🪙 ${fmt(p.coins)}</span>
          ${host && p.id !== S.you ? `<button class="btn small ghost" data-a="kick" data-v="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}
        </li>`).join('')}
      </ul>
      ${!host && me ? `
        <div style="margin-top:12px">
          <button class="btn ${me.ready ? 'ghost' : 'primary'}" style="width:100%" data-a="ready">
            ${me.ready ? 'Cancel Ready (Waiting)' : "I'm Ready 🟢"}
          </button>
        </div>` : ''}
    </div>

    <div class="card">
      <h2 style="margin-bottom:10px">Room Settings</h2>
      <div class="quick-settings-summary">
        <span>Boot: <b>🪙 ${fmt(S.settings.boot)}</b></span> · 
        <span>Timer: <b>${S.settings.timer}s</b></span> · 
        <span>Max Bet: <b>🪙 ${fmt(S.settings.boot * S.settings.maxStakeMult)}</b></span>
      </div>
      ${settingsForm()}
    </div>
    
    <div style="padding:0 16px">
      ${host ? `
        <button class="btn primary bigbtn" style="width:100%" data-a="start" ${live.length < 2 ? 'disabled' : ''}>
          ${S.started ? 'START NEXT ROUND' : 'START GAME'}
        </button>
        ${live.length < 2 ? '<p class="muted" style="text-align:center;font-size:.85rem;margin-top:6px">Need at least 2 players to start.</p>' : ''}
        ${S.started ? '<button class="btn ghost" style="width:100%;margin-top:10px" data-a="resetCoins">Reset all coins and statistics</button>' : ''}`
        : '<p class="muted" style="text-align:center;padding:8px 0">Waiting for host to start the game…</p>'}
      <button class="btn danger" style="width:100%;margin-top:10px" data-a="leave">Leave room</button>
    </div>
  </div>`;
}

function statusOf(p) {
  if (p.left) return '🚪';
  if (p.winner) return '🏆';
  if (!p.connected) return '📴';
  if (p.folded) return '❌';
  if (!p.inRound) return '🪑';
  if (S.phase === 'dealing') return '🟢';
  return p.seen ? '👁' : '🙈';
}

function renderGame() {
  const g = S.game, host = isHost(), me = meP();
  const list = S.players;
  const mi = Math.max(0, list.findIndex((p) => p.id === S.you));
  const ordered = [...list.slice(mi), ...list.slice(0, mi)];
  const n = ordered.length;

  // Responsive seat placement for 2 to 10 players
  const isLargeTable = n > 6;
  const rx = isLargeTable ? 39 : 42;
  const ry = isLargeTable ? 42 : 45;

  const seats = ordered.map((p, i) => {
    const th = (Math.PI / 2) + (i * 2 * Math.PI) / n;
    const x = 50 + rx * Math.cos(th), y = 50 + ry * Math.sin(th);
    const out = p.left || p.folded || !p.inRound;
    const isCurrent = g && g.turnId === p.id && S.phase === 'betting';
    const cls = [
      'seat',
      isLargeTable ? 'compact' : '',
      p.id === S.you ? 'me' : '',
      isCurrent ? 'turn' : '',
      out ? 'out' : '',
      p.winner ? 'win' : ''
    ].filter(Boolean).join(' ');

    return `<div class="${cls}" data-id="${p.id}" style="left:${x}%;top:${y}%">
      <div class="pill">
        <span class="col" style="background:${p.color}"></span>
        <span class="st" aria-hidden="true">${statusOf(p)}</span>
        <div class="nm">${esc(p.name)}${p.isHost ? ' 👑' : ''}</div>
        <div class="cn num">🪙 ${fmt(p.coins)}</div>
        <div class="contrib num">Bet: ${fmt(p.contributed || 0)}</div>
      </div>
    </div>`;
  }).join('');

  const listView = `
  <div class="listwrap card">
    <div class="pot-banner">
      <div class="amt num"><span class="coin"></span>${fmt(g.pot)} COINS</div>
      <div class="cap">POT</div>
      ${S.phase === 'betting' || S.phase === 'sideshow' ? `<div class="stake">Current Stake: 🪙 ${fmt(g.stake)}</div>` : ''}
    </div>
    <div class="roster-head">Players in Game</div>
    <div class="roster">
      ${ordered.map((p) => {
        const isCurrent = g && g.turnId === p.id && S.phase === 'betting';
        const out = p.left || p.folded || !p.inRound;
        const stText = p.left ? 'Left 🚪' : (p.folded ? 'Folded ❌' : (p.seen ? 'Seen 👁' : 'Blind 🙈'));
        return `
        <div class="roster-row ${isCurrent ? 'turn-active' : ''} ${out ? 'out' : ''}">
          <div class="roster-left">
            <span class="dot" style="background:${p.color}"></span>
            <span class="roster-name">${esc(p.name)}${p.isHost ? ' 👑' : ''}${p.id === S.you ? ' <b>(you)</b>' : ''}</span>
            <span class="roster-badge">${stText} ${p.connected ? '🟢' : '📴'}</span>
          </div>
          <div class="roster-right">
            <div class="roster-coins num">🪙 ${fmt(p.coins)}</div>
            <div class="roster-bet muted">Bet: ${fmt(p.contributed || 0)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;

  const unread = S.chat.filter((m) => m.ts > chatSeenTs && m.id !== S.you).length;
  app.innerHTML = `
  <div class="top">
    <div class="grow">
      <div class="rc">${S.code}</div>
      <div class="meta">ROUND ${g.round} · ${esc(wildText())} · ${S.settings.direction === 'cw' ? '↻' : '↺'}</div>
    </div>
    <div class="mybalance" title="Your fake coin balance">
      <span class="coin"></span>${fmt(me ? me.coins : 0)}
    </div>
    <button class="iconbtn" data-a="toggleView" title="Toggle table / list view" aria-label="Toggle View">${viewMode === 'table' ? '📋' : '🎴'}</button>
    <button class="iconbtn" data-a="handGuide" title="Hand rank guide & verifier" aria-label="Hand Guide">🃏</button>
    <button class="iconbtn" data-a="chat" title="Table chat" aria-label="Chat">💬${unread ? `<span class="badge">${unread}</span>` : ''}</button>
    <button class="iconbtn" data-a="menu" title="Menu & stats" aria-label="Menu">☰</button>
  </div>
  
  ${viewMode === 'table' ? `
  <div class="tablewrap"><div class="table">
    ${seats}
    <div class="pot">
      <div class="amt num"><span class="coin"></span>${fmt(g.pot)}</div>
      <div class="cap">POT</div>
      ${S.phase === 'betting' || S.phase === 'sideshow' ? `<div class="stake">Stake: 🪙 ${fmt(g.stake)}</div>` : ''}
    </div>
  </div></div>` : listView}

  <div class="msgline" id="msgline">${message()}</div>
  ${g.deadline || (S.paused && g.remaining) ? '<div class="timer" id="timerbar"><i></i></div>' : ''}
  <div class="log" aria-live="polite">${S.log.slice(-3).map((l) => `<div>${esc(l.text)}</div>`).join('')}</div>
  <div class="controls">${controls()}</div>`;
  updateTimer();
}

function message() {
  const g = S.game, host = isHost(), me = meP();
  if (S.paused) return '<b>Game paused.</b> The host will resume shortly.';
  switch (S.phase) {
    case 'dealing':
      return host ? 'Shuffle your real deck and deal <b>3 physical cards</b> to each player. Tap <b>CARDS DEALT</b> when done.'
        : `Host is dealing physical cards to ${g.order.length} players around the table…`;
    case 'betting': {
      if (g.turnId === S.you) return `<b class="turn-highlight">YOUR TURN</b> · <span id="tleft"></span>`;
      return `TURN: <b>${esc(nameOf(g.turnId))}</b> · <span id="tleft"></span>`;
    }
    case 'sideshow': {
      const ss = g.sideshow;
      if (ss.stage === 'ask') return `<b>${esc(nameOf(ss.fromId))}</b> requested a side-show with <b>${esc(nameOf(ss.toId))}</b> · <span id="tleft"></span>`;
      return `Side-show accepted. <b>${esc(nameOf(ss.fromId))}</b> and <b>${esc(nameOf(ss.toId))}</b> compare cards secretly. Host picks who lost.`;
    }
    case 'showdown': {
      const [a, b] = g.showdown.contenders;
      return `<b>SHOWDOWN!</b> Compare your physical cards: <b>${esc(nameOf(a))}</b> vs <b>${esc(nameOf(b))}</b>.`;
    }
    case 'settled': return '';
    default: return me && !me.inRound ? 'You are sitting out this round.' : '';
  }
}

function controls() {
  const g = S.game, host = isHost(), a = S.actions || {}, me = meP();
  if (S.paused) return host ? '<button class="btn primary bigbtn" style="width:100%" data-a="resume">Resume game</button>' : '';
  switch (S.phase) {
    case 'dealing':
      return host ? '<button class="btn primary bigbtn" style="width:100%" data-a="cardsDealt">CARDS DEALT (START BETTING)</button>' : '<p class="muted" style="text-align:center">Waiting for physical cards to be dealt…</p>';
    case 'betting': {
      const parts = ['<div class="grid">'];
      if (a.call) {
        parts.push(`<button class="btn primary bigbtn full" data-a="call" ${a.call.ok ? '' : 'disabled'}>${a.call.blind ? 'Play Blind' : 'Call'} · 🪙 ${fmt(a.call.amount)}${a.call.ok ? '' : '<span class="sub">not enough coins</span>'}</button>`);
        parts.push(`<button class="btn bigbtn" data-a="raiseOpen" ${a.raise ? '' : 'disabled'}>Raise Stake</button>`);
        parts.push('<button class="btn danger bigbtn" data-a="fold">Fold</button>');
        if (a.sideshow) parts.push(`<button class="btn" data-a="sideshow">Side Show<span class="sub">with ${esc(nameOf(a.sideshow.targetId))}</span></button>`);
        if (a.show) parts.push(`<button class="btn" data-a="show">Show<span class="sub">pay 🪙 ${fmt(a.show.amount)}</span></button>`);
      }
      if (a.canSeen) parts.push('<button class="btn ghost full" data-a="seen">👁 I Have Seen My Cards (Mark Seen)</button>');
      parts.push('</div>');
      return parts.join('');
    }
    case 'sideshow': {
      const ss = g.sideshow, out = [];
      if (ss.stage === 'ask' && ss.toId === S.you) {
        out.push(`<div class="sideshow-prompt"><div class="sideshow-title">SIDE SHOW REQUEST</div>
          <p style="margin:4px 0 10px;text-align:center"><b>${esc(nameOf(ss.fromId))}</b> wants to compare cards with you.</p>
          <div class="grid"><button class="btn primary bigbtn" data-a="ssYes">ACCEPT</button><button class="btn danger bigbtn" data-a="ssNo">REJECT</button></div></div>`);
      } else if (ss.stage === 'resolve' && host) {
        out.push(`<p style="margin:0 0 10px;text-align:center;font-weight:600">Compare physical cards: who had the lower hand?</p><div class="grid">
          ${[ss.fromId, ss.toId].map((id) => `<button class="btn bigbtn danger" data-a="ssLoser" data-v="${id}">${esc(nameOf(id))} Lost</button>`).join('')}</div>`);
      } else {
        out.push(`<p class="muted" style="text-align:center">Side-show in progress between ${esc(nameOf(ss.fromId))} and ${esc(nameOf(ss.toId))}…</p>`);
      }
      if (a.canSeen) out.push('<button class="btn ghost" style="width:100%;margin-top:10px" data-a="seen">👁 I Have Seen My Cards</button>');
      return out.join('');
    }
    case 'showdown': {
      const sd = g.showdown, mine = sd.contenders.includes(S.you), out = [];
      out.push('<div class="showdown-box">');
      out.push('<div class="showdown-title">🃏 Physical Showdown: Compare Cards</div>');
      
      // Optional card verification if enabled
      if (S.settings.verify && mine) {
        if (sd.submitted.includes(S.you)) {
          out.push('<p class="muted" style="text-align:center;margin:6px 0 12px">Your physical cards entered. Waiting for opponent…</p>');
        } else {
          out.push(cardForm());
        }
      }

      if (host) {
        if (pendingWinner) {
          // Two-step confirmation preventing accidental settlement
          out.push(`
          <div class="confirm-box">
            <div class="confirm-head">Confirm Winner</div>
            <div class="confirm-name">🏆 ${esc(pendingWinner.name)}</div>
            <div class="confirm-prize">Prize: 🪙 ${fmt(g.pot)} Coins</div>
            <p class="muted" style="font-size:.85rem;margin:6px 0 12px">Confirm result? Settle 🪙 ${fmt(g.pot)} coins to ${esc(pendingWinner.name)}.</p>
            <div class="grid">
              <button class="btn primary bigbtn" data-a="confirmWinner">CONFIRM RESULT ✅</button>
              <button class="btn bigbtn" data-a="cancelWinner">Change / Cancel</button>
            </div>
          </div>`);
        } else {
          out.push(`<p style="margin:10px 0 8px;text-align:center;font-weight:600">Select Winner:</p><div class="grid">
            ${sd.contenders.map((id) => `<button class="btn primary bigbtn" data-a="selectWinner" data-v="${id}">Winner: ${esc(nameOf(id))} 🏆</button>`).join('')}
            <button class="btn full" data-a="selectWinner" data-v="split">Split Pot Evenly</button></div>`);
        }
      } else {
        out.push('<p class="muted" style="text-align:center;margin-top:8px">Compare physical cards. Waiting for host to confirm the winner…</p>');
      }
      out.push('</div>');
      return out.join('');
    }
    case 'settled': {
      const r = g.result;
      const names = r.winnerIds.map(nameOf).map(esc).join(' & ') || 'Nobody';
      const hands = r.hands ? `<div class="handbox">${Object.entries(r.hands).map(([id, h]) => `<div><b>${esc(nameOf(id))}</b><br>${esc(h.cards.join(' '))}<br><span class="muted">${esc(h.name)}</span></div>`).join('')}</div>` : '';
      
      return `
      <div class="banner">
        <div class="muted">ROUND ${g.round} COMPLETE</div>
        <div class="w">🏆 ${names}</div>
        <div class="num"><span class="coin"></span>${fmt(r.pot)} Coins Collected</div>
        <div class="muted" style="font-size:.85rem">${esc(r.reason)}</div>
        ${hands}

        <div class="settle-summary">
          <div class="settle-title">Updated Balances:</div>
          <div class="settle-grid">
            ${S.players.map((p) => `
              <div class="settle-item">
                <span class="settle-name">${esc(p.name)} ${p.winner ? '🏆' : ''}</span>
                <span class="settle-coins num">🪙 ${fmt(p.coins)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      ${host ? `
        <div class="grid">
          <button class="btn primary bigbtn" data-a="next">NEXT ROUND 🎴</button>
          <button class="btn bigbtn" data-a="end">Back to Lobby</button>
        </div>`
        : '<p class="muted" style="text-align:center;padding:8px 0">Waiting for host to start the next round…</p>'}`;
    }
    default: return '';
  }
}

function cardForm() {
  const sel = (i, k, opts) => `<select data-card="${i}" data-k="${k}" aria-label="Card ${i + 1} ${k === 'r' ? 'rank' : 'suit'}"><option value="">${k === 'r' ? 'Rank' : 'Suit'}</option>${opts.map(([v, t]) => `<option value="${v}" ${cardDraft[i][k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  return `<div class="lbl" style="margin-bottom:6px">Optional: Enter your 3 cards for verification:</div>
    ${[0, 1, 2].map((i) => `<div class="cardpick">${sel(i, 'r', RANKS.map((r) => [r, r]))}${sel(i, 's', SUITS)}</div>`).join('')}
    <button class="btn primary" style="width:100%;margin-bottom:12px" data-a="submitCards">Submit cards for verification</button>`;
}

/* ---------- timer ---------- */
function updateTimer() {
  if (!S || !S.game) return;
  const g = S.game, bar = $('#timerbar i'), tl = $('#tleft');
  let left = null;
  if (S.paused && g.remaining) left = g.remaining / 1000;
  else if (g.deadline) left = Math.max(0, (g.deadline - (Date.now() + offset)) / 1000);
  if (left === null) return;
  const total = S.settings.timer;
  if (bar) { bar.style.width = Math.min(100, (left / total) * 100) + '%'; bar.parentElement.classList.toggle('low', left <= 5); }
  if (tl) tl.textContent = Math.ceil(left) + 's';
  const sec = Math.ceil(left);
  if (!S.paused && S.phase === 'betting' && g.turnId === S.you && sec <= 3 && sec > 0 && sec !== lastTickSec) { lastTickSec = sec; tone(660, .06, 'square'); }
}
setInterval(updateTimer, 250);

/* ---------- overlays ---------- */
function openMenu() {
  const host = isHost();
  const rows = S.players.filter((p) => !p.left).map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmt(p.coins)}</td><td>${p.stats.games}</td><td>${p.stats.wins}</td><td>${p.stats.games ? Math.round((p.stats.wins / p.stats.games) * 100) : 0}%</td><td class="num">${fmt(p.stats.coinsWon)}</td><td class="num">${fmt(p.stats.coinsLost)}</td><td class="num">${fmt(p.stats.bestPot)}</td></tr>`).join('');
  openOverlay(`
    <div class="row" style="align-items:center;margin-bottom:10px"><h2 style="flex:1">Room ${S.code}</h2><button class="btn small" style="flex:none" data-a="close">Close</button></div>
    <div class="row" style="margin-bottom:14px">
      <button class="btn small" data-a="copyLink">Copy link</button>
      <button class="btn small" data-a="copyCode">Copy code</button>
      <button class="btn small" data-a="sound">Sound: ${soundOn ? 'on' : 'off'}</button>
    </div>
    <h2 style="font-size:1.05rem;margin-bottom:6px">Session Statistics</h2>
    <div style="overflow-x:auto;margin-bottom:14px"><table class="stat"><tr><th>Player</th><th>Coins</th><th>Games</th><th>Wins</th><th>Win %</th><th>Won</th><th>Lost</th><th>Best pot</th></tr>${rows}</table></div>
    ${host ? `
      <h2 style="font-size:1.05rem;margin-bottom:8px">Host Controls</h2>
      <div class="row" style="margin-bottom:10px">
        <button class="btn" data-a="${S.paused ? 'resume' : 'pause'}">${S.paused ? 'Resume game' : 'Pause game'}</button>
        <button class="btn" data-a="end">End round & go to lobby</button>
      </div>
      <div class="row" style="margin-bottom:10px">
        <button class="btn ghost" data-a="topUp">Top up broke players to 10k</button>
      </div>
      ${S.players.filter((p) => !p.left && p.id !== S.you).map((p) => `<div class="ro"><span>${esc(p.name)} ${p.connected ? '' : '📴'}</span><button class="btn small danger" data-a="kick" data-v="${p.id}">Remove</button></div>`).join('')}` : ''}
    <button class="btn danger" style="width:100%;margin-top:14px" data-a="leave">Leave game</button>`, 'menu');
}

function openChat() {
  openOverlay(`
    <div class="row" style="align-items:center;margin-bottom:10px"><h2 style="flex:1">Table Chat</h2><button class="btn small" style="flex:none" data-a="close">Close</button></div>
    <div class="react">${['😂', '🔥', '😎', '👀', 'GG'].map((e) => `<button class="btn" data-a="react" data-e="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>
    <div class="chatlog" id="chatlog"></div>
    <div class="row"><input id="chatin" maxlength="140" placeholder="Say something" aria-label="Chat message" style="height:48px;border-radius:12px;border:1.5px solid var(--line);background:var(--ink2);padding:0 12px"><button class="btn primary" style="flex:none" data-a="sendChat">Send</button></div>`, 'chat');
  overlay = 'chat';
  fillChat();
}

function fillChat() {
  const el = $('#chatlog'); if (!el || !S) return;
  el.innerHTML = S.chat.length ? S.chat.map((m) => `<div class="msg ${m.id === S.you ? 'mine' : ''}"><div class="by" style="color:${m.color}">${esc(m.name)}</div>${esc(m.text)}</div>`).join('')
    : '<p class="muted" style="text-align:center">No messages yet. Send a chat or reaction.</p>';
  el.scrollTop = el.scrollHeight;
  chatSeenTs = S.chat.length ? S.chat[S.chat.length - 1].ts : Date.now();
}

function floatEmoji(id, e) {
  const seat = document.querySelector(`.seat[data-id="${id}"] .pill`);
  if (!seat) { toast(`${nameOf(id)}: ${e}`, 'info'); return; }
  const s = document.createElement('span'); s.className = 'float'; s.textContent = e;
  seat.appendChild(s); setTimeout(() => s.remove(), 1700);
}

function openRaise() {
  const r = S.actions && S.actions.raise; if (!r) return;
  openOverlay(`
    <div class="row" style="align-items:center;margin-bottom:6px"><h2 style="flex:1">Raise the Stake</h2><button class="btn small" style="flex:none" data-a="close">Close</button></div>
    <p class="muted" style="margin:0 0 12px">Current stake is 🪙 ${fmt(S.game.stake)}. ${r.mult === 2 ? 'You are Seen, so you pay 2× the new stake.' : 'You are Blind, so you pay 1× the new stake.'}</p>
    <div class="rgrid">${r.options.map((v) => `<button class="btn" data-a="raise" data-v="${v}">🪙 ${fmt(v)}<span class="sub">pay 🪙 ${fmt(v * r.mult)}</span></button>`).join('')}</div>
    <div class="row"><input id="rcustom" type="number" inputmode="numeric" min="${r.min}" max="${r.max}" placeholder="Custom ${fmt(r.min)} to ${fmt(r.max)}" aria-label="Custom stake" style="height:48px;border-radius:12px;border:1.5px solid var(--line);background:var(--ink2);padding:0 12px"><button class="btn primary" style="flex:none" data-a="raiseCustom">Raise</button></div>`, 'raise');
}

/* ---------- hand guide overlay ---------- */
let guideDraft = [{}, {}, {}];
function openHandGuide() {
  openOverlay(`
    <div class="row" style="align-items:center;margin-bottom:6px"><h2 style="flex:1">🃏 Teen Patti Hand Guide</h2><button class="btn small" style="flex:none" data-a="close">Close</button></div>
    <p class="muted" style="margin:0 0 10px;font-size:.85rem">Check the rank of your physical cards anytime:</p>
    ${[0, 1, 2].map((i) => `
      <div class="cardpick">
        <select class="guide-sel" data-g="${i}" data-k="r" aria-label="Card ${i + 1} rank">
          <option value="">Card ${i + 1} Rank</option>
          ${RANKS.map((r) => `<option value="${r}" ${guideDraft[i].r === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <select class="guide-sel" data-g="${i}" data-k="s" aria-label="Card ${i + 1} suit">
          <option value="">Suit</option>
          ${SUITS.map(([v, t]) => `<option value="${v}" ${guideDraft[i].s === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>`).join('')}
    <div id="guide-result" style="margin:10px 0;padding:12px;border-radius:12px;background:var(--ink2);border:1.5px solid var(--line);text-align:center">
      <span class="muted">Select all 3 cards above to evaluate</span>
    </div>
    <div style="font-size:.8rem;color:var(--dim);border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
      <b>Standard Hand Ranking:</b><br>
      1. Trail / Trio (AAA > 222)<br>
      2. Pure Sequence (AKQ > A23 > KQJ > ... > 432)<br>
      3. Sequence / Straight (AKQ > A23 > KQJ > ...)<br>
      4. Color / Flush (highest card)<br>
      5. Pair (highest pair, then kicker)<br>
      6. High Card (A > K > ... > 2)
    </div>`, 'handGuide');
  updateHandGuideDisplay();
}

function updateHandGuideDisplay() {
  const el = $('#guide-result');
  if (!el) return;
  const res = evalClientHand(guideDraft);
  if (!res) {
    el.innerHTML = '<span class="muted">Select 3 cards to evaluate hand rank</span>';
    return;
  }
  const color = res.rank <= 3 ? 'var(--marigold)' : 'var(--ivory)';
  el.innerHTML = `<div style="font-size:1.15rem;font-weight:700;color:${color}">${esc(res.name)}</div>
    <div style="font-size:.85rem;color:var(--dim);margin-top:4px">Hand Rank: #${res.rank} of 6 (${esc(res.desc)})</div>`;
}

/* ---------- events ---------- */
function collectSettings() {
  const root = $('#settings'); if (!root) return null;
  const o = {};
  root.querySelectorAll('[data-s]').forEach((el) => {
    o[el.dataset.s] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  });
  const wild = root.querySelectorAll('[data-wild]');
  if (wild.length) o.customWild = [...wild].filter((c) => c.checked).map((c) => c.dataset.wild);
  return o;
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.closest('#settings') && isHost() && S && S.phase === 'lobby') { const s = collectSettings(); if (s) act({ type: 'settings', settings: s }); }
  if (t.dataset && t.dataset.card !== undefined) cardDraft[Number(t.dataset.card)][t.dataset.k] = t.value;
  if (t.classList && t.classList.contains('guide-sel')) {
    guideDraft[Number(t.dataset.g)][t.dataset.k] = t.value;
    updateHandGuideDisplay();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'chatin') doAction('sendChat');
  else if (e.target.id === 'j-code' || e.target.id === 'name') doAction(tab === 'join' ? 'join' : 'create');
  else if (e.target.id === 'rcustom') doAction('raiseCustom');
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'overlay') { closeOverlay(); return; }
  const b = e.target.closest('[data-a]'); if (!b) return;
  doAction(b.dataset.a, b.dataset);
});

function homeName() {
  const v = ($('#name').value || '').trim();
  if (!v) { toast('Please enter your name.'); $('#name').focus(); return null; }
  store.set('tp_name', v); return v;
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg, 'info'); } catch (e) { window.prompt('Copy this:', text); }
}

function doAction(a, d = {}) {
  switch (a) {
    case 'tab': tab = d.v; renderHome(); break;
    case 'create': {
      const name = homeName(); if (!name) return;
      sendFirst({ t: 'create', name, settings: {
        maxPlayers: Number($('#c-players').value), timer: Number($('#c-timer').value),
        startCoins: Number($('#c-coins').value), boot: Number($('#c-boot').value) } });
      break;
    }
    case 'join': {
      const name = homeName(); if (!name) return;
      const code = ($('#j-code').value || '').trim().toUpperCase();
      if (code.length < 4) { toast('Enter the room code.'); return; }
      sendFirst({ t: 'join', name, code });
      break;
    }
    case 'copyLink': copy(link(), 'Link copied to clipboard'); break;
    case 'copyCode': copy(S.code, 'Room code copied'); break;
    case 'share': navigator.share({ title: 'Teen Patti Physical Card Companion', text: `Join my physical Teen Patti table with code ${S.code}`, url: link() }).catch(() => {}); break;
    case 'qr': qrOn = !qrOn; renderLobby(); break;
    case 'ready': act({ type: 'ready' }); break;
    case 'start': act({ type: 'start' }); break;
    case 'resetCoins': act({ type: 'resetCoins' }); break;
    case 'topUp': act({ type: 'topUp' }); break;
    case 'cardsDealt': act({ type: 'cardsDealt' }); break;
    case 'call': act({ type: 'call' }); break;
    case 'fold': act({ type: 'fold' }); break;
    case 'show': act({ type: 'show' }); break;
    case 'sideshow': act({ type: 'sideshow' }); break;
    case 'seen': act({ type: 'seen' }); break;
    case 'raiseOpen': openRaise(); break;
    case 'raise': closeOverlay(); act({ type: 'raise', stake: Number(d.v) }); break;
    case 'raiseCustom': { const v = Number($('#rcustom') && $('#rcustom').value); if (!v) { toast('Enter a valid stake.'); return; } closeOverlay(); act({ type: 'raise', stake: v }); break; }
    case 'ssYes': act({ type: 'sideshowReply', accept: true }); break;
    case 'ssNo': act({ type: 'sideshowReply', accept: false }); break;
    case 'ssLoser': act({ type: 'sideshowResult', loserId: d.v }); break;
    case 'selectWinner': {
      pendingWinner = { id: d.v, name: d.v === 'split' ? 'Split the Pot' : nameOf(d.v) };
      render();
      break;
    }
    case 'confirmWinner': {
      if (pendingWinner) {
        act({ type: 'winner', winnerId: pendingWinner.id });
        pendingWinner = null;
      }
      break;
    }
    case 'cancelWinner': {
      pendingWinner = null;
      render();
      break;
    }
    case 'submitCards': {
      if (cardDraft.some((c) => !c.r || !c.s)) { toast('Pick rank and suit for all 3 cards.'); return; }
      act({ type: 'cards', cards: cardDraft.map((c) => ({ r: c.r, s: c.s })) }); cardDraft = [{}, {}, {}]; break;
    }
    case 'next': act({ type: 'next' }); break;
    case 'end': if (S.phase === 'settled' || confirm('End this round and return everyone to the lobby? Coins in the pot will be refunded.')) { closeOverlay(); act({ type: 'end' }); } break;
    case 'pause': act({ type: 'pause' }); break;
    case 'resume': act({ type: 'resume' }); break;
    case 'kick': if (confirm(`Remove ${nameOf(d.v)} from the room?`)) act({ type: 'kick', playerId: d.v }); break;
    case 'leave': if (confirm('Leave this room? You will fold out of the current round.')) { closeOverlay(); act({ type: 'leave' }); } break;
    case 'menu': openMenu(); break;
    case 'chat': openChat(); break;
    case 'handGuide': openHandGuide(); break;
    case 'toggleView': {
      viewMode = viewMode === 'table' ? 'list' : 'table';
      store.set('tp_view', viewMode);
      render();
      break;
    }
    case 'close': closeOverlay(); if (S) render(); break;
    case 'sound': soundOn = !soundOn; store.set('tp_sound', soundOn); if (soundOn) tone(660, .08); openMenu(); break;
    case 'react': act({ type: 'react', emoji: d.e }); break;
    case 'sendChat': { const i = $('#chatin'); if (i && i.value.trim()) { act({ type: 'chat', text: i.value }); i.value = ''; } break; }
    default: break;
  }
}

renderHome();
connect();
})();
