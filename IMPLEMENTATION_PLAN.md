# Implementation Plan: Polymarket 15-Minute Crypto Hedge Bot

**Milestone 1 Deliverable** — How we achieve and maintain combined cost < $1.00, and how we handle partial fills, spread changes, and edge cases.

---

## 1. Strategy Overview

The bot implements the "gabagool" arbitrage strategy described in the [CoinsBench article](https://coinsbench.com/inside-the-mind-of-a-polymarket-bot-3184e9481f0a):

**Core Idea:** In a binary YES/NO market, exactly one side resolves to $1.00 and the other to $0.00. If we hold equal quantities of both YES and NO shares, our payout is always $1.00 per pair regardless of outcome. If our combined cost per pair is **below** $1.00, the difference is guaranteed profit.

**Key Formulas:**

```
avg_YES   = Cost_YES / Qty_YES
avg_NO    = Cost_NO  / Qty_NO
Pair Cost = avg_YES + avg_NO          (must be < $1.00)
Profit    = min(Qty_YES, Qty_NO) * $1.00 - (Cost_YES + Cost_NO)
```

---

## 2. How We Achieve Combined Cost < $1.00

### 2.1 Pre-Order Simulation

Before every order, the `decide()` function in `hedgeStrategy.ts` runs a **simulation** of what the window state would look like *after* the proposed fill:

1. Take current `WindowState` (qty, cost, avg for each side)
2. Simulate adding `deltaQty` shares at the proposed `price` to the proposed `side`
3. Recalculate `newPairCost = newAvgYes + newAvgNo`
4. **REJECT the order** if `newPairCost > safetyMargin` (e.g., 0.98) when both sides have positions

This means the bot **never places an order that would push pair cost above the target**. The `safetyMargin` is set slightly below `targetPairCostMax` to provide a buffer.

### 2.2 DCA / Averaging Logic

The bot runs every `pollIntervalMs` (default 5 seconds) and places small orders (default 10 shares) on whichever side is currently cheaper. Over 30+ ticks per 15-minute window, it accumulates positions on both sides through dollar-cost averaging:

- When YES is cheap (e.g., $0.48), buy YES
- When NO is cheap (e.g., $0.47), buy NO
- The combined average trends below $1.00 because both sides are bought at depressed prices

### 2.3 Inventory Balancing

The `decide()` function computes a `balanceImprovement` metric for each candidate order:

```
currentImbalance = |Qty_YES - Qty_NO|
newImbalance     = |newQty_YES - newQty_NO|
improvement      = currentImbalance - newImbalance
```

Candidates are sorted to prefer the side that **improves balance**, then by lower simulated pair cost. This keeps YES and NO quantities approximately equal, maximizing the hedged portion.

### 2.4 Single-Side Price Guard

When the bot has only purchased one side so far, the pair cost is just that side's average (not yet meaningful as a combined metric). To prevent buying at prices that make future hedging impossible, orders are rejected if `price > pairCostCeiling`. For example, if the ceiling is $0.98, buying YES at $0.99 would leave no room for NO to bring the combined cost under $0.98.

### 2.5 Hard Floor

Regardless of all other checks, the bot has an absolute hard stop: **never allow pair cost >= $1.00** when both sides have positions. This is the fundamental requirement — pair cost >= $1.00 means guaranteed loss.

---

## 3. How We Handle Partial Fills

The bot uses **GTC (Good Till Cancelled) limit orders**, which may not fill immediately or completely. Our approach:

### 3.1 Pending Order Tracking

When a live order is placed, it is **NOT** immediately counted as filled. Instead:

1. A `PendingOrder` record is created with `sizeFilled = 0`
2. The order ID, side, price, and requested size are stored
3. `WindowState` remains unchanged at placement time

### 3.2 Fill Reconciliation (Every Tick)

At the start of each tick, before making any new decisions:

1. `reconcilePendingOrders()` queries the CLOB for each pending order's status
2. Uses `getOrder(orderId)` to check `size_matched` (actual filled quantity)
3. Computes `newFillQty = totalFilled - previouslyRecordedFill` (the delta)
4. Falls back to `getOpenOrders()` check: if order is no longer open, assumes full fill

### 3.3 State Update From Confirmed Fills

Only when a fill is **confirmed** does the bot update `WindowState`:

```typescript
windowState = updateWindowStateFromFill(windowState, fill.side, fill.newFillQty, fill.newFillCost);
```

This means pair cost, inventory quantities, and locked profit are always based on **actual fills**, not optimistic assumptions.

### 3.4 Avoiding Order Stacking

The bot will not place a second order on the same side while a pending order exists. This prevents:
- Double-counting exposure in risk checks
- Accumulating multiple open orders that all fill simultaneously and breach limits
- Overcommitting capital

### 3.5 Pending Exposure in Risk Checks

When checking risk limits (max position per window, max daily spend), the bot adds `pendingExposure` (worst-case cost if all pending orders fill) to the proposed order cost:

```typescript
const riskCheck = canPlaceOrder(config, riskState, state, additionalSpend + pendingExposure);
```

This ensures we don't exceed limits even if all pending orders fill.

### 3.6 End-of-Window Cleanup

When the window is about to end (`stopTradingSecondsBeforeEnd`):

1. Cancel all open orders for both YES and NO tokens
2. Run one final `reconcilePendingOrders()` to capture any fills that occurred before cancellation
3. Clear the pending orders list
4. Log the final window state

### 3.7 Paper Mode

In paper/simulation mode, fills are assumed to be instant (the market is simulated). Pending order tracking is only active in `liveTrading: true` mode.

---

## 4. How We Handle Other Edge Cases

### 4.1 Failed Orders

- Order failures increment `consecutiveOrderFailures`
- After `circuitBreakerFailures` consecutive failures (default: 5), the bot stops placing new orders
- Successful orders reset the failure counter
- All failures are logged with the error message

### 4.2 Sudden Spread Changes

- The bot re-reads the full orderbook on every tick (every 5 seconds)
- Each order decision is based on the **current** best ask, not a stale price
- If the spread widens and no order would keep pair cost under ceiling, the bot holds

### 4.3 No Liquidity

- If neither YES nor NO has any asks (no liquidity), the bot returns `HOLD`
- If only one side has liquidity, only that side is considered
- Available size at best ask is respected — the bot won't place orders larger than what's on the book

### 4.4 Market Discovery and Window Rollover

- The bot checks the Gamma API every 30 seconds for active 15-minute crypto markets
- When a new window is detected (different slug or endDateIso), the previous window is summarized and state is reset
- Markets are sorted by `endTime` — the soonest-ending active market is always chosen
- Keywords are configurable (default: btc, bitcoin, 15; extensible to ETH/SOL)

### 4.5 Kill Switch

- Can be toggled from the dashboard UI or set in config
- When active, no new orders are placed
- The bot continues monitoring but does not trade
- Existing pending orders are NOT automatically cancelled (explicit user action)

---

## 5. Risk Control Summary

| Control | Config Parameter | Default | Description |
|---------|-----------------|---------|-------------|
| Pair cost ceiling | `safetyMargin` | 0.98 | Pre-order simulation rejects orders above this |
| Hard pair cost max | `targetPairCostMax` | 0.99 | Absolute maximum; tighter of the two is used |
| Max per window | `maxPositionPerWindowUsd` | $500 | Caps total USD committed per 15-min window |
| Max daily spend | `maxDailySpendUsd` | $5,000 | Caps total USD across all windows per day |
| Circuit breaker | `circuitBreakerFailures` | 5 | Pauses after N consecutive order failures |
| Kill switch | `killSwitch` | false | Emergency stop from config or dashboard |
| End-of-window cutoff | `stopTradingSecondsBeforeEnd` | 60s | Stops trading and cancels orders before window ends |
| Liquidity check | (built-in) | — | Won't place orders exceeding available book size |
| Pending exposure | (built-in) | — | Includes unfilled order exposure in risk calculations |

---

## 6. Logging and P/L Reporting

### Per-Tick Logging

Every order placement, fill, failure, and risk block is logged to:
- `logs/strategy_YYYY-MM-DD.csv` — spreadsheet-compatible
- `logs/strategy_YYYY-MM-DD.json` — machine-readable (one JSON object per line)

### Fields Logged

`timestamp, marketSlug, windowEndIso, pairCost, qtyYes, qtyNo, costYes, costNo, lockedProfit, totalSpentUsd, event, message, feeBipsAssumption, realizedFeesUsd`

### P/L Summary

Run `npm run summary` to generate aggregate reports:
- **Net P/L by day and by market window** — groups log entries by window, calculates final state
- **Fees/slippage assumptions vs realized** — reports estimated fees (configurable bips) alongside realized fees when available

---

## 7. Architecture Flow

```
[Every 5 seconds]
    │
    ▼
 ┌──────────────────────┐
 │  1. Reconcile Fills   │ ← Check pending orders for actual fill data
 │     (live mode only)  │
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │  2. Market Discovery  │ ← Find current active 15m crypto market
 │     (Gamma API, 30s)  │
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │  3. Window Detection  │ ← New window? Log summary, reset state
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │  4. Read Orderbooks   │ ← CLOB orderbooks for YES + NO tokens
 │     (parallel)        │
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │  5. Strategy Decision │ ← Simulate pair cost, pick BUY_YES/BUY_NO/HOLD
 │     (hedgeStrategy)   │
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │  6. Risk Check        │ ← Kill switch, circuit breaker, limits, pending exposure
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │  7. Place Order       │ ← GTC limit order via CLOB
 │     Track as Pending  │
 └──────────┬───────────┘
            ▼
 ┌──────────────────────┐
 │  8. Log + Dashboard   │ ← CSV/JSON log entry, update dashboard state
 └──────────────────────┘
```

---

## 8. Testing Plan

| Test | Method | Purpose |
|------|--------|---------|
| Strategy simulation | `npm run simulate` | 50 windows with realistic prices; validates pair cost < $1.00 |
| Paper trading | `npm start` (liveTrading: false) | Real orderbooks, simulated fills; validates decision logic |
| Live pilot | `npm start` (liveTrading: true) | Small real orders; validates full stack including partial fills |
| P/L reporting | `npm run summary` | Validates logging and aggregation accuracy |
| Dashboard | http://localhost:3750 | Visual verification of metrics and kill switch |

---

*This document satisfies Milestone 1's "Written implementation plan" requirement.*
