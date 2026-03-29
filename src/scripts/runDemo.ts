/**
 * Demo mode: runs the full bot loop with simulated orderbooks and no external dependencies.
 * No wallet, MongoDB, or API keys required.
 *
 * This demonstrates the complete bot lifecycle:
 *   - Market discovery (simulated 15-minute windows)
 *   - Strategy decisions (pair cost < $1.00)
 *   - Order placement (paper fills)
 *   - Risk controls (max position, daily spend, circuit breaker)
 *   - Logging (CSV/JSON to ./logs)
 *   - Dashboard (http://localhost:3750)
 *   - P/L tracking and window summaries
 *
 * Run: npx ts-node src/scripts/runDemo.ts
 */

import { loadStrategyConfig } from '../config/strategyConfig';
import { startDashboard } from '../services/dashboard';
import {
    createEmptyWindowState,
    updateWindowStateFromFill,
    decide,
    orderBookFromClob,
} from '../services/hedgeStrategy';
import {
    createInitialRiskState,
    canPlaceOrder,
    recordOrderSuccess,
    setKillSwitch,
    type RiskState,
} from '../services/riskManager';
import { logWindowState } from '../services/strategyLogger';
import { updateDashboardState, getDashboardState } from '../services/dashboard';
import { initSimulatedBalance, recordOrder } from '../services/tradeHistory';
import type { StrategyConfig, WindowState } from '../interfaces/strategyInterfaces';
import { btcWindowDurationSec } from '../services/marketDiscovery';

// ─── Simulated market generator ──────────────────────────────────────────

let windowCounter = 0;

function createSimulatedWindow(cfg: StrategyConfig) {
    windowCounter++;
    const now = Date.now();
    const sec = btcWindowDurationSec(cfg);
    const endTime = now + sec * 1000;
    return {
        slug: `btc-${cfg.btcMarketWindowMinutes}m-demo-${windowCounter}`,
        conditionId: `0xdemo${windowCounter}`,
        endDateIso: new Date(endTime).toISOString(),
        windowNum: windowCounter,
    };
}

function generateSimulatedBooks(tickNum: number) {
    const swing1 = Math.sin(tickNum * 0.8) * 0.15;
    const swing2 = Math.sin(tickNum * 1.7 + 1.2) * 0.07;
    const noise = (Math.random() - 0.5) * 0.04;
    const yesPrice = Math.max(0.10, Math.min(0.90, 0.50 + swing1 + swing2 + noise));
    const spread = 0.01 + Math.random() * 0.03;
    const noPrice = Math.max(0.10, Math.min(0.90, 1.0 - yesPrice + spread * (Math.random() > 0.5 ? 1 : -1)));

    const yesAsk = Math.round(yesPrice * 100) / 100;
    const noAsk = Math.round(noPrice * 100) / 100;
    const yesLiq = 20 + Math.floor(Math.random() * 80);
    const noLiq = 20 + Math.floor(Math.random() * 80);

    const bookYes = orderBookFromClob('demo-yes-token', 'YES',
        [{ price: yesAsk - 0.01, size: yesLiq }],
        [{ price: yesAsk, size: yesLiq }]
    );
    const bookNo = orderBookFromClob('demo-no-token', 'NO',
        [{ price: noAsk - 0.01, size: noLiq }],
        [{ price: noAsk, size: noLiq }]
    );
    return { bookYes, bookNo };
}

// ─── Demo bot ────────────────────────────────────────────────────────────

class DemoBot {
    private config: StrategyConfig;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private windowState: WindowState | null = null;
    private riskState: RiskState;
    private currentWindow: ReturnType<typeof createSimulatedWindow> | null = null;
    private tickNum = 0;
    private completedWindows = 0;
    private totalProfit = 0;
    private demoRoundsThisWindow = 0;
    private demoLastSide: 'YES' | 'NO' | null = null;

    constructor(config: StrategyConfig) {
        this.config = { ...config, liveTrading: false }; // always paper in demo
        this.riskState = createInitialRiskState(this.config);
    }

    private tick(): void {
        const dash = getDashboardState();
        this.riskState = setKillSwitch(this.riskState, dash.killSwitch);

        // Check if we need a new window
        const now = Date.now();
        if (!this.currentWindow || new Date(this.currentWindow.endDateIso).getTime() <= now) {
            // Log previous window summary
            if (this.windowState && this.windowState.totalSpentUsd > 0) {
                const feeEst = this.windowState.totalSpentUsd * (this.config.feeBips / 10000);
                const net = this.windowState.lockedProfit - feeEst;
                this.totalProfit += net;
                this.completedWindows++;

                logWindowState(this.windowState, 'window_end',
                    `Window #${this.completedWindows} ended | pairCost=${this.windowState.pairCost.toFixed(4)} | ` +
                    `net=$${net.toFixed(2)} | cumulative=$${this.totalProfit.toFixed(2)}`,
                    { feeBipsAssumption: this.config.feeBips }
                );

                console.log(`\n===== WINDOW #${this.completedWindows} COMPLETE =====`);
                console.log(`  Pair cost:     ${this.windowState.pairCost.toFixed(4)}`);
                console.log(`  YES/NO:        ${this.windowState.qtyYes} / ${this.windowState.qtyNo}`);
                console.log(`  Locked profit: $${this.windowState.lockedProfit.toFixed(2)}`);
                console.log(`  Net P/L:       $${net.toFixed(2)}`);
                console.log(`  Cumulative:    $${this.totalProfit.toFixed(2)} (${this.completedWindows} windows)`);
                console.log(`====================================\n`);
            }

            this.currentWindow = createSimulatedWindow(this.config);
            this.windowState = createEmptyWindowState(
                this.currentWindow.slug,
                this.currentWindow.conditionId,
                this.currentWindow.endDateIso
            );
            this.tickNum = 0;
            this.demoRoundsThisWindow = 0;
            this.demoLastSide = null;

            console.log(`>> New window: ${this.currentWindow.slug}`);
            console.log(`   End: ${this.currentWindow.endDateIso}`);
        }

        if (!this.windowState || !this.currentWindow) return;
        this.tickNum++;

        // Check end-of-window cutoff
        const secsLeft = Math.max(0, Math.floor((new Date(this.currentWindow.endDateIso).getTime() - now) / 1000));
        if (secsLeft <= this.config.stopTradingSecondsBeforeEnd) {
            updateDashboardState({
                marketSlug: this.currentWindow.slug,
                windowEndIso: this.currentWindow.endDateIso,
                pairCost: this.windowState.pairCost,
                qtyYes: this.windowState.qtyYes,
                qtyNo: this.windowState.qtyNo,
                lockedProfit: this.windowState.lockedProfit,
                totalSpentUsd: this.windowState.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: `Window ending in ${secsLeft}s - holding`,
            });
            return;
        }

        // Generate simulated orderbooks
        const { bookYes, bookNo } = generateSimulatedBooks(this.tickNum);

        const decision = decide(this.config, this.windowState, bookYes, bookNo, undefined, {
            roundsThisWindow: this.demoRoundsThisWindow,
            lastExecutedSide: this.demoLastSide,
            secondsLeft: secsLeft,
        });
        const additionalSpend = decision.action !== 'HOLD' ? decision.price * decision.size : 0;
        const riskCheck = canPlaceOrder(this.config, this.riskState, this.windowState, additionalSpend);

        if (decision.action === 'HOLD' || !riskCheck.allowed) {
            updateDashboardState({
                marketSlug: this.currentWindow.slug,
                windowEndIso: this.currentWindow.endDateIso,
                pairCost: this.windowState.pairCost,
                qtyYes: this.windowState.qtyYes,
                qtyNo: this.windowState.qtyNo,
                lockedProfit: this.windowState.lockedProfit,
                totalSpentUsd: this.windowState.totalSpentUsd,
                consecutiveFailures: this.riskState.consecutiveOrderFailures,
                pendingOrders: 0,
                lastTick: new Date().toISOString(),
                message: decision.action === 'HOLD' ? decision.reason : riskCheck.reason,
            });
            return;
        }

        // Execute paper fill
        const side = decision.action === 'BUY_YES' ? 'YES' as const : 'NO' as const;
        const fillCost = decision.price * decision.size;
        this.windowState = updateWindowStateFromFill(this.windowState, side, decision.size, fillCost);
        this.riskState = recordOrderSuccess(this.riskState, fillCost);
        this.demoRoundsThisWindow++;
        this.demoLastSide = side;

        recordOrder({
            windowSlug: this.currentWindow.slug,
            windowEndIso: this.currentWindow.endDateIso,
            side,
            price: decision.price,
            size: decision.size,
            costUsd: fillCost,
            roundInWindow: this.demoRoundsThisWindow,
        });

        logWindowState(this.windowState, 'tick',
            `[DEMO] ${side} ${decision.size} @ ${decision.price.toFixed(4)} | pairCost=${this.windowState.pairCost.toFixed(4)}`,
            { feeBipsAssumption: this.config.feeBips }
        );

        updateDashboardState({
            running: true,
            marketSlug: this.currentWindow.slug,
            windowEndIso: this.currentWindow.endDateIso,
            pairCost: this.windowState.pairCost,
            qtyYes: this.windowState.qtyYes,
            qtyNo: this.windowState.qtyNo,
            lockedProfit: this.windowState.lockedProfit,
            totalSpentUsd: this.windowState.totalSpentUsd,
            consecutiveFailures: this.riskState.consecutiveOrderFailures,
            pendingOrders: 0,
            lastTick: new Date().toISOString(),
            message: `Demo: ${side} ${decision.size}@${decision.price.toFixed(4)} | ` +
                `window #${this.currentWindow.windowNum} tick #${this.tickNum}`,
        });
    }

    start(): void {
        if (this.intervalId) return;
        initSimulatedBalance(this.config.paperStartingBalanceUsd ?? 5000);
        updateDashboardState({ running: true, message: 'Demo bot starting...' });
        console.log(`[DemoBot] Started. Poll: ${this.config.pollIntervalMs}ms. Dashboard: http://localhost:3750`);
        console.log('[DemoBot] Using simulated orderbooks (no wallet/API needed)\n');
        this.tick();
        this.intervalId = setInterval(() => this.tick(), this.config.pollIntervalMs);
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.windowState && this.windowState.totalSpentUsd > 0) {
            const feeEst = this.windowState.totalSpentUsd * (this.config.feeBips / 10000);
            const net = this.windowState.lockedProfit - feeEst;
            this.totalProfit += net;
            this.completedWindows++;
            console.log(`\n[DemoBot] Final window P/L: $${net.toFixed(2)}`);
        }
        console.log(`[DemoBot] Stopped. Total: ${this.completedWindows} windows, $${this.totalProfit.toFixed(2)} net P/L`);
        updateDashboardState({ running: false, message: 'Demo bot stopped' });
    }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  Polymarket BTC Up/Down — DEMO MODE                  ║');
    console.log('║  Simulated orderbooks | No wallet/API/DB needed     ║');
    console.log('║  Dashboard: http://localhost:3750                    ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    const config = loadStrategyConfig();
    // Use faster poll for demo to show activity quickly
    config.pollIntervalMs = Math.min(config.pollIntervalMs, 2000);
    // Use short windows for demo (2 minutes instead of 15)
    config.stopTradingSecondsBeforeEnd = 15;

    startDashboard();

    const bot = new DemoBot(config);
    bot.start();

    process.on('SIGINT', () => {
        bot.stop();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        bot.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
