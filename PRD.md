# Product Requirements Document (PRD)
# Teen Patti Physical Card Companion

**Version:** 2.0.0 (Production Release)  
**Status:** Approved & Implemented  
**Target Environments:** Railway (Backend + Full Stack) & Vercel (Static Frontend)  
**Primary Audience:** Friends and families playing real Teen Patti with physical cards at home.

---

## 1. Executive Summary & Product Vision

**Teen Patti Companion** is a fast, lightweight, real-time web application engineered specifically as a digital table manager for **real, physical-card Teen Patti games**.

### 1.1 The Core Product Definition
- **NOT a digital card game**: The website **NEVER deals digital cards**. Players hold their own physical deck of 52 playing cards.
- **Digital Table Manager**: The website handles everything that is tedious, error-prone, or causes disputes in live physical card games:
  - Room creation and joining via 6-digit codes and shareable links
  - Player turn rotation and authoritative countdown timers
  - Blind vs. Seen player status tracking
  - Boot deduction, calls, raises, and pot calculations
  - Side-show requests, acceptance/rejections, and resolution
  - Showdown coordination and two-step winner confirmation
  - Fake coin balances, win/loss statistics, and pot settlements
  - Automatic dealer rotation across consecutive rounds
- **Zero Real Money**: Only virtual "Fake Coins" (default: 10,000 coins). No cash deposits, no withdrawals, no UPI, no bank cards, no cryptocurrency, and no gambling gateway integration.
- **Zero External Database**: Completely memory-based for maximum speed, zero hosting latency, and effortless deployment without provisioning PostgreSQL, MongoDB, or Supabase.

---

## 2. System Architecture & Tech Stack

```
┌────────────────────────────────────────────────────────┐
│                   CLIENT (BROWSER)                     │
│  Vanilla HTML5 + Modern CSS3 + Vanilla ES6 JavaScript  │
│  - Mobile-First Responsive Design (360px – 1440px)     │
│  - Dual View: Visual Oval Felt Table & Practical List  │
│  - Audio Feedback via Web Audio API                    │
│  - Local Preferences & Reconnection Token in Storage   │
└───────────────────────────▲────────────────────────────┘
                            │
               WebSocket    │ Event-Based Updates
              (JSON over WS)│ (Sub-50ms latency)
                            │
┌───────────────────────────▼────────────────────────────┐
│                    NODE.JS BACKEND                     │
│  - Native HTTP Server (Health check, CORS, Static App) │
│  - Authoritative WebSocket Server (ws)                 │
│  - In-Memory Rooms Registry (Map<roomCode, Room>)      │
│  - Server-Authoritative State Machine & Turn Clock     │
│  - Deterministic Hand Evaluator & Variant Rules Engine │
│  - Action Idempotency & Flood Protection               │
└────────────────────────────────────────────────────────┘
```

### 2.1 Technology Decisions
1. **Frontend**: Lightweight vanilla HTML/CSS/JS without React/Next.js bundle overhead. First Contentful Paint is under 150ms on mobile 4G networks.
2. **Backend**: Lightweight Node.js service using `ws`. Both static assets and WebSockets run seamlessly on a single port for Railway single-container deployment.
3. **Multi-Cloud Ready**: Static files in `public/` deploy to Vercel with zero configuration via `vercel.json`.

---

## 3. Authoritative State Machine

The game is governed by a strict server-authoritative state machine:

```
[ LOBBY ]
   │
   │  Host clicks "Start Game" (min 2, max 10 players)
   ▼
[ DEALING_PHYSICAL ]
   │
   │  Physical cards dealt; Host taps "Cards Dealt"
   ▼
[ BETTING ] ◄──────────────────────┐
   │                               │
   ├─► Player calls / raises ──────┤ (Turn rotates)
   ├─► Player folds ───────────────┤ (If >2 players remain)
   ├─► Last player standing ───────┼──────────────┐
   │                               │              │
   ├─► SIDE_SHOW ──────────────────┤              │
   │    ├─ Rejected: resumes turn  │              │
   │    └─ Accepted: host picks    │              │
   │       loser, loser folds ─────┘              │
   │                                              │
   └─► SHOW (Only 2 players left)                 │
        │                                         │
        ▼                                         ▼
   [ SHOWDOWN ]                           [ SETTLEMENT ]
        │                                         │
        │  Physical cards compared;               │
        │  Host selects winner;                   │
        │  Two-step confirmation prevents errors  │
        ▼                                         ▼
   [ CONFIRMED RESULT ] ─────────────────► [ SETTLEMENT ]
                                                  │
                                                  │ Pot distributed
                                                  ▼
                                           [ ROUND COMPLETE ]
                                                  │
                                                  │ Host taps "Next Round"
                                                  ▼
                                           [ DEALING_PHYSICAL ]
                                           (Dealer rotated)
```

---

## 4. Game Rules & Logic Specifications

### 4.1 Room & Player Limits
- **Min Players:** 2
- **Default Room Size:** 3 players
- **Max Players:** 10 players
- **Starting Coins:** 10,000 fake coins (configurable from 100 to 10,000,000)
- **Default Boot:** 100 coins
- **Default Turn Timer:** 15 seconds (configurable from 5 to 120s)
- **Default Timeout Action:** Auto-fold (configurable to Auto-call)

### 4.2 Standard Hand Ranking Hierarchy
1. **Trail / Trio / Three of a Kind:** 3 cards of the same rank ($A-A-A > K-K-K > \dots > 2-2-2$).
2. **Pure Sequence / Straight Flush:** 3 consecutive cards of the same suit ($A-K-Q > A-2-3 > K-Q-J > \dots > 4-3-2$).
3. **Sequence / Normal Straight:** 3 consecutive cards of mixed suits ($A-K-Q > A-2-3 > K-Q-J > \dots > 4-3-2$).
4. **Color / Flush:** 3 cards of the same suit, not in sequence ($A-K-9 > A-K-8$, etc.).
5. **Pair:** 2 cards of matching rank (higher pair rank wins; on tie, kicker breaks tie).
6. **High Card:** Highest card compared, then second, then third ($A-K-J > A-K-10$).

*Tie Resolution:* On an exact tie in a Show, the player who demanded the show loses.

### 4.3 Supported Configurable Variants
- **Classic:** Standard rules.
- **Muflis:** Lowest hand wins (rankings inverted; $5-3-2$ unsuited beats Trail of Aces).
- **AK47:** Cards with rank $A$, $K$, $4$, and $7$ are wild.
- **Joker:** A random rank is selected as wild for each round.
- **999:** All $9$s are wild.
- **Lowest Joker:** The lowest card in each player's hand is wild.
- **Custom:** Customizable wild ranks and lowest-wins toggle.

---

## 5. End-to-End User Experience & Flow

### 5.1 Room Creation & Lobby
1. User enters player name and clicks **Create Room** (or enters room code to **Join Room**).
2. Host is generated a short 6-character room code (e.g., `TP7K29`).
3. Lobby displays:
   - Room code + Copy link / Copy code / QR / Share.
   - Player count (e.g., `3 / 3 players`).
   - Player list with status: `Host 👑`, `Ready 🟢`, or `Waiting ⏳`.
   - Non-hosts have an **I'm Ready 🟢** / **Cancel Ready** button.
   - Host has **Start Game** button (enabled when $\ge 2$ players are in room).

### 5.2 Physical Deal Phase
- Screen displays: *"Shuffle and deal your physical cards (3 cards each)."*
- Host deals real cards around the table.
- Host presses **Cards Dealt** on the screen.
- Server transitions state to `betting` and starts the countdown timer for the first player.

### 5.3 Betting Phase
- Active player is visually highlighted with a glowing border and sound prompt.
- Available actions:
  - **Play Blind:** Costs $1\times$ current stake.
  - **Call (Seen):** Costs $2\times$ current stake.
  - **Raise:** Increases stake by increments up to $2\times$ (capped by table limit).
  - **Fold:** Surrenders hand.
  - **Side Show:** Requested from previous active seen player. Target accepts or rejects. If accepted, players compare cards secretly and host marks loser.
  - **Show:** Available when exactly 2 active players remain.
  - **Mark Seen (👁):** Available to any player at any time to toggle from Blind to Seen.

### 5.4 Showdown & Two-Step Winner Confirmation
1. Screen announces: *"COMPARE YOUR PHYSICAL CARDS."*
2. Host selects candidate winner (e.g., `Rahul`) or `Split Pot`.
3. Confirmation dialogue prevents accidental misclicks:
   ```
   Confirm Winner?
   🏆 Rahul
   Prize: 1,800 Coins
   [ CONFIRM RESULT ]  [ CHANGE / CANCEL ]
   ```
4. Upon confirmation, pot is settled immediately on the server.

### 5.5 Round Complete & Settlement
- Displays winner name, total pot collected, and net gain/loss for every player.
- Host clicks **Next Round**.
- Server preserves player names, balances, and room settings; resets round state, pot, and folded flags; and automatically rotates the dealer position.

---

## 6. Real-Time WebSocket Protocol Specifications

| Message `t` | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `ping` / `pong` | Bidirectional | None | Heartbeat keeping connection alive through proxies |
| `create` | Client → Server | `{ name, settings }` | Creates room with caller as Host |
| `join` | Client → Server | `{ code, name }` | Joins existing room |
| `resume` | Client → Server | `{ code, token }` | Reconnects existing seat using secret token |
| `joined` | Server → Client | `{ code, token, id }` | Acknowledges seat join/creation |
| `act` | Client → Server | `{ a: { type, aid, ... } }` | Dispatches validated game action |
| `state` | Server → Client | `{ s: ViewObject }` | Broadcasts authoritative room state |
| `error` | Server → Client | `{ msg, fatal }` | Notifies user of an invalid action |
| `react` | Bidirectional | `{ id, emoji }` | Broadcasts floating emoji reaction |

---

## 7. Security, Reliability & Idempotency

1. **Server Authority**: The client never calculates pot, balance, turns, or winners. All state changes are computed and validated server-side.
2. **Action Idempotency**: Actions include a client-generated sequence identifier `aid`. Re-sent packets or accidental double-clicks return silently without corrupting the pot or turn order.
3. **Session Reconnection**: Reconnecting players present their cryptographically random 24-character token (`crypto.randomBytes(12)`). If a player loses mobile signal or refreshes the page, they are restored to their exact seat, coins, and turn.
4. **Memory Lifecycle**: Inactive or abandoned rooms are evicted after 15 minutes of inactivity to prevent server memory leaks.
