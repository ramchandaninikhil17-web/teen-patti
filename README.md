# Teen Patti Physical Card Companion

A live, lightweight digital companion for **physical-card Teen Patti**.

> **IMPORTANT PRODUCT DEFINITION:**
> This application does NOT deal digital cards. Players use their **own physical deck of cards**.
> The application acts as the digital table manager: it tracks players, turns, blind/seen status, bets, raises, folds, side-shows, the pot, timers, fake coins, winner confirmation, and round settlements.
> **No real money. No deposits. No withdrawals. No payment gateways. No database.**

---

## Architecture & Technology Stack

- **Backend**: Node.js HTTP + Authoritative WebSocket server (`ws`). In-memory game state and room registry.
- **Frontend**: Vanilla HTML5, CSS3, and JavaScript. Lightweight, mobile-first responsive design (360px up to desktop 1440px). No heavy frameworks or asset bloat.
- **State Machine**:
  `LOBBY` → `READY` → `STARTING` → `DEALING_PHYSICAL` → `BETTING` → `SHOW/SIDE_SHOW` → `RESULT` → `SETTLEMENT` → `ROUND_COMPLETE` → `NEXT_ROUND`
- **Real-Time Synchronization**: Authoritative, low-latency WebSocket events for all game actions.
- **Idempotency**: Client action IDs prevent duplicate bets or actions on network retries or double-clicks.
- **Single-Service / Multi-Cloud**: Can run as a single combined service on Railway (serves both static assets and WebSockets), or split with the static frontend on Vercel and WebSocket backend on Railway.

---

## Quick Start (Local Development)

### Prerequisites
- Node.js 18+ (tested on Node.js 24)
- npm 9+

### Installation & Run
```bash
# Install dependencies
npm install

# Run automated tests (Unit + Live WebSocket tests)
npm test

# Run syntax check / linting
npm run lint

# Validate build
npm run build

# Start local server (default: http://localhost:3000)
npm start
```

Visit `http://localhost:3000` in your browser.

---

## Production Deployment Guides

### 1. GitHub Setup
```bash
git init
git add .
git commit -m "feat: production-ready physical card teen patti companion"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/teen-patti.git
git push -u origin main
```

---

### 2. Railway Backend Deployment (Recommended Single Service)

Railway can host the complete application (both static frontend and WebSocket backend) in a single service:

1. Log in to [Railway](https://railway.com).
2. Click **New Project** → **Deploy from GitHub repo**.
3. Select your repository.
4. Railway will automatically detect Node.js and use the included [railway.json](file:///c:/Users/ramch/Downloads/teen-patti/railway.json) configuration (`node server.js` with Nixpacks).
5. Go to **Settings** → **Networking** → Click **Generate Domain** (e.g. `teen-patti-production.up.railway.app`).
6. Set Environment Variables (optional, see below):
   - `PORT`: Automatically assigned by Railway.
   - `ALLOWED_ORIGIN`: `*` (or your frontend domain).
7. Health check endpoint: `/health`.
8. Open the generated domain in your browser.

---

### 3. Vercel Frontend Deployment (Optional Static Hosting)

If you wish to deploy the frontend separately on Vercel:

1. Log in to [Vercel](https://vercel.com).
2. Click **Add New Project** → Import your GitHub repository.
3. In Project Settings:
   - **Framework Preset**: Other
   - **Root Directory**: `./` (the included [vercel.json](file:///c:/Users/ramch/Downloads/teen-patti/vercel.json) automatically serves `public`).
4. Connect to your Railway Backend (3 easy ways):
   - **Method 1 (Zero-code via UI)**: Open your Vercel site, tap the **Server Status badge** on the home screen, paste your Railway WebSocket URL (e.g. `wss://your-backend.up.railway.app/ws`), and tap **Connect & Save**. It is saved in `localStorage` permanently.
   - **Method 2 (In Code)**: Edit [public/config.js](file:///c:/Users/ramch/Downloads/teen-patti/public/config.js):
     ```javascript
     window.TP_WS_URL = 'wss://your-backend.up.railway.app/ws';
     ```
   - **Method 3 (Via URL query)**: Share links with the backend URL embedded:
     `https://your-app.vercel.app/?ws=wss://your-backend.up.railway.app/ws`
5. Click **Deploy**.

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the HTTP and WebSocket server. Supplied automatically on Railway. |
| `ALLOWED_ORIGIN` | `*` | Allowed CORS origin for HTTP requests (e.g., `https://your-frontend.vercel.app`). |
| `TP_WS_URL` (client) | `''` | WebSocket endpoint in `config.js` when frontend is hosted separately from backend. |

---

## How Physical Card Play Works

1. **Create / Join Room**:
   - Host creates a room (2–10 players, default: 3).
   - A short 6-character room code (e.g. `TP7K29`) is generated.
   - Players join via room code or shareable direct link.
2. **Lobby & Ready State**:
   - Players mark themselves **Ready** (🟢).
   - Host configures table rules: boot, timer, variant, side-show toggle, verify mode.
   - Host clicks **Start Game**.
3. **Physical Deal**:
   - The screen announces: *"Shuffle your real deck and deal 3 cards to each player."*
   - Host deals real cards around the physical table.
   - Host taps **Cards Dealt** on the screen.
4. **Betting Rounds**:
   - Starting boot is automatically deducted into the pot.
   - Turn rotates clockwise or anti-clockwise.
   - Players act on their turn:
     - **Play Blind**: Pays 1× current stake.
     - **Seen**: Taps *"I have seen my cards"*. Pays 2× current stake.
     - **Raise**: Increases the stake (up to 2× current stake, capped by table limit).
     - **Fold**: Surrenders hand and leaves pot.
     - **Side Show**: Requested from the previous active player if both have seen cards. Previous player can accept or reject. If accepted, players compare cards physically and host marks who lost.
     - **Show**: When only 2 active players remain, either can request a show.
5. **Winner Confirmation & Settlement**:
   - After a Show, the screen prompts: *"Compare your physical cards."*
   - Host confirms the winner (or selects Split Pot).
   - The pot is settled immediately into the winner's fake coin balance.
   - Host taps **Next Round** to reset the pot, rotate the dealer, and continue playing.

---

## Hand Ranking Hierarchy & Variants

### Standard Teen Patti Hand Rankings
1. **Trail / Trio / Three of a Kind**: Three cards of the same rank ($A-A-A > K-K-K > \dots > 2-2-2$).
2. **Pure Sequence / Straight Flush**: Three consecutive cards of the same suit ($A-K-Q > A-2-3 > K-Q-J > \dots > 4-3-2$).
3. **Sequence / Normal Straight**: Three consecutive cards of mixed suits ($A-K-Q > A-2-3 > K-Q-J > \dots > 4-3-2$).
4. **Color / Flush**: Three cards of the same suit, not in sequence (highest card compared, then second, then third).
5. **Pair**: Two cards of the same rank (highest pair wins; if equal, highest kicker wins).
6. **High Card**: Highest single card wins.

*Note on Ties*: If an exact tie occurs in a Show, the player who demanded the show loses.

### Supported Variants
- **Classic**: Standard rules, highest hand wins.
- **Muflis**: Lowest hand wins (ranking completely inverted; $5-3-2$ unsuited beats Trail of Aces).
- **AK47**: Cards with ranks $A$, $K$, $4$, and $7$ are wild.
- **Joker**: A random rank is selected as wild for each round.
- **999**: All $9$s are wild.
- **Lowest Joker**: The lowest card in each player's hand acts as wild.
- **Custom**: Customize wild card ranks and toggle lowest-wins.

---

## Production QA & Verification Checklist

- [x] Room creation with 2–10 players (default: 3 players).
- [x] Short room codes & shareable direct links (`?room=CODE`).
- [x] Lobby player list with real-time **Ready / Waiting** badges and Host indicators.
- [x] Physical card prompt: *"Shuffle and deal your physical cards"* → *"Cards Dealt"*.
- [x] Authoritative server turn rotation, timer, and auto-fold timeout.
- [x] Correct betting arithmetic: Blind ($1\times$), Seen ($2\times$), integer pot calculations.
- [x] Side-show request, target acceptance/rejection, and host resolution.
- [x] Showdown with 2 players left, winner confirmation, pot settlement, and Next Round dealer rotation.
- [x] Disconnect & seamless reconnect using persistent browser session token.
- [x] Action idempotency protecting against duplicate network messages and double-clicks.
- [x] Responsive layout tested for mobile viewports (360px, 375px, 390px, 412px) and desktop.
- [x] Zero external database dependencies; memory lifecycle with automatic 15-minute cleanup of stale rooms.
