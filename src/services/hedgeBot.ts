/**
 * Polymarket BTC Up/Down bot — single strategy (reference-wallet logic).
 * - 5m or 15m via strategy.config.json → btcMarketWindowMinutes
 * - Maker bids; tilt + share-parity side pick;
 * - Forced leg switch every N orders; warmup then mid-window-heavy clips (duration-scaled)
 * - Once both YES and NO are held, clip size is clamped so pair cost and dual-leg settlement
 *   (After PnL If Up/Down ≥ 0) pass; first leg only is not subject to the settlement gate.
 */

import type { ClobClient } from '@polymarket/clob-client';
import type { StrategyConfig, ActiveMarket, WindowState } from '../interfaces/strategyInterfaces';
import { getActiveBtcUpDownMarket, secondsUntilWindowEnd, getLastScanReport } from './marketDiscovery';
import {
    effectiveWarmupSeconds,
    buildSizeLadderFromConfig,
    referencePickBuySide,
    referencePickClipSize,
} from './referencePairStrategy';
import {
    createEmptyWindowState,
    updateWindowStateFromFill,
    clampBuySizeForSimulatedGates,
} from './hedgeStrategy';
import {
    getBothOrderBooks,
    placeLimitBuyOrder,
    buyInstant,
    reconcilePendingOrders,
    createPendingOrder,
    type PendingOrder,
    type FillUpdate,
} from './orderManager';
import {
    createInitialRiskState,
    canPlaceOrder,
    recordOrderSuccess,
    recordOrderFailure,
    resetCircuitBreaker,
    setKillSwitch,
    type RiskState,
} from './riskManager';
import { logWindowState, logEntry } from './strategyLogger';
import { updateDashboardState, getDashboardState } from './dashboard';
import {
    getAllBalances,
    getMarketPositionShares,
    redeemPositions,
    type WalletBalances,
} from '../utils/getMyBalance';
import { ENV } from '../config/env';
import {
    resetPaperSession,
    getSimulatedBalance,
    recordOrder as recordPaperOrder,
    recordWindowEnd as recordPaperWindowEnd,
    getOrdersForWindow,
    getCompletedWindowsDetail,
} from './tradeHistory';
import { fetchResolvedWinnerSideBySlug } from './marketResolution';

export interface HedgeBotOptions {
    config: StrategyConfig;
    clobClient: ClobClient;
    onStateChange?: (windowState: WindowState, riskState: RiskState) => void;
}

const MARKET_CACHE_TTL_MS = 30_000;
const REDEEM_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const HARD_CUTOFF_SECONDS = 15;
const MAX_PENDING_ORDER_AGE_MS = 12_000;

function qlog(quiet: boolean, ...args: unknown[]): void {
    if (!quiet) console.log(...args);
}

export class HedgeBot {
    private config: StrategyConfig;
    private client: ClobClient;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private windowState: WindowState | null = null;
    private riskState: RiskState;
    private lastMarketSlug: string | null = null;
    private lastWindowEnd: string | null = null;
    private tickRunning = false;

    private cachedMarket: ActiveMarket | null = null;
    private cachedMarketTs = 0;

    // ─── Strategy execution state ────────────────────────────────────────
    private lastBuyPrice = 0;
    private activePendingOrder: PendingOrder | null = null;
    private roundsThisWindow = 0;
    private holdsThisWindow = 0;
    private lastExecutedSide: 'YES' | 'NO' | null = null;

    // ─── Balance & position tracking ─────────────────────────────────────
    private lastBalanceFetchTs = 0;
    private cachedBalances: WalletBalances = { publicWalletUsdc: 0, polymarketUsdc: 0, totalUsdc: 0 };
    private balanceLastCheckedIso = '';
    private startedAt = Date.now();
    private static readonly BALANCE_CACHE_TTL_MS = 10_000;

    private lastPositionFetchTs = 0;
    private lastPositionKey = '';
    private cachedActualPosition = { qtyYes: 0, qtyNo: 0 };
    private static readonly POSITION_CACHE_TTL_MS = 10_000;

    // ─── Live orderbook prices ───────────────────────────────────────────
    private liveBestAskYes = 0;
    private liveBestAskNo = 0;
    private liveCombinedAsk = 0;
    private liveBestBidYes = 0;
    private liveBestBidNo = 0;
    private liveCombinedBid = 0;

    private sessionStartPortfolioUsd: number | null = null;

    // ─── Completed windows ───────────────────────────────────────────────
    private completedWindows: Array<{
        slug: string;
        windowEnd: string;
        pairCost: number;
        qtyYes: number;
        qtyNo: number;
        costYes: number;
        costNo: number;
        lockedProfit: number;
        totalSpent: number;
        feeEstimate: number;
        netProfit: number;
        rounds: number;
    }> = [];

    // ─── Redemption ──────────────────────────────────────────────────────
    private redeemQueue = new Set<string>();
    private redeemSweepRunning = false;
    private redeemIntervalId: ReturnType<typeof setInterval> | null = null;
    private lastRedeemSweepIso: string | null = null;
    private lastRedeemSweepResult = 'Not run yet';

    constructor(private options: HedgeBotOptions) {
        this.config = options.config;
        this.client = options.clobClient;
        this.riskState = createInitialRiskState(options.config);
        updateDashboardState({
            running: false,
            killSwitch: this.config.killSwitch,
            message: 'Bot created; call start() to run',
            walletAddress: ENV.PUBLIC_ADDRESS,
            proxyWalletAddress: ENV.PROXY_WALLET,
            liveTrading: this.config.liveTrading,
            feeBipsAssumption: this.config.feeBips,
        });
    }

    // ─── Balance ─────────────────────────────────────────────────────────

    private async fetchBalance(): Promise<void> {
        const now = Date.now();
        if (now - this.lastBalanceFetchTs < HedgeBot.BALANCE_CACHE_TTL_MS) return;
        const MAX_RETRIES = 2;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                this.cachedBalances = await getAllBalances();
                this.lastBalanceFetchTs = Date.now();
                this.balanceLastCheckedIso = new Date().toISOString();
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_RETRIES) {
                    console.warn(`[Bot] Balance fetch attempt ${attempt} failed (retrying): ${msg}`);
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    console.error(`[Bot] Balance fetch failed after ${MAX_RETRIES} attempts: ${msg}`);
                }
            }
        }
    }

    private async fetchActualPosition(market: ActiveMarket): Promise<void> {
        const now = Date.now();
        const positionKey = `${market.yesTokenId}:${market.noTokenId}:${ENV.PROXY_WALLET}`;
        if (this.lastPositionKey === positionKey && now - this.lastPositionFetchTs < HedgeBot.POSITION_CACHE_TTL_MS) return;
        const MAX_RETRIES = 2;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const pos = await getMarketPositionShares(market.yesTokenId, market.noTokenId, ENV.PROXY_WALLET);
                this.cachedActualPosition = { qtyYes: pos.yesShares, qtyNo: pos.noShares };
                this.lastPositionFetchTs = Date.now();
                this.lastPositionKey = positionKey;
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_RETRIES) {
                    console.warn(`[Bot] Position fetch attempt ${attempt} failed (retrying): ${msg}`);
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    console.error(`[Bot] Position fetch failed after ${MAX_RETRIES} attempts: ${msg}`);
                }
            }
        }
    }

    // ─── Market cache ────────────────────────────────────────────────────

    private async getMarket(): Promise<ActiveMarket | null> {
        const now = Date.now();
        const secsLeft = this.cachedMarket ? secondsUntilWindowEnd(this.cachedMarket.endDateIso) : 0;
        const nearEnd = secsLeft > 0 && secsLeft < 90;
        const cacheValid = this.cachedMarket &&
            now - this.cachedMarketTs < MARKET_CACHE_TTL_MS &&
            !this.cachedMarket.closed &&
            this.cachedMarket.acceptingOrders &&
            secsLeft > 0;
        if (cacheValid && !nearEnd) {
            return this.cachedMarket;
        }
        let market = await getActiveBtcUpDownMarket(this.config);
        if (!market) {
            await new Promise(r => setTimeout(r, 1500));
            market = await getActiveBtcUpDownMarket(this.config);
        }
        this.cachedMarket = market;
        this.cachedMarketTs = now;
        return market;
    }

    // ─── Fill processing ─────────────────────────────────────────────────

    private applyFills(fills: FillUpdate[]): void {
        if (!this.windowState) return;
        const q = !!this.config.quietConsole;
        for (const fill of fills) {
            if (fill.newFillQty <= 0) continue;
            this.windowState = updateWindowStateFromFill(
                this.windowState, fill.side, fill.newFillQty, fill.newFillCost
            );
            this.riskState = recordOrderSuccess(this.riskState, fill.newFillCost);
            const fillPrice = fill.newFillCost / fill.newFillQty;
            const sideLabel = fill.side === 'YES' ? 'Up' : 'Down';
            qlog(q, `[FILL] ${sideLabel} +${fill.newFillQty.toFixed(0)}sh @ $${fillPrice.toFixed(4)} (${fill.orderId.slice(0, 12)}...)`);
            logWindowState(this.windowState, 'order_filled',
                `FILL ${sideLabel} +${fill.newFillQty.toFixed(0)} @ $${fillPrice.toFixed(4)} | pairCost=${this.windowState.pairCost.toFixed(4)}`,
                { feeBipsAssumption: this.config.feeBips, quietConsole: q, ...this.getAccountingSnapshot(this.windowState) }
            );
        }
    }

    /**
     * Called when a pending order completes (fully filled or cancelled).
     */
    private onOrderCompleted(order: PendingOrder, totalFilledShares: number): void {
        if (totalFilledShares > 0) {
            this.lastBuyPrice = order.price;
            this.lastExecutedSide = order.side;
            this.roundsThisWindow++;
            this.lastBalanceFetchTs = 0;
            this.lastPositionFetchTs = 0;
        }
    }

    private getSizeLadder(): number[] {
        return buildSizeLadderFromConfig(this.config);
    }

    private chooseSide(bestBidYes: number, bestBidNo: number): 'YES' | 'NO' {
        return referencePickBuySide(
            this.windowState!,
            bestBidYes,
            bestBidNo,
            this.roundsThisWindow,
            this.lastExecutedSide,
            this.config,
            { secondsLeft: secondsUntilWindowEnd(this.windowState!.windowEndIso), windowSec: this.cachedMarket?.windowDurationSec }
        );
    }

    private chooseClipSize(currentBid: number, secondsLeft: number, windowSec: number): number {
        return referencePickClipSize(
            this.windowState!,
            currentBid,
            secondsLeft,
            windowSec,
            this.config,
            this.getSizeLadder()
        );
    }

    // ─── Window summary ──────────────────────────────────────────────────

    private async logWindowEndSummary(state: WindowState): Promise<void> {
        const feeEstimate = state.totalSpentUsd * (this.config.feeBips / 10000);
        // For console summary we’ll compute realized once winner is known (paper mode) or keep estimate (live mode).
        const estNetProfit = state.lockedProfit - feeEstimate;
        let paperRealizedNet: number | null = null;

        if (!this.config.liveTrading) {
            const ordersInWindow = getOrdersForWindow(state.windowEndIso);
            // Try to fetch resolution quickly (5m markets resolve fast, but allow some lag).
            // If still unavailable, record with UNKNOWN (fallback payout = min(qtyYes, qtyNo)).
            const slug = state.marketSlug;
            const tryResolve = async (): Promise<'YES' | 'NO' | undefined> => {
                const maxAttempts = 20;
                for (let i = 0; i < maxAttempts; i++) {
                    try {
                        const w = await fetchResolvedWinnerSideBySlug(slug);
                        if (w) return w;
                    } catch {}
                    // backoff: 0.5s, 1s, 1.5s, then 2s steady
                    const ms = i < 3 ? (i + 1) * 500 : 2000;
                    await new Promise(r => setTimeout(r, ms));
                }
                return undefined;
            };
            const winnerSide = await tryResolve();
            recordPaperWindowEnd({
                windowSlug: state.marketSlug,
                windowEndIso: state.windowEndIso,
                ordersInWindow,
                totalSpentUsd: state.totalSpentUsd,
                costYes: state.costYes,
                costNo: state.costNo,
                qtyYes: state.qtyYes,
                qtyNo: state.qtyNo,
                pairCost: state.pairCost,
                lockedProfit: state.lockedProfit,
                feeEstimate,
                winnerSide,
            });

            // Use realized netProfit from paper settlement (winner payout), not lockedProfit estimate.
            const last = getCompletedWindowsDetail().slice(-1)[0];
            if (last && last.windowEndIso === state.windowEndIso) {
                paperRealizedNet = last.netProfit;
            }
        }

        this.completedWindows.push({
            slug: state.marketSlug,
            windowEnd: state.windowEndIso,
            pairCost: state.pairCost,
            qtyYes: state.qtyYes,
            qtyNo: state.qtyNo,
            costYes: state.costYes,
            costNo: state.costNo,
            lockedProfit: state.lockedProfit,
            totalSpent: state.totalSpentUsd,
            feeEstimate,
            netProfit: this.config.liveTrading ? estNetProfit : (paperRealizedNet ?? estNetProfit),
            rounds: this.roundsThisWindow,
        });
        const accounting = this.getAccountingSnapshot(state);
        logWindowState(state, 'window_end',
            `Window ended | pairCost=${state.pairCost.toFixed(4)} | locked=$${state.lockedProfit.toFixed(2)} | ` +
            `fees~$${feeEstimate.toFixed(2)} | netP/L~$${estNetProfit.toFixed(2)} | rounds=${this.roundsThisWindow} | ` +
            `YES=${state.qtyYes} NO=${state.qtyNo}`,
            { feeBipsAssumption: this.config.feeBips, quietConsole: !!this.config.quietConsole, ...accounting }
        );

        const q = !!this.config.quietConsole;
        const totalPL = this.completedWindows.reduce((s, w) => s + w.netProfit, 0);
        qlog(q, `\n===== WINDOW COMPLETE: ${state.marketSlug} =====`);
        qlog(q, `  Rounds:         ${this.roundsThisWindow}`);
        qlog(q, `  Pair cost:      ${state.pairCost.toFixed(4)}`);
        qlog(q, `  Qty YES/NO:     ${state.qtyYes} / ${state.qtyNo}`);
        qlog(q, `  Cost YES/NO:    $${state.costYes.toFixed(2)} / $${state.costNo.toFixed(2)}`);
        qlog(q, `  Total spent:    $${state.totalSpentUsd.toFixed(2)}`);
        qlog(q, `  Locked profit:  $${state.lockedProfit.toFixed(2)}`);
        qlog(q, `  Est. fees:      $${feeEstimate.toFixed(2)} (${this.config.feeBips} bips)`);
        qlog(q, `  Net P/L (est):  $${estNetProfit.toFixed(2)}`);
        qlog(q, `  Windows done:   ${this.completedWindows.length}`);
        qlog(q, `  Cumulative P/L: $${totalPL.toFixed(2)}`);
        qlog(q, `==========================================\n`);

        if (this.config.liveTrading && state.conditionId && (state.qtyYes > 0 || state.qtyNo > 0)) {
            this.redeemQueue.add(state.conditionId);
            redeemPositions(state.conditionId)
                .then((res) => { if (res.success) this.redeemQueue.delete(state.conditionId); })
                .catch(() => {});
        }
    }

    // ─── Redemption sweep ────────────────────────────────────────────────

    private async runRedeemSweep(): Promise<void> {
        if (this.redeemSweepRunning || this.redeemQueue.size === 0) return;
        this.redeemSweepRunning = true;
        let redeemed = 0, failed = 0;
        try {
            for (const conditionId of Array.from(this.redeemQueue)) {
                const res = await redeemPositions(conditionId);
                if (res.success) { this.redeemQueue.delete(conditionId); redeemed++; }
                else { failed++; }
            }
        } catch { failed++; } finally {
            this.lastRedeemSweepIso = new Date().toISOString();
            this.lastRedeemSweepResult = `redeemed=${redeemed}, failed=${failed}, remaining=${this.redeemQueue.size}`;
            this.redeemSweepRunning = false;
        }
    }

    // ─── Dashboard helpers ───────────────────────────────────────────────

    private getDashboardExtras(): Partial<import('./dashboard').DashboardState> {
        const totalPL = this.completedWindows.reduce((s, w) => s + w.netProfit, 0);
        const accounting = this.getAccountingSnapshot(this.windowState ?? undefined);
        const scan = getLastScanReport();
        const balanceUsdc = this.config.liveTrading
            ? this.cachedBalances.polymarketUsdc
            : getSimulatedBalance();
        const totalBalanceUsdc = this.config.liveTrading
            ? this.cachedBalances.totalUsdc
            : getSimulatedBalance();
        return {
            walletBalanceUsdc: this.config.liveTrading ? this.cachedBalances.publicWalletUsdc : 0,
            polymarketBalanceUsdc: balanceUsdc,
            totalBalanceUsdc,
            walletAddress: ENV.PUBLIC_ADDRESS,
            proxyWalletAddress: ENV.PROXY_WALLET,
            liveTrading: this.config.liveTrading,
            completedWindows: this.completedWindows.length,
            cumulativeProfitUsd: totalPL,
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            maxPositionPerWindowUsd: this.config.maxPositionPerWindowUsd,
            scanSlugsChecked: scan?.slugsChecked ?? [],
            scanMarketsReturned: scan?.marketsReturned ?? 0,
            scanTotalApiFetched: scan?.totalApiFetched ?? 0,
            scanActiveMarket: scan?.activeMarket ?? null,
            scanRejected: scan?.rejected ?? [],
            scanError: scan?.error ?? null,
            scanTimestamp: scan?.timestamp ?? null,
            liveBestAskYes: this.liveBestAskYes,
            liveBestAskNo: this.liveBestAskNo,
            liveCombinedAsk: this.liveCombinedAsk,
            liveBestBidYes: this.liveBestBidYes,
            liveBestBidNo: this.liveBestBidNo,
            liveCombinedBid: this.liveCombinedBid,
            livePairCostCeiling: this.config.targetPairCostMax,
            liveEffectiveMinShares: this.config.orderSizeShares,
            entryOrderYes: this.activePendingOrder?.side === 'YES'
                ? { price: this.activePendingOrder.price, size: this.activePendingOrder.sizeRequested, placedAt: this.activePendingOrder.placedAt }
                : null,
            entryOrderNo: this.activePendingOrder?.side === 'NO'
                ? { price: this.activePendingOrder.price, size: this.activePendingOrder.sizeRequested, placedAt: this.activePendingOrder.placedAt }
                : null,
            costYes: this.windowState?.costYes ?? 0,
            costNo: this.windowState?.costNo ?? 0,
            avgYes: this.windowState?.avgYes ?? 0,
            avgNo: this.windowState?.avgNo ?? 0,
            balanceLastCheckedIso: this.balanceLastCheckedIso,
            redeemQueueSize: this.redeemQueue.size,
            lastRedeemSweepIso: this.lastRedeemSweepIso,
            lastRedeemSweepResult: this.lastRedeemSweepResult,
            feeBipsAssumption: this.config.feeBips,
            positionValueUsd: accounting.positionValueUsd,
            positionCostUsd: accounting.positionCostUsd,
            unrealizedPnlUsd: accounting.unrealizedPnlUsd,
            portfolioValueUsd: accounting.portfolioValueUsd,
            sessionPnlUsd: accounting.sessionPnlUsd,
            sessionStartPortfolioUsd: accounting.sessionStartPortfolioUsd,
            trackedQtyYes: this.windowState?.qtyYes ?? 0,
            trackedQtyNo: this.windowState?.qtyNo ?? 0,
            actualQtyYes: this.cachedActualPosition.qtyYes,
            actualQtyNo: this.cachedActualPosition.qtyNo,
        };
    }

    private getAccountingSnapshot(state?: WindowState): {
        positionValueUsd: number;
        positionCostUsd: number;
        unrealizedPnlUsd: number;
        portfolioValueUsd: number;
        sessionPnlUsd: number;
        sessionStartPortfolioUsd: number;
    } {
        const qtyYes = state?.qtyYes ?? 0;
        const qtyNo = state?.qtyNo ?? 0;
        const positionCostUsd = (state?.costYes ?? 0) + (state?.costNo ?? 0);
        const positionValueUsd = (qtyYes * this.liveBestBidYes) + (qtyNo * this.liveBestBidNo);
        const unrealizedPnlUsd = positionValueUsd - positionCostUsd;
        const cashUsdc = this.config.liveTrading ? this.cachedBalances.totalUsdc : getSimulatedBalance();
        const portfolioValueUsd = cashUsdc + positionValueUsd;
        if (this.sessionStartPortfolioUsd === null && portfolioValueUsd > 0) {
            this.sessionStartPortfolioUsd = portfolioValueUsd;
        }
        const baseline = this.sessionStartPortfolioUsd ?? portfolioValueUsd;
        return {
            positionValueUsd,
            positionCostUsd,
            unrealizedPnlUsd,
            portfolioValueUsd,
            sessionPnlUsd: portfolioValueUsd - baseline,
            sessionStartPortfolioUsd: baseline,
        };
    }

    // ─── Tick wrapper ────────────────────────────────────────────────────

    private async tick(): Promise<void> {
        if (this.tickRunning) return;
        this.tickRunning = true;
        try { await this.executeTick(); }
        catch (err) { console.error('[Bot] tick error:', err); }
        finally { this.tickRunning = false; }
    }

    private async executeTick(): Promise<void> {
        const dash = getDashboardState();
        this.riskState = setKillSwitch(this.riskState, dash.killSwitch);
        const q = !!this.config.quietConsole;

        if (this.config.liveTrading) {
            await this.fetchBalance();
        } else {
            this.cachedBalances = {
                publicWalletUsdc: 0,
                polymarketUsdc: getSimulatedBalance(),
                totalUsdc: getSimulatedBalance(),
            };
            this.balanceLastCheckedIso = new Date().toISOString();
        }

        const market = await this.getMarket();
        if (!market) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: null, windowEndIso: null, pendingOrders: 0,
                message: 'No active BTC Up/Down market found (check btcMarketWindowMinutes). Retrying...',
                lastTick: new Date().toISOString(),
            });
            return;
        }

        // ── Detect new window ────────────────────────────────────────────
        const isNewWindow = this.lastMarketSlug !== market.slug || this.lastWindowEnd !== market.endDateIso;
        if (isNewWindow) {
            if (this.windowState && this.windowState.totalSpentUsd > 0) {
                await this.logWindowEndSummary(this.windowState);
            }
            if (this.config.liveTrading && this.activePendingOrder) {
                try { await this.client.cancelOrder({ orderID: this.activePendingOrder.orderId }); } catch {}
                this.activePendingOrder = null;
            }
            this.riskState = resetCircuitBreaker(this.riskState);
            this.lastMarketSlug = market.slug;
            this.lastWindowEnd = market.endDateIso;
            this.windowState = createEmptyWindowState(market.slug, market.conditionId, market.endDateIso);
            this.lastBuyPrice = 0;
            this.lastExecutedSide = null;
            this.roundsThisWindow = 0;
            this.holdsThisWindow = 0;
            this.lastBalanceFetchTs = 0;
            this.lastPositionFetchTs = 0;
            this.lastPositionKey = '';
            qlog(q, `\n>> New window: ${market.question || market.slug}`);
            qlog(q, `   End: ${market.endDateIso} | YES: ${market.yesTokenId.slice(0, 12)}... | NO: ${market.noTokenId.slice(0, 12)}...`);
        }

        if (!this.windowState) {
            this.windowState = createEmptyWindowState(market.slug, market.conditionId, market.endDateIso);
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 1: Reconcile fills from previous tick's order         ██
        // ══════════════════════════════════════════════════════════════════
        if (this.config.liveTrading && this.activePendingOrder) {
            try {
                const { fills, updatedPending } = await reconcilePendingOrders(
                    this.client, [this.activePendingOrder]
                );
                if (fills.length > 0) this.applyFills(fills);

                if (updatedPending.length > 0) {
                    this.activePendingOrder = updatedPending[0];
                } else {
                    const totalFilled = this.activePendingOrder.sizeFilled
                        + fills.reduce((s, f) => s + f.newFillQty, 0);
                    this.onOrderCompleted(this.activePendingOrder, totalFilled);
                    this.activePendingOrder = null;
                }
            } catch (err) {
                console.error('[Bot] Fill reconciliation error:', err);
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 2: Cancel unfilled order (fresh eval each tick)       ██
        // ══════════════════════════════════════════════════════════════════
        // IMPORTANT: Do NOT cancel every tick. That behavior prevents fills and
        // leads to one-sided exposure (losses). Keep orders alive briefly and
        // only cancel if stale.
        if (this.config.liveTrading && this.activePendingOrder) {
            const placedMs = Date.parse(this.activePendingOrder.placedAt);
            const ageMs = Number.isFinite(placedMs) ? Date.now() - placedMs : MAX_PENDING_ORDER_AGE_MS + 1;
            if (ageMs > MAX_PENDING_ORDER_AGE_MS) {
                try {
                    await this.client.cancelOrder({ orderID: this.activePendingOrder.orderId });
                    const { fills } = await reconcilePendingOrders(this.client, [this.activePendingOrder]);
                    if (fills.length > 0) this.applyFills(fills);
                    const totalFilled = this.activePendingOrder.sizeFilled + fills.reduce((s, f) => s + f.newFillQty, 0);
                    this.onOrderCompleted(this.activePendingOrder, totalFilled);
                } catch {}
                this.activePendingOrder = null;
            } else {
                // Let it rest; no new order this tick.
                const ws = this.windowState!;
                updateDashboardState({
                    ...this.getDashboardExtras(),
                    marketSlug: market.slug,
                    windowEndIso: market.endDateIso,
                    pairCost: ws.pairCost,
                    qtyYes: ws.qtyYes,
                    qtyNo: ws.qtyNo,
                    lockedProfit: ws.lockedProfit,
                    totalSpentUsd: ws.totalSpentUsd,
                    consecutiveFailures: this.riskState.consecutiveOrderFailures,
                    pendingOrders: 1,
                    lastTick: new Date().toISOString(),
                    message: `WAIT: pending order resting (${Math.floor(ageMs / 1000)}s old)`,
                });
                return;
            }
        }

        if (this.config.liveTrading) {
            if (this.lastBalanceFetchTs === 0) await this.fetchBalance();
            await this.fetchActualPosition(market);
        } else {
            this.cachedBalances.polymarketUsdc = getSimulatedBalance();
            this.cachedBalances.totalUsdc = getSimulatedBalance();
        }

        const state = this.windowState;
        const secondsLeft = secondsUntilWindowEnd(market.endDateIso);
        const windowSec = market.windowDurationSec;
        const elapsedSec = Math.max(0, windowSec - secondsLeft);
        const warmupSec = effectiveWarmupSeconds(this.config, windowSec);

        // ══════════════════════════════════════════════════════════════════
        // ██  Warmup: no orders until elapsed ≥ effectiveWarmupSeconds       ██
        // ══════════════════════════════════════════════════════════════════
        if (elapsedSec < warmupSec) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug,
                windowEndIso: market.endDateIso,
                pairCost: state.pairCost,
                qtyYes: state.qtyYes,
                qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit,
                totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: this.activePendingOrder ? 1 : 0,
                lastTick: new Date().toISOString(),
                message: `[${market.btcMarketWindowMinutes}m] Warmup: ${warmupSec - elapsedSec}s left (${elapsedSec}s / ${warmupSec}s)`,
            });
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 3: Stop conditions                                    ██
        // ══════════════════════════════════════════════════════════════════

        if (secondsLeft <= HARD_CUTOFF_SECONDS) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `CUTOFF: ${secondsLeft}s left — waiting for resolution`,
            });
            return;
        }

        // Soft stop: balanced, profitable, near end → stop buying and wait
        if (
            state.qtyYes === state.qtyNo &&
            state.qtyYes > 0 &&
            state.pairCost < 1.0 &&
            secondsLeft <= this.config.stopTradingSecondsBeforeEnd
        ) {
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `BALANCED: Up=${state.qtyYes} Down=${state.qtyNo} pairCost=$${state.pairCost.toFixed(4)} ` +
                    `locked=$${state.lockedProfit.toFixed(2)} — waiting for window end (${secondsLeft}s)`,
            });
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 4: Fetch orderbooks                                   ██
        // ══════════════════════════════════════════════════════════════════
        let bestBidYes = 0, bestBidNo = 0;
        try {
            const books = await getBothOrderBooks(this.client, market);
            bestBidYes = books.bookYes.bestBid ?? 0;
            bestBidNo = books.bookNo.bestBid ?? 0;
            this.liveBestBidYes = bestBidYes;
            this.liveBestBidNo = bestBidNo;
            this.liveBestAskYes = books.bookYes.bestAsk ?? 0;
            this.liveBestAskNo = books.bookNo.bestAsk ?? 0;
            this.liveCombinedBid = bestBidYes + bestBidNo;
            this.liveCombinedAsk = this.liveBestAskYes + this.liveBestAskNo;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                message: `Orderbook error: ${msg}`,
                lastTick: new Date().toISOString(),
            });
            return;
        }

        // Note: we do NOT hard-gate on (bidYES + bidNO) anymore (closer to reference wallet).

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 5: Side + clip (tilt / parity / forced switch)         ██
        // ══════════════════════════════════════════════════════════════════
        if (bestBidYes <= 0 || bestBidNo <= 0) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `HOLD: No bid liquidity (Up=$${bestBidYes.toFixed(2)} Down=$${bestBidNo.toFixed(2)})`,
            });
            return;
        }

        const side = this.chooseSide(bestBidYes, bestBidNo);
        const sideLabel = side === 'YES' ? 'Up' : 'Down';
        const currentBid = side === 'YES' ? bestBidYes : bestBidNo;
        const tokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;
        let shares = this.chooseClipSize(currentBid, secondsLeft, windowSec);
        shares = Math.max(shares, market.orderMinSize || 0);
        // Late-window parity: cap to the exact imbalance when we're re-hedging.
        const diff = Math.abs(state.qtyYes - state.qtyNo);
        if (secondsLeft <= this.config.stopTradingSecondsBeforeEnd && diff > 0) {
            shares = Math.min(shares, diff);
        }

        shares = clampBuySizeForSimulatedGates(state, side, currentBid, shares, this.config);
        if (shares <= 0) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0, lastTick: new Date().toISOString(),
                message: 'HOLD: no clip satisfies pair cost + dual-leg settlement (both After PnL ≥ 0 once hedged)',
            });
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 7: Balance, CLOB minimum, and risk checks             ██
        // ══════════════════════════════════════════════════════════════════
        const orderCost = currentBid * shares;

        if (orderCost < 1.0) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0, lastTick: new Date().toISOString(),
                message: `HOLD: order $${orderCost.toFixed(2)} < $1.00 CLOB minimum`,
            });
            return;
        }

        if (this.cachedBalances.polymarketUsdc < orderCost + 0.25) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0, lastTick: new Date().toISOString(),
                message: `HOLD: insufficient balance ($${this.cachedBalances.polymarketUsdc.toFixed(2)}) for $${orderCost.toFixed(2)} order`,
            });
            return;
        }

        const maxOrder = this.config.maxSingleOrderUsd ?? 15;
        if (orderCost > maxOrder) {
            this.holdsThisWindow++;
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0, lastTick: new Date().toISOString(),
                message: `HOLD: order $${orderCost.toFixed(2)} > cap $${maxOrder.toFixed(2)}`,
            });
            return;
        }

        const riskCheck = canPlaceOrder(this.config, this.riskState, state, orderCost);
        if (!riskCheck.allowed) {
            this.holdsThisWindow++;
            const acct = this.getAccountingSnapshot(state);
            logEntry({
                timestamp: new Date().toISOString(),
                marketSlug: state.marketSlug, windowEndIso: state.windowEndIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                costYes: state.costYes, costNo: state.costNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                event: 'risk_blocked', message: riskCheck.reason,
                feeBipsAssumption: this.config.feeBips, ...acct,
            }, !q);
            updateDashboardState({
                ...this.getDashboardExtras(),
                marketSlug: market.slug, windowEndIso: market.endDateIso,
                pairCost: state.pairCost, qtyYes: state.qtyYes, qtyNo: state.qtyNo,
                lockedProfit: state.lockedProfit, totalSpentUsd: state.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0, lastTick: new Date().toISOString(),
                message: `RISK: ${riskCheck.reason}`,
            });
            return;
        }

        // ══════════════════════════════════════════════════════════════════
        // ██  PHASE 8: Place limit buy order                              ██
        // ══════════════════════════════════════════════════════════════════
        const roundNum = this.roundsThisWindow + 1;
        const targetInfo = `round ${roundNum} | ${market.btcMarketWindowMinutes}m window`;

        qlog(q, `[Buy #${roundNum}] ${sideLabel} ${shares}sh @ $${currentBid.toFixed(2)} ($${orderCost.toFixed(2)}) | ${targetInfo}`);

        if (this.config.liveTrading) {
            const mustHedgeLate = secondsLeft <= this.config.stopTradingSecondsBeforeEnd && diff > 0;
            const ask = side === 'YES' ? this.liveBestAskYes : this.liveBestAskNo;

            const result = mustHedgeLate && ask > 0
                ? await buyInstant(this.client, tokenId, ask, shares, this.config, !!market.negRisk)
                : await placeLimitBuyOrder(this.client, tokenId, currentBid, shares, this.config, !!market.negRisk);
            if (result.success && result.orderId && result.orderId !== 'unknown') {
                this.activePendingOrder = createPendingOrder(result.orderId, tokenId, side, currentBid, shares);
                this.riskState = resetCircuitBreaker(this.riskState);
                logWindowState(state, 'order_placed',
                    `Buy #${roundNum}: ${sideLabel} ${shares}@$${currentBid.toFixed(2)} | ${targetInfo}` +
                        (mustHedgeLate ? ' | FOK(ask) hedge' : ' | limit(bid)'),
                    { feeBipsAssumption: this.config.feeBips, quietConsole: q, ...this.getAccountingSnapshot(state) }
                );
                this.lastBalanceFetchTs = 0;
                this.lastPositionFetchTs = 0;
            } else {
                this.riskState = recordOrderFailure(this.riskState);
                console.error(`[Bot] ${sideLabel} order failed: ${result.error}`);
            }
        } else {
            // Paper trading: simulate instant fill and record for history
            this.windowState = updateWindowStateFromFill(state, side, shares, orderCost);
            this.riskState = recordOrderSuccess(this.riskState, orderCost);
            this.lastBuyPrice = currentBid;
            this.lastExecutedSide = side;
            this.roundsThisWindow++;

            recordPaperOrder({
                windowSlug: market.slug,
                windowEndIso: market.endDateIso,
                side,
                price: currentBid,
                size: shares,
                costUsd: orderCost,
                roundInWindow: this.roundsThisWindow,
            });

            logWindowState(this.windowState, 'tick',
                `[PAPER] Buy #${roundNum}: ${sideLabel} ${shares}@$${currentBid.toFixed(2)} | ` +
                `pairCost=$${this.windowState.pairCost.toFixed(4)} | Up=${this.windowState.qtyYes} Down=${this.windowState.qtyNo}`,
                { feeBipsAssumption: this.config.feeBips, quietConsole: q, ...this.getAccountingSnapshot(this.windowState) }
            );
        }

        // ── Dashboard update after order ─────────────────────────────────
        const ws = this.windowState!;

        updateDashboardState({
            ...this.getDashboardExtras(),
            marketSlug: market.slug, windowEndIso: market.endDateIso,
            pairCost: ws.pairCost, qtyYes: ws.qtyYes, qtyNo: ws.qtyNo,
            lockedProfit: ws.lockedProfit, totalSpentUsd: ws.totalSpentUsd,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: this.activePendingOrder ? 1 : 0,
            lastTick: new Date().toISOString(),
            message: `Buy #${roundNum}: ${sideLabel} ${shares}@$${currentBid.toFixed(2)} ($${orderCost.toFixed(2)}) | ` +
                `${market.btcMarketWindowMinutes}m | Up=${ws.qtyYes} Down=${ws.qtyNo} pairCost=$${ws.pairCost.toFixed(4)}`,
        });
        this.options.onStateChange?.(ws, this.riskState);
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────

    start(): void {
        if (this.intervalId) return;
        this.startedAt = Date.now();
        if (!this.config.liveTrading) {
            const paperBalance = this.config.paperStartingBalanceUsd ?? 5000;
            resetPaperSession(paperBalance);
            console.log(`[Bot] Paper trading: simulated balance $${paperBalance.toFixed(2)}`);
        }
        updateDashboardState({
            running: true,
            liveTrading: this.config.liveTrading,
            message: this.config.liveTrading
                ? `Bot started — BTC ${this.config.btcMarketWindowMinutes}m pair strategy`
                : `Paper trading — $${(this.config.paperStartingBalanceUsd ?? 5000).toFixed(0)} simulated`,
        });
        console.log(`[Bot] Started (BTC ${this.config.btcMarketWindowMinutes}m). Poll: ${this.config.pollIntervalMs}ms. Live: ${this.config.liveTrading}`);
        this.tick();
        this.intervalId = setInterval(() => this.tick(), this.config.pollIntervalMs);
        this.redeemIntervalId = setInterval(
            () => this.runRedeemSweep().catch(() => {}),
            REDEEM_SWEEP_INTERVAL_MS
        );
    }

    stop(): void {
        if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
        if (this.redeemIntervalId) { clearInterval(this.redeemIntervalId); this.redeemIntervalId = null; }
        if (this.windowState && this.windowState.totalSpentUsd > 0) {
            // Fire and forget on shutdown
            void this.logWindowEndSummary(this.windowState);
        }
        updateDashboardState({ running: false, message: 'Bot stopped' });
        console.log(`[Bot] Stopped. Rounds: ${this.roundsThisWindow}. Pending: ${this.activePendingOrder ? 1 : 0}`);
    }

    getCompletedWindows() { return [...this.completedWindows]; }

    getPendingOrders(): PendingOrder[] {
        return this.activePendingOrder ? [this.activePendingOrder] : [];
    }
}
