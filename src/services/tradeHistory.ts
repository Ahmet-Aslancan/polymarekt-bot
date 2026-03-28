/**
 * Paper-trading history: records every simulated order and per-window P&L
 * for the dashboard "Trading History" page. Used when liveTrading is false.
 */

export interface RecordedOrder {
    id: string;
    timestamp: string;
    windowSlug: string;
    windowEndIso: string;
    side: 'YES' | 'NO';
    sideLabel: string;
    price: number;
    size: number;
    costUsd: number;
    roundInWindow: number;
    /** Filled in at window resolution */
    winnerSide?: 'YES' | 'NO';
    /** Per-order realized P/L at resolution (ignores fees): +size*(1-price) if winner, else -size*price */
    realizedPnlUsd?: number;
}

export interface CompletedWindowDetail {
    windowSlug: string;
    windowEndIso: string;
    windowStartedAt: string;
    windowEndedAt: string;
    orderCount: number;
    orders: RecordedOrder[];
    totalSpentUsd: number;
    costYes: number;
    costNo: number;
    qtyYes: number;
    qtyNo: number;
    pairCost: number;
    lockedProfit: number;
    feeEstimate: number;
    /** Realized net P/L including winning payout and fee estimate */
    netProfit: number;
    payoutReceived: number;
    /** Which outcome won (YES=Up, NO=Down) */
    winnerSide: 'YES' | 'NO' | 'UNKNOWN';
    /** Balance after applying payout and fees (paper mode) */
    balanceAfterUsd: number;
}

let simulatedBalanceUsd = 0;
let balanceInitialized = false;
const orders: RecordedOrder[] = [];
const completedWindowsDetail: CompletedWindowDetail[] = [];
let orderIdCounter = 0;

function nextId(): string {
    orderIdCounter += 1;
    return `paper-${Date.now()}-${orderIdCounter}`;
}

/** Initialize simulated balance (call once when bot starts in paper mode). */
export function initSimulatedBalance(startingUsd: number): void {
    if (!balanceInitialized) {
        simulatedBalanceUsd = startingUsd;
        balanceInitialized = true;
    }
}

/** Reset for a new session (e.g. when restarting bot). */
export function resetPaperSession(startingUsd: number): void {
    simulatedBalanceUsd = startingUsd;
    balanceInitialized = true;
    orders.length = 0;
    completedWindowsDetail.length = 0;
}

/** Get current simulated balance. */
export function getSimulatedBalance(): number {
    return simulatedBalanceUsd;
}

/** Record a simulated buy (paper fill). Deducts cost from balance. */
export function recordOrder(params: {
    windowSlug: string;
    windowEndIso: string;
    side: 'YES' | 'NO';
    price: number;
    size: number;
    costUsd: number;
    roundInWindow: number;
}): void {
    const order: RecordedOrder = {
        id: nextId(),
        timestamp: new Date().toISOString(),
        windowSlug: params.windowSlug,
        windowEndIso: params.windowEndIso,
        side: params.side,
        sideLabel: params.side === 'YES' ? 'Up' : 'Down',
        price: params.price,
        size: params.size,
        costUsd: params.costUsd,
        roundInWindow: params.roundInWindow,
    };
    orders.push(order);
    simulatedBalanceUsd -= params.costUsd;
}

/**
 * Record window end: P&L and payout. Adds the redeemed amount to simulated balance.
 * At resolution we receive $1 per winning share (YES or NO).
 */
export function recordWindowEnd(params: {
    windowSlug: string;
    windowEndIso: string;
    ordersInWindow: RecordedOrder[];
    totalSpentUsd: number;
    costYes: number;
    costNo: number;
    qtyYes: number;
    qtyNo: number;
    pairCost: number;
    lockedProfit: number;
    feeEstimate: number;
    /** Winner side; if unknown, uses matched-pairs payout as conservative fallback */
    winnerSide?: 'YES' | 'NO';
}): void {
    const winnerSide = params.winnerSide ?? 'UNKNOWN';
    const payoutReceived =
        winnerSide === 'YES' ? params.qtyYes :
        winnerSide === 'NO' ? params.qtyNo :
        Math.min(params.qtyYes, params.qtyNo);

    // Fees are modeled as paid at settlement (simple, consistent accounting)
    const realizedNet = payoutReceived - params.totalSpentUsd - params.feeEstimate;

    simulatedBalanceUsd += payoutReceived;
    simulatedBalanceUsd -= params.feeEstimate;

    // Backfill per-order realized P/L (no fees) for UI clarity
    const resolvedOrders = params.ordersInWindow.map(o => {
        const win = winnerSide === 'UNKNOWN' ? undefined : winnerSide;
        const pnl = win
            ? (o.side === win ? (o.size * (1 - o.price)) : (-o.size * o.price))
            : undefined;
        return { ...o, winnerSide: win, realizedPnlUsd: pnl };
    });

    const windowOrders = params.ordersInWindow;
    const startedAt = windowOrders.length > 0
        ? windowOrders[0].timestamp
        : new Date().toISOString();

    completedWindowsDetail.push({
        windowSlug: params.windowSlug,
        windowEndIso: params.windowEndIso,
        windowStartedAt: startedAt,
        windowEndedAt: new Date().toISOString(),
        orderCount: resolvedOrders.length,
        orders: resolvedOrders,
        totalSpentUsd: params.totalSpentUsd,
        costYes: params.costYes,
        costNo: params.costNo,
        qtyYes: params.qtyYes,
        qtyNo: params.qtyNo,
        pairCost: params.pairCost,
        lockedProfit: params.lockedProfit,
        feeEstimate: params.feeEstimate,
        netProfit: realizedNet,
        payoutReceived,
        winnerSide,
        balanceAfterUsd: simulatedBalanceUsd,
    });
}

/** All recorded orders (chronological). */
export function getRecordedOrders(): RecordedOrder[] {
    return [...orders];
}

/** All completed windows with orders and P&L. */
export function getCompletedWindowsDetail(): CompletedWindowDetail[] {
    return [...completedWindowsDetail];
}

/** Orders for a given window (by windowEndIso). */
export function getOrdersForWindow(windowEndIso: string): RecordedOrder[] {
    return orders.filter(o => o.windowEndIso === windowEndIso);
}

/** Cumulative P&L over last N milliseconds (e.g. 24h). */
export function getCumulativePnLSinceMs(ms: number): { netProfit: number; windows: number } {
    const since = Date.now() - ms;
    let net = 0;
    let count = 0;
    for (const w of completedWindowsDetail) {
        const ended = new Date(w.windowEndedAt).getTime();
        if (ended >= since) {
            net += w.netProfit;
            count += 1;
        }
    }
    return { netProfit: net, windows: count };
}

/** Summary for last 24 hours. */
export function getLast24hSummary(): {
    netProfit: number;
    windowsCount: number;
    ordersCount: number;
    totalSpent: number;
    totalPayout: number;
} {
    const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
    const since = Date.now() - TWENTY_FOUR_H;
    let netProfit = 0;
    let windowsCount = 0;
    let totalSpent = 0;
    let totalPayout = 0;
    const orderIds = new Set<string>();
    for (const w of completedWindowsDetail) {
        const ended = new Date(w.windowEndedAt).getTime();
        if (ended >= since) {
            netProfit += w.netProfit;
            windowsCount += 1;
            totalSpent += w.totalSpentUsd;
            totalPayout += w.payoutReceived;
            w.orders.forEach(o => orderIds.add(o.id));
        }
    }
    return {
        netProfit,
        windowsCount,
        ordersCount: orderIds.size,
        totalSpent,
        totalPayout,
    };
}
