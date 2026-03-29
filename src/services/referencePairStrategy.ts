/**
 * Reference-wallet pair strategy (5m / 15m): single source of truth for side + clip sizing.
 * Used by HedgeBot and by hedgeStrategy.decide for demos/backtests.
 */

import type { StrategyConfig, WindowState } from '../interfaces/strategyInterfaces';
import { btcWindowDurationSec } from './marketDiscovery';

export function effectiveWarmupSeconds(config: StrategyConfig, windowSec: number): number {
    const raw = config.pairTiltMinElapsedSeconds ?? 45;
    const cap = Math.max(8, Math.floor(windowSec * 0.35));
    return Math.min(raw, cap);
}

/** Ascending clip ladder from config. */
export function buildSizeLadderFromConfig(config: StrategyConfig): number[] {
    const configured = (config.sizeLadderShares || [])
        .map((v) => Math.max(0, Math.floor(v)))
        .filter((v) => v > 0);
    const fallback = [2, 8, 20, 35, Math.floor(config.maxClipShares ?? 54)];
    const base = (configured.length > 0 ? configured : fallback).sort((a, b) => a - b);
    const unique: number[] = [];
    for (const s of base) if (unique.length === 0 || unique[unique.length - 1] !== s) unique.push(s);
    return unique;
}

export function referencePickBuySide(
    state: WindowState,
    bestBidYes: number,
    bestBidNo: number,
    roundsThisWindow: number,
    lastExecutedSide: 'YES' | 'NO' | null,
    config: StrategyConfig,
    ctx?: { secondsLeft?: number; windowSec?: number }
): 'YES' | 'NO' {
    const eps = config.marketTiltEpsilon ?? 0.02;
    const imbTh = config.pairTiltImbalanceShares ?? 10;
    const G = state.qtyYes - state.qtyNo;
    let side: 'YES' | 'NO';

    // End-of-window behavior in the reference wallet data:
    // intervals finish holding BOTH sides (no one-sided leftovers).
    // So late in the window we prioritize rebalancing to parity over tilt.
    const secondsLeft = ctx?.secondsLeft;
    const windowSec = ctx?.windowSec;
    if (
        typeof secondsLeft === 'number' &&
        typeof windowSec === 'number' &&
        secondsLeft <= Math.max(15, Math.min(config.stopTradingSecondsBeforeEnd ?? 120, Math.floor(windowSec * 0.5))) &&
        state.qtyYes !== state.qtyNo
    ) {
        return G < 0 ? 'YES' : 'NO';
    }

    if (Math.abs(G) >= imbTh) {
        side = G < 0 ? 'YES' : 'NO';
    } else {
        const upTilt = bestBidYes > bestBidNo + eps;
        const downTilt = bestBidNo > bestBidYes + eps;
        if (upTilt && !downTilt) side = 'YES';
        else if (downTilt && !upTilt) side = 'NO';
        else side = bestBidYes <= bestBidNo ? 'YES' : 'NO';
    }

    const switchEvery = config.forcedSwitchEveryNOrders ?? 4;
    if (
        switchEvery > 0 &&
        roundsThisWindow > 0 &&
        roundsThisWindow % switchEvery === 0 &&
        lastExecutedSide
    ) {
        side = lastExecutedSide === 'YES' ? 'NO' : 'YES';
    }
    return side;
}

export function referencePickClipSize(
    state: WindowState,
    currentBid: number,
    secondsLeft: number,
    windowSec: number,
    config: StrategyConfig,
    ladder: number[],
    opts?: { availableBalanceUsd?: number }
): number {
    const maxClip = Math.max(1, Math.floor(config.maxClipShares ?? 54));
    const remainingBudget = Math.max(0, config.maxPositionPerWindowUsd - state.totalSpentUsd);
    const maxByBudget = currentBid > 0 ? Math.floor(remainingBudget / currentBid) : 0;

    let shareCapFromUsd: number | null = null;
    if (currentBid > 0 && config.maxSingleOrderUsd != null && config.maxSingleOrderUsd > 0) {
        shareCapFromUsd = Math.floor(config.maxSingleOrderUsd / currentBid);
    }
    const bal = opts?.availableBalanceUsd;
    const frac = config.orderSpendBalanceFraction;
    if (
        currentBid > 0 &&
        bal != null &&
        bal > 0 &&
        frac != null &&
        frac > 0
    ) {
        const fromBal = Math.floor((bal * frac) / currentBid);
        shareCapFromUsd = shareCapFromUsd != null ? Math.min(shareCapFromUsd, fromBal) : fromBal;
    }
    const maxBySingleOrder = shareCapFromUsd != null ? shareCapFromUsd : maxClip;

    const hardCap = Math.max(0, Math.min(maxClip, maxByBudget, maxBySingleOrder));
    if (hardCap <= 0) return 0;

    const elapsed = Math.max(0, windowSec - secondsLeft);
    const warmup = effectiveWarmupSeconds(config, windowSec);
    // Bias toward large clips (wallet frequently used ~54-share clips),
    // taper only near the end of the window.
    const rampEnd = warmup + Math.floor(windowSec * 0.15);
    const tailSec = Math.max(20, Math.floor(windowSec * 0.25));
    const big = ladder[Math.max(0, ladder.length - 1)] ?? maxClip;
    const small = ladder[0] ?? 5;
    const mid = ladder[Math.floor(Math.max(0, ladder.length - 1) / 2)] ?? Math.floor((small + big) / 2);

    let pick: number;
    if (elapsed < rampEnd) pick = mid;
    else if (secondsLeft > tailSec) pick = big;
    else pick = Math.max(small, Math.floor(big * 0.65));

    let shares = Math.min(hardCap, pick);
    if (currentBid > 0 && shares * currentBid < 1.0) {
        shares = Math.max(shares, Math.ceil(1.0 / currentBid));
    }
    return Math.min(shares, hardCap);
}

/** Default timing when demos do not pass a live clock (mid-window). */
export function defaultSecondsLeftForDemo(config: StrategyConfig): number {
    return Math.floor(btcWindowDurationSec(config) / 2);
}
