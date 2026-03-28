# Polymarket 15-Minute Crypto Hedge Bot

Automated trading bot for Polymarket that trades **15-minute crypto Up/Down markets** (BTC, extensible to ETH/SOL). Places orders on **both YES and NO** so the **combined average cost per pair stays below $1.00**, locking in profit at resolution regardless of outcome.

## Strategy

Based on the "gabagool" strategy documented in the [CoinsBench article](https://coinsbench.com/inside-the-mind-of-a-polymarket-bot-3184e9481f0a):

```
avg_YES = Cost_YES / Qty_YES
avg_NO  = Cost_NO  / Qty_NO
Pair Cost = avg_YES + avg_NO    → must be < $1.00

Profit = min(Qty_YES, Qty_NO) - (Cost_YES + Cost_NO)
```

The bot buys YES when YES is cheap, buys NO when NO is cheap, and **never** places an order that would push the pair cost above the safety threshold.

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| Entry point | `src/index.ts` | Loads config, CLOB client, starts dashboard + bot |
| Strategy config | `strategy.config.json` + `src/config/strategyConfig.ts` | All thresholds, sizing, timing (env overrides) |
| Market discovery | `src/services/marketDiscovery.ts` | Gamma API; finds active 15m crypto markets; rolls forward |
| Hedge strategy | `src/services/hedgeStrategy.ts` | Core pair-cost logic; BUY_YES / BUY_NO / HOLD decisions |
| Order manager | `src/services/orderManager.ts` | CLOB orderbook reads, limit order placement, cancel, fill tracking |
| Bot loop | `src/services/hedgeBot.ts` | Tick loop with mutex, partial fill reconciliation, window P/L |
| Risk controls | `src/services/riskManager.ts` | Max position/window, daily spend, kill switch, circuit breaker |
| Logging | `src/services/strategyLogger.ts` | Structured CSV + JSON logs under `logs/` |
| P/L summary | `src/services/plSummary.ts` | Aggregate P/L by day and by window (standalone or import) |
| Dashboard | `src/services/dashboard.ts` | HTTP dashboard with auto-refresh, kill switch, metrics |
| Simulation | `src/scripts/simulateBacktest.ts` | Multi-window backtest with summary statistics |

## Quick Start

### 1. Environment setup

```bash
cp .env.example .env
# Fill in: PUBLIC_ADDRESS, PROXY_WALLET, PRIVATE_KEY, MONGO_URI, RPC_URL, WSS_URL
```

### 2. Install and build

```bash
npm install
npm run build
```

### 3. Run simulation (no wallet needed)

```bash
npm run simulate
```

Shows 50 simulated 15-minute windows with pair cost tracking and P/L summary.

### 4. Paper trading (connects to Polymarket API, reads real orderbooks, no real orders)

```bash
# In strategy.config.json, ensure "liveTrading": false
npm start
```

Dashboard: http://localhost:3750

### 5. Live trading

```bash
# In strategy.config.json, set "liveTrading": true
# WARNING: This places real orders with real money
npm start
```

Use the dashboard kill switch to stop new orders without shutting down.

### 6. View P/L summary

```bash
npm run summary
```

## Configuration (`strategy.config.json`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `targetPairCostMax` | 0.99 | Max allowed pair cost |
| `safetyMargin` | 0.98 | Only place order if simulated pair cost stays below this |
| `maxPositionPerWindowUsd` | 500 | Max USD per 15-minute window |
| `maxDailySpendUsd` | 5000 | Max USD per day across all windows |
| `orderSizeShares` | 10 | Order size per leg (shares) |
| `orderMinSize` | 1 | Minimum order size |
| `tickSize` | 0.01 | Price tick size |
| `pollIntervalMs` | 5000 | How often to poll (ms) |
| `stopTradingSecondsBeforeEnd` | 60 | Stop placing orders this many seconds before window end |
| `marketSlugs` | ["btc","bitcoin","15"] | Keywords to match 15m crypto markets |
| `liveTrading` | false | false = paper, true = real CLOB orders |
| `killSwitch` | false | Emergency stop (also togglable from dashboard) |
| `circuitBreakerFailures` | 5 | Pause after N consecutive order failures |
| `feeBips` | 10 | Fee assumption for P/L estimates (basis points) |

## Logs

- **Directory:** `logs/` (or `STRATEGY_LOG_DIR`)
- **Files:** `strategy_YYYY-MM-DD.csv` and `.json`
- **Columns:** timestamp, marketSlug, windowEndIso, pairCost, qtyYes, qtyNo, costYes, costNo, lockedProfit, totalSpentUsd, event, message, feeBipsAssumption, realizedFeesUsd

## Dashboard

HTTP dashboard at port **3750** (or `DASHBOARD_PORT`):

- Real-time pair cost, qty YES/NO, locked profit, daily spend
- Kill switch toggle (stops new orders without exiting)
- Auto-refreshes every 5 seconds
- JSON API at `/status`

## Partial Fill Handling

GTC limit orders may not fill immediately or completely. The bot handles this properly:

1. **Track, don't assume** — When a live order is placed, it is tracked as "pending" but `WindowState` is NOT updated. State only changes when fills are confirmed.
2. **Reconcile each tick** — At the start of every tick, `reconcilePendingOrders()` queries the CLOB for each pending order's actual fill status and applies confirmed fills.
3. **No order stacking** — The bot will not place a second order on the same side while a pending order exists on that side.
4. **Pending exposure in risk checks** — Worst-case cost of all pending orders is included in risk limit calculations to avoid over-committing.
5. **End-of-window cleanup** — All pending orders are cancelled and a final reconciliation captures any last-moment fills.

In paper mode, fills are simulated as instant (no pending tracking needed).

## Risk Controls

1. **Kill switch** — stops all new order placement (config or dashboard)
2. **Max position per window** — caps total USD spent per 15-minute window
3. **Max daily spend** — caps total USD spent per day
4. **Circuit breaker** — pauses after N consecutive order failures
5. **Pair cost ceiling** — never places an order that would push pair cost >= target
6. **End-of-window cutoff** — stops trading and cancels open orders before window ends
7. **Liquidity check** — respects available size at best ask (won't oversize)
8. **Pending exposure guard** — includes unfilled order exposure in all risk calculations

## VPS Deployment (Ireland)

Run on a VPS in Ireland (or any non-US region) to comply with Polymarket's geographic restrictions:

```bash
# On VPS
git clone <repo>
cd Polymarket-betting-bot-main
cp .env.example .env
# Configure .env
npm install && npm run build
npm start
```

Use `screen` or `pm2` to keep the bot running:
```bash
pm2 start dist/index.js --name polymarket-bot
```

## Implementation Plan

See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the detailed technical write-up covering:
- How the bot achieves and maintains combined cost < $1.00
- How partial fills, spread changes, and edge cases are handled
- Architecture flow diagram
- Risk control matrix
- Testing plan
