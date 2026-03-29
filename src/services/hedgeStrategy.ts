/**
 * Hedge strategy: maintain pair cost (avg_YES + avg_NO) < target (e.g. $0.99).
 * Only place orders that keep simulated pair cost below threshold; balance inventory.
 *
 * Key formulas (from CoinsBench article):
 *   avg_YES = Cost_YES / Qty_YES
 *   avg_NO  = Cost_NO  / Qty_NO
 *   Pair Cost = avg_YES + avg_NO        (must be < 1.00)
 *   Locked Profit = min(Qty_YES, Qty_NO) × (1 - avg_YES - avg_NO)   [matched pairs only]
 */

import type {
    StrategyConfig,
    WindowState,
    OrderBookSnapshot,
    StrategyDecision,
    OrderBookLevel,
    StrategyDecisionContext,
} from '../interfaces/strategyInterfaces';
import { btcWindowDurationSec } from './marketDiscovery';
import {
    effectiveWarmupSeconds,
    buildSizeLadderFromConfig,
    referencePickBuySide,
    referencePickClipSize,
    defaultSecondsLeftForDemo,
} from './referencePairStrategy';

export function createEmptyWindowState(marketSlug: string, conditionId: string, windowEndIso: string): WindowState {
    return {
        marketSlug,
        conditionId,
        windowEndIso,
        qtyYes: 0,
        qtyNo: 0,
        costYes: 0,
        costNo: 0,
        avgYes: 0,
        avgNo: 0,
        pairCost: 0,
        lockedProfit: 0,
        totalSpentUsd: 0,
        lastUpdated: new Date().toISOString(),
    };
}

/**
 * Recompute avg prices, pair cost, locked profit, and total spent from qty + cost.
 */
export function recomputeWindowDerivedFields(state: WindowState): WindowState {
    const newState = { ...state };
    newState.avgYes = newState.qtyYes > 0 ? newState.costYes / newState.qtyYes : 0;
    newState.avgNo = newState.qtyNo > 0 ? newState.costNo / newState.qtyNo : 0;
    if (newState.qtyYes > 0 && newState.qtyNo > 0) {
        newState.pairCost = newState.avgYes + newState.avgNo;
    } else if (newState.qtyYes > 0) {
        newState.pairCost = newState.avgYes;
    } else if (newState.qtyNo > 0) {
        newState.pairCost = newState.avgNo;
    } else {
        newState.pairCost = 0;
    }
    newState.totalSpentUsd = newState.costYes + newState.costNo;
    const minQty = Math.min(newState.qtyYes, newState.qtyNo);
    if (minQty > 0 && newState.avgYes > 0 && newState.avgNo > 0) {
        const matchedCost = minQty * newState.avgYes + minQty * newState.avgNo;
        newState.lockedProfit = minQty - matchedCost;
    } else {
        newState.lockedProfit = 0;
    }
    newState.lastUpdated = new Date().toISOString();
    return newState;
}

/** Min share delta to treat on-chain vs tracked as different (RPC + float noise). */
export const CHAIN_QTY_SYNC_EPS = 0.05;

export interface ChainSyncPriceHints {
    bestBidYes: number;
    bestBidNo: number;
}

/**
 * Align window inventory with on-chain conditional token balances (source of truth in live mode).
 * - Lower qty than tracked: scale cost proportionally (order never filled or over-counted).
 * - Higher qty than tracked: treat extra shares as bought at best-bid hint (or prior avg, else 0.5).
 */
export function syncWindowStateWithChain(
    state: WindowState,
    chainYesRaw: number,
    chainNoRaw: number,
    hints: ChainSyncPriceHints
): { state: WindowState; adjusted: boolean } {
    const chainYes = Math.max(0, chainYesRaw);
    const chainNo = Math.max(0, chainNoRaw);
    const py = hints.bestBidYes > 0 ? hints.bestBidYes : (state.avgYes > 0 ? state.avgYes : 0.5);
    const pn = hints.bestBidNo > 0 ? hints.bestBidNo : (state.avgNo > 0 ? state.avgNo : 0.5);

    let adjusted = false;
    let s = { ...state };

    if (chainYes < s.qtyYes - CHAIN_QTY_SYNC_EPS) {
        const ratio = s.qtyYes > 0 ? chainYes / s.qtyYes : 0;
        s.qtyYes = chainYes;
        s.costYes = s.costYes * ratio;
        adjusted = true;
    } else if (chainYes > s.qtyYes + CHAIN_QTY_SYNC_EPS) {
        const d = chainYes - s.qtyYes;
        s.qtyYes = chainYes;
        s.costYes = s.costYes + d * py;
        adjusted = true;
    }

    if (chainNo < s.qtyNo - CHAIN_QTY_SYNC_EPS) {
        const ratio = s.qtyNo > 0 ? chainNo / s.qtyNo : 0;
        s.qtyNo = chainNo;
        s.costNo = s.costNo * ratio;
        adjusted = true;
    } else if (chainNo > s.qtyNo + CHAIN_QTY_SYNC_EPS) {
        const d = chainNo - s.qtyNo;
        s.qtyNo = chainNo;
        s.costNo = s.costNo + d * pn;
        adjusted = true;
    }

    s = recomputeWindowDerivedFields(s);
    return { state: s, adjusted };
}

export function updateWindowStateFromFill(
    state: WindowState,
    side: 'YES' | 'NO',
    addedQty: number,
    addedCost: number
): WindowState {
    const newState = { ...state };
    if (side === 'YES') {
        newState.qtyYes = state.qtyYes + addedQty;
        newState.costYes = state.costYes + addedCost;
    } else {
        newState.qtyNo = state.qtyNo + addedQty;
        newState.costNo = state.costNo + addedCost;
    }
    return recomputeWindowDerivedFields(newState);
}

/**
 * Update window state after SELLING shares back (emergency exit / rebalance).
 * Reduces position on the given side. Cost is reduced proportionally at average cost.
 * The difference between average cost and sale price is the realized spread loss.
 */
export function updateWindowStateFromSell(
    state: WindowState,
    side: 'YES' | 'NO',
    soldQty: number,
    _saleProceeds: number
): WindowState {
    const newState = { ...state };
    if (side === 'YES') {
        const avgCostPerShare = state.qtyYes > 0 ? state.costYes / state.qtyYes : 0;
        newState.qtyYes = Math.max(0, state.qtyYes - soldQty);
        newState.costYes = newState.qtyYes > 0 ? newState.qtyYes * avgCostPerShare : 0;
    } else {
        const avgCostPerShare = state.qtyNo > 0 ? state.costNo / state.qtyNo : 0;
        newState.qtyNo = Math.max(0, state.qtyNo - soldQty);
        newState.costNo = newState.qtyNo > 0 ? newState.qtyNo * avgCostPerShare : 0;
    }
    return recomputeWindowDerivedFields(newState);
}

const SETTLEMENT_PNL_EPS = 1e-6;

/**
 * After a fill, dashboard "After PnL If Up/Down" are qtyYes/No − totalSpentUsd.
 * When only one leg is held (first leg of a two-leg step), we do not enforce this gate.
 * Once both legs are non-zero, require both settlement P/L ≥ 0 so each outcome covers total spend.
 */
export function violatesDualLegSettlementGate(s: WindowState): boolean {
    if (s.qtyYes <= 0 || s.qtyNo <= 0) return false;
    return (
        s.qtyYes + SETTLEMENT_PNL_EPS < s.totalSpentUsd ||
        s.qtyNo + SETTLEMENT_PNL_EPS < s.totalSpentUsd
    );
}

/**
 * Largest integer size in [minSize, initialSize] that passes simulated pair-cost ceiling
 * (when both sides > 0 after fill) and dual-leg settlement (when both sides > 0).
 * Skips settlement + strict pair-cost checks while still one-sided (first leg only).
 * When bypassPairCostAndSettlement (forced opposite leg / survival hedge), only enforces CLOB $1 minimum —
 * pair cost and settlement P/L gates are ignored so the hedge can complete even at a loss vs full wipeout.
 */
export function clampBuySizeForSimulatedGates(
    state: WindowState,
    side: 'YES' | 'NO',
    price: number,
    initialSize: number,
    config: StrategyConfig,
    opts?: { bypassPairCostAndSettlement?: boolean }
): number {
    const minSize = Math.max(1, Math.floor(config.orderMinSize || 1));
    const CLOB_MIN_ORDER_USD = 1.0;
    let s = Math.floor(initialSize);

    if (opts?.bypassPairCostAndSettlement) {
        while (s >= minSize) {
            if (price * s >= CLOB_MIN_ORDER_USD) return s;
            s--;
        }
        return 0;
    }

    const pairCostCeiling = Math.min(config.safetyMargin, config.targetPairCostMax);
    while (s >= minSize) {
        if (price * s < CLOB_MIN_ORDER_USD) {
            s--;
            continue;
        }
        const addedCost = s * price;
        const newState = updateWindowStateFromFill(state, side, s, addedCost);
        const both = newState.qtyYes > 0 && newState.qtyNo > 0;
        if (!both) return s;
        if (newState.pairCost > pairCostCeiling || newState.pairCost >= 1.0) {
            s--;
            continue;
        }
        if (violatesDualLegSettlementGate(newState)) {
            s--;
            continue;
        }
        return s;
    }
    return 0;
}

/** Simulate state after buying deltaQty at price on side */
function simulateState(
    state: WindowState,
    side: 'YES' | 'NO',
    deltaQty: number,
    price: number
): { newPairCost: number; newState: WindowState } {
    const addedCost = deltaQty * price;
    const newState = updateWindowStateFromFill(state, side, deltaQty, addedCost);
    return { newPairCost: newState.pairCost, newState };
}

/** Round price to tick size */
function roundToTick(price: number, tickSize: number): number {
    if (tickSize <= 0) return price;
    return Math.round(price / tickSize) * tickSize;
}

const QTY_EPS = 1e-8;

/**
 * Only in the last N seconds before the window ends (see finalOneSidedHedgeSeconds): if the book is
 * strictly one-sided, propose buying the opposite leg at the best ask (FOK/taker) to match share count.
 * Pair-cost / settlement profit gates are bypassed here only — survival vs total loss on wrong resolution.
 * Outside that window, returns null (normal reference strategy applies).
 */
export function buildFinalOneSidedHedgeDecision(
    config: StrategyConfig,
    state: WindowState,
    bookYes: OrderBookSnapshot,
    bookNo: OrderBookSnapshot,
    secondsLeft: number
): StrategyDecision | null {
    const absCut = config.absoluteNoOrderSeconds ?? 2;
    const finalSec = config.finalOneSidedHedgeSeconds ?? 30;
    if (secondsLeft <= absCut || secondsLeft > finalSec) return null;

    const yesOnly = state.qtyYes > QTY_EPS && state.qtyNo <= QTY_EPS;
    const noOnly = state.qtyNo > QTY_EPS && state.qtyYes <= QTY_EPS;
    if (!yesOnly && !noOnly) return null;
    if (state.totalSpentUsd <= 0) return null;

    const side: 'YES' | 'NO' = yesOnly ? 'NO' : 'YES';
    const sharesTarget = Math.floor(yesOnly ? state.qtyYes : state.qtyNo);
    if (sharesTarget < 1) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason: 'Final hedge: filled leg < 1 share',
        };
    }

    const tickSize = config.tickSize || 0.01;
    const bestAskLevel = side === 'YES' ? bookYes.asks?.[0] : bookNo.asks?.[0];
    if (!bestAskLevel || bestAskLevel.price <= 0) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason: 'Final hedge: no ask on opposite leg',
        };
    }
    const price = roundToTick(bestAskLevel.price, tickSize);

    let size = sharesTarget;
    if (config.maxSingleOrderUsd && price > 0) {
        size = Math.min(size, Math.floor(config.maxSingleOrderUsd / price));
    }
    size = clampBuySizeForSimulatedGates(state, side, price, size, config, {
        bypassPairCostAndSettlement: true,
    });
    const CLOB_MIN_ORDER_USD = 1.0;
    if (size <= 0 || price * size < CLOB_MIN_ORDER_USD) {
        return {
            action: 'HOLD',
            tokenId: '',
            price: 0,
            size: 0,
            reason: 'Final hedge: no size meets $1 CLOB min (pair cost ignored)',
        };
    }

    const tokenId = side === 'YES' ? bookYes.tokenId : bookNo.tokenId;
    const { newPairCost } = simulateState(state, side, size, price);
    return {
        action: side === 'YES' ? 'BUY_YES' : 'BUY_NO',
        tokenId,
        price,
        size,
        reason: `Final survival hedge: ${size} ${side} @ ask (pair cost ignored, ${secondsLeft}s left) pairCost→${newPairCost.toFixed(4)}`,
        simulatedPairCost: newPairCost,
    };
}

/**
 * Decide next action: BUY_YES, BUY_NO, or HOLD — same reference logic as HedgeBot.
 * Maker @ best bid; tilt + parity + forced switch; clip ladder.
 */
export function decide(
    config: StrategyConfig,
    state: WindowState,
    bookYes: OrderBookSnapshot,
    bookNo: OrderBookSnapshot,
    excludeSide?: 'YES' | 'NO',
    ctx?: StrategyDecisionContext
): StrategyDecision {
    const tickSize = config.tickSize || 0.01;
    const CLOB_MIN_ORDER_USD = 1.0;

    const bestBidYes = bookYes.bids && bookYes.bids.length > 0 ? bookYes.bids[0] : undefined;
    const bestBidNo = bookNo.bids && bookNo.bids.length > 0 ? bookNo.bids[0] : undefined;
    const bestAskYes = bookYes.asks && bookYes.asks.length > 0 ? bookYes.asks[0] : undefined;
    const bestAskNo = bookNo.asks && bookNo.asks.length > 0 ? bookNo.asks[0] : undefined;

    if (!bestBidYes || !bestBidNo) {
        return {
            action: 'HOLD', tokenId: '', price: 0, size: 0,
            reason: `No bid liquidity. YES bid: ${bestBidYes ? '$' + bestBidYes.price.toFixed(2) : 'none'}, ` +
                    `NO bid: ${bestBidNo ? '$' + bestBidNo.price.toFixed(2) : 'none'}`,
        };
    }

    if (!bestAskYes || !bestAskNo) {
        return {
            action: 'HOLD', tokenId: '', price: 0, size: 0,
            reason: `No ask liquidity (market inactive). YES ask: ${bestAskYes ? '$' + bestAskYes.price.toFixed(2) : 'none'}, ` +
                    `NO ask: ${bestAskNo ? '$' + bestAskNo.price.toFixed(2) : 'none'}`,
        };
    }

    if (state.qtyYes > 0 && state.qtyNo > 0 && state.pairCost >= 1.0) {
        return { action: 'HOLD', tokenId: '', price: 0, size: 0, reason: 'Pair cost already >= 1.00 — hedge locked' };
    }

    const yesBidPrice = roundToTick(bestBidYes.price, tickSize);
    const noBidPrice = roundToTick(bestBidNo.price, tickSize);
    const yesAskPrice = roundToTick(bestAskYes.price, tickSize);
    const noAskPrice = roundToTick(bestAskNo.price, tickSize);

    if (yesBidPrice >= yesAskPrice || noBidPrice >= noAskPrice) {
        return {
            action: 'HOLD', tokenId: '', price: 0, size: 0,
            reason: `Crossed book: YES bid=$${yesBidPrice.toFixed(2)} ask=$${yesAskPrice.toFixed(2)}, ` +
                    `NO bid=$${noBidPrice.toFixed(2)} ask=$${noAskPrice.toFixed(2)}`,
        };
    }

    // Note: no hard gate on (yesBid + noBid); reference wallet traded in both regimes.
    const combined = yesBidPrice + noBidPrice;

    const windowSec = btcWindowDurationSec(config);
    const secondsLeft = ctx?.secondsLeft ?? defaultSecondsLeftForDemo(config);
    const elapsed = Math.max(0, windowSec - secondsLeft);
    if (elapsed < effectiveWarmupSeconds(config, windowSec)) {
        const w = effectiveWarmupSeconds(config, windowSec);
        return {
            action: 'HOLD', tokenId: '', price: 0, size: 0,
            reason: `Warmup: elapsed ${elapsed}s < ${w}s`,
        };
    }

    const finalHedge = buildFinalOneSidedHedgeDecision(config, state, bookYes, bookNo, secondsLeft);
    if (finalHedge !== null) return finalHedge;

    const rounds = ctx?.roundsThisWindow ?? 0;
    const lastSide = ctx?.lastExecutedSide ?? null;
    let side = referencePickBuySide(
        state,
        yesBidPrice,
        noBidPrice,
        rounds,
        lastSide,
        config,
        { secondsLeft, windowSec }
    );
    if (excludeSide === side) {
        side = side === 'YES' ? 'NO' : 'YES';
    }

    const price = side === 'YES' ? yesBidPrice : noBidPrice;
    const tokenId = side === 'YES' ? bookYes.tokenId : bookNo.tokenId;
    const ladder = buildSizeLadderFromConfig(config);
    let size = referencePickClipSize(state, price, secondsLeft, windowSec, config, ladder, {
        availableBalanceUsd: ctx?.availableBalanceUsd,
    });
    size = Math.max(size, config.orderMinSize || 1);

    // Late-window parity: don't overshoot the hedge leg when we're just trying to balance.
    const diff = Math.abs(state.qtyYes - state.qtyNo);
    if (secondsLeft <= config.stopTradingSecondsBeforeEnd && diff > 0) {
        size = Math.min(size, diff);
    }

    size = clampBuySizeForSimulatedGates(state, side, price, size, config);

    if (size <= 0 || price * size < CLOB_MIN_ORDER_USD) {
        return {
            action: 'HOLD', tokenId: '', price: 0, size: 0,
            reason: size <= 0
                ? 'No clip size satisfies pair cost and dual-leg settlement (both After PnL ≥ 0 once hedged)'
                : `Clip size ${size} @ $${price.toFixed(4)} below CLOB $1`,
        };
    }

    const { newPairCost } = simulateState(state, side, size, price);

    return {
        action: side === 'YES' ? 'BUY_YES' : 'BUY_NO',
        tokenId,
        price,
        size,
        reason: `REFERENCE ${side} ${size}@$${price.toFixed(4)} pairCost→$${newPairCost.toFixed(4)} sum=$${combined.toFixed(4)}`,
        simulatedPairCost: newPairCost,
    };
}

/**
 * Build orderbook snapshot from CLOB orderbook response (bids/asks arrays with price, size).
 */
export function orderBookFromClob(
    tokenId: string,
    side: 'YES' | 'NO',
    bids: Array<{ price: string | number; size: string | number }>,
    asks: Array<{ price: string | number; size: string | number }>
): OrderBookSnapshot {
    const toLevel = (p: { price: string | number; size: string | number }): OrderBookLevel => ({
        price: typeof p.price === 'string' ? parseFloat(p.price) : p.price,
        size: typeof p.size === 'string' ? parseFloat(p.size) : p.size,
    });
    const bidLevels = (bids || []).map(toLevel).filter((l) => l.price > 0 && l.size > 0);
    const askLevels = (asks || []).map(toLevel).filter((l) => l.price > 0 && l.size > 0);
    // Sort: bids descending, asks ascending
    bidLevels.sort((a, b) => b.price - a.price);
    askLevels.sort((a, b) => a.price - b.price);
    return {
        tokenId,
        side,
        bids: bidLevels,
        asks: askLevels,
        bestBid: bidLevels.length > 0 ? bidLevels[0].price : undefined,
        bestAsk: askLevels.length > 0 ? askLevels[0].price : undefined,
    };
}
