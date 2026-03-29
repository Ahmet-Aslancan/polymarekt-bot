/**
 * Interfaces for BTC Up/Down pair strategy (reference-wallet logic, maker bids).
 * Works for 5m or 15m windows via btcMarketWindowMinutes.
 */

export interface StrategyConfig {
    /** 5 or 15 — which btc-updown-{n}m market series to trade */
    btcMarketWindowMinutes: 5 | 15;
    /** Max allowed pair cost (avg_YES + avg_NO). Must be < 1.0. e.g. 0.96–0.99 */
    targetPairCostMax: number;
    /** Safety margin: only place order if simulated new pair cost stays below this */
    safetyMargin: number;
    /** Max total position size (in USD) per window */
    maxPositionPerWindowUsd: number;
    /** Order size per leg (in shares) */
    orderSizeShares: number;
    /** Min order size (market min) */
    orderMinSize: number;
    /** Tick size for prices (e.g. 0.01) */
    tickSize: number;
    /** Poll interval in ms (e.g. 5000) */
    pollIntervalMs: number;
    /** Seconds before window end to stop placing new orders */
    stopTradingSecondsBeforeEnd: number;
    /** Market slugs or keywords to find 15m crypto markets (e.g. ["btc", "bitcoin", "15"]) */
    marketSlugs: string[];
    /** Enable live trading (false = paper only) */
    liveTrading: boolean;
    /** Kill switch: if true, no orders are placed */
    killSwitch: boolean;
    /** Circuit breaker: pause after this many consecutive order failures */
    circuitBreakerFailures: number;
    /** Fee assumption (e.g. 0.001 = 0.1%) for P/L simulation */
    feeBips: number;
    /** Max USD to spend on a single order (one side). Prevents oversized bets. */
    maxSingleOrderUsd?: number;
    /**
     * Cap each order’s notional at this fraction of available trading balance (e.g. 0.05 = 1/20).
     * Tightened together with maxSingleOrderUsd (whichever is smaller). Requires balance passed into clip sizing.
     */
    orderSpendBalanceFraction?: number;
    /** Suppress per-tick console.log output (dashboard + file logs still active). Default: false */
    quietConsole?: boolean;
    /** When liveTrading is false, starting simulated balance in USD for paper trading (e.g. 5000). */
    paperStartingBalanceUsd?: number;
    /** Bid separation to call market "up-tilt" vs "down-tilt" (default 0.02). */
    marketTiltEpsilon?: number;
    /** When |YES−NO| share gap ≥ this, favor buying the smaller side. */
    pairTiltImbalanceShares?: number;
    /** No new orders until this many seconds elapsed in the window (warmup). */
    pairTiltMinElapsedSeconds?: number;
    /** Max shares per clip. */
    maxClipShares?: number;
    /** Size ladder (ascending); clips chosen from this set. */
    sizeLadderShares?: number[];
    /** Force opposite leg every N completed orders (two-sided book; 0 = off). */
    forcedSwitchEveryNOrders?: number;
    /**
     * If only one leg (Up or Down) is held, force-buy the opposite at the ask in the last N seconds
     * before expiry to match share counts (equal After PnL If Up / Down). Default 30.
     */
    finalOneSidedHedgeSeconds?: number;
    /** No new orders when seconds to window end are at or below this (default 2). */
    absoluteNoOrderSeconds?: number;
}

/** Current active market from Gamma API (binary YES/NO) */
export interface ActiveMarket {
    conditionId: string;
    question: string;
    slug: string;
    /** YES token ID for CLOB */
    yesTokenId: string;
    /** NO token ID for CLOB */
    noTokenId: string;
    endDateIso: string;
    gameStartTime?: string;
    acceptingOrders: boolean;
    closed: boolean;
    orderPriceMinTickSize?: number;
    orderMinSize?: number;
    negRisk?: boolean;
    /** Window length in seconds (300 or 900) — used for elapsed/taper math */
    windowDurationSec: number;
    btcMarketWindowMinutes: 5 | 15;
}

/** Per-window inventory and cost state */
export interface WindowState {
    marketSlug: string;
    conditionId: string;
    windowEndIso: string;
    /** Total shares filled on YES */
    qtyYes: number;
    /** Total shares filled on NO */
    qtyNo: number;
    /** Total cost (USD) for YES */
    costYes: number;
    /** Total cost (USD) for NO */
    costNo: number;
    /** Average price YES (costYes / qtyYes) */
    avgYes: number;
    /** Average price NO (costNo / qtyNo) */
    avgNo: number;
    /** Pair cost = avgYes + avgNo. Must be < 1.0 for profit */
    pairCost: number;
    /** Locked-in profit from MATCHED pairs only = min(qty) × (1 - pairCost). Excess shares excluded. */
    lockedProfit: number;
    /** Total USD spent this window */
    totalSpentUsd: number;
    lastUpdated: string;
}

/** Orderbook level (bid or ask) */
export interface OrderBookLevel {
    price: number;
    size: number;
}

/** Snapshot for strategy decision */
export interface OrderBookSnapshot {
    tokenId: string;
    side: 'YES' | 'NO';
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    bestBid?: number;
    bestAsk?: number;
}

/** Optional clock + fill history for decide() in demos/backtests (matches HedgeBot). */
export interface StrategyDecisionContext {
    roundsThisWindow: number;
    lastExecutedSide: 'YES' | 'NO' | null;
    secondsLeft: number;
    /** USDC available for sizing when orderSpendBalanceFraction is set (Polymarket proxy or paper cash). */
    availableBalanceUsd?: number;
}

/** Decision from strategy: what to do this tick */
export interface StrategyDecision {
    action: 'BUY_YES' | 'BUY_NO' | 'HOLD';
    tokenId: string;
    price: number;
    size: number;
    reason: string;
    /** Simulated pair cost after this fill */
    simulatedPairCost?: number;
}

/** Log entry for P/L and metrics (client: average cost, fees/slippage vs realized, net P/L by day/window) */
export interface StrategyLogEntry {
    timestamp: string;
    marketSlug: string;
    windowEndIso: string;
    pairCost: number;
    qtyYes: number;
    qtyNo: number;
    costYes: number;
    costNo: number;
    lockedProfit: number;
    totalSpentUsd: number;
    event: 'tick' | 'order_placed' | 'order_filled' | 'order_failed' | 'window_end' | 'risk_blocked';
    message?: string;
    /** Fee assumption (bips) used for P/L – "fees/slippage assumptions vs realized" */
    feeBipsAssumption?: number;
    /** Realized fees in USD when available from CLOB/trades */
    realizedFeesUsd?: number;
    /** Mark-to-market value of currently held shares at live best bids */
    positionValueUsd?: number;
    /** Cost basis of currently held shares (costYes + costNo) */
    positionCostUsd?: number;
    /** Unrealized P/L of currently held shares = positionValueUsd - positionCostUsd */
    unrealizedPnlUsd?: number;
    /** Portfolio value snapshot = total USDC balance + position value */
    portfolioValueUsd?: number;
    /** Session P/L from bot start baseline = portfolioValueUsd - baseline */
    sessionPnlUsd?: number;
}
