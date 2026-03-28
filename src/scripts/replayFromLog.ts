import fs from 'fs';
import path from 'path';
import { loadStrategyConfig } from '../config/strategyConfig';
import type { WindowState, OrderBookSnapshot, StrategyDecisionContext } from '../interfaces/strategyInterfaces';
import { createEmptyWindowState, updateWindowStateFromFill, decide, orderBookFromClob } from '../services/hedgeStrategy';

// NOTE:
// `Test-Track-All-out_1.log` is a text trace of simulated ticks:
//   * Market :  , 5m-<startUnix>(<date str>)
//   * Time : M:S, BTC (<btcDelta>)  * UP (<prob>)   OR
//   * Time : M:S, BTC (<btcDelta>)  * Down (<prob>)
//
// There are no explicit order fills in that log, so we run the bot's current decision logic
// on the reconstructed (bid) prices and assume immediate fill when the bot decides BUY_*.

type WinnerSide = 'YES' | 'NO';

function parseMarketStart(line: string): number | null {
    // Example: " * Market :  , 5m-1774326300(2026-03-24 13:25)"
    const m = line.match(/5m-(\d+)\(/);
    if (!m) return null;
    return parseInt(m[1], 10);
}

function parseTick(line: string): {
    offsetSec: number;
    btcDelta: number;
    probSide?: 'UP' | 'Down';
    prob?: number;
} | null {
    // Example with probability:
    //  * Time : 2:5, BTC (-70603.3)  * UP (0.24)
    // Example without probability:
    //  * Time : 1:12, BTC (138.9)
    const re = /\*\s*Time\s*:\s*(\d+):(\d+),\s*BTC\s*\(([-\d.]+)\)(?:\s*\*\s*(UP|Down)\s*\(([-\d.]+)\))?/;
    const m = line.match(re);
    if (!m) return null;

    const mm = parseInt(m[1], 10);
    const ss = parseInt(m[2], 10);
    const btcDelta = parseFloat(m[3]);
    const side = m[4] ? (m[4] === 'UP' ? 'UP' : 'Down') : undefined;
    const prob = m[5] !== undefined ? parseFloat(m[5]) : undefined;
    return { offsetSec: mm * 60 + ss, btcDelta, probSide: side, prob };
}

function toBidPrices(upProb: number): { yesBid: number; noBid: number } {
    // In your legacy logs, UP(prob) is the implied price of YES; Down is complement.
    const yesBid = upProb;
    const noBid = 1 - upProb;
    return { yesBid, noBid };
}

function clampPrice(p: number): number {
    if (!isFinite(p)) return 0;
    // Keep inside (0,1)
    if (p <= 0) return 0.01;
    if (p >= 0.999) return 0.99;
    return Math.round(p * 100) / 100;
}

function buildOrderbookSnapshot(yesBid: number, noBid: number, yesAsk?: number, noAsk?: number): {
    bookYes: OrderBookSnapshot;
    bookNo: OrderBookSnapshot;
} {
    const tick = 0.01;
    const spread = 0.02;
    const yBid = clampPrice(yesBid);
    const nBid = clampPrice(noBid);
    const yAsk = clampPrice(yesAsk ?? yBid + spread);
    const nAsk = clampPrice(noAsk ?? nBid + spread);

    const bookYes: OrderBookSnapshot = {
        tokenId: 'yes-token',
        side: 'YES',
        bids: [{ price: yBid, size: 100 }],
        asks: [{ price: yAsk, size: 100 }],
    };
    const bookNo: OrderBookSnapshot = {
        tokenId: 'no-token',
        side: 'NO',
        bids: [{ price: nBid, size: 100 }],
        asks: [{ price: nAsk, size: 100 }],
    };
    return { bookYes, bookNo };
}

function realizedNetProfit({
    winnerSide,
    qtyYes,
    qtyNo,
    totalSpentUsd,
    feeBips,
}: {
    winnerSide: WinnerSide;
    qtyYes: number;
    qtyNo: number;
    totalSpentUsd: number;
    feeBips: number;
}): { payout: number; feeEstimate: number; net: number } {
    const payout = winnerSide === 'YES' ? qtyYes : qtyNo;
    const feeEstimate = totalSpentUsd * (feeBips / 10000);
    const net = payout - totalSpentUsd - feeEstimate;
    return { payout, feeEstimate, net };
}

async function main(): Promise<void> {
    const config = loadStrategyConfig();
    // Repo cwd is: .../Polymarket-betting-bot-main/Polymarket-betting-bot-main
    // So the log sits two levels up: .../Poly strategy_03_24/Test-Track-All-out_1.log
    const defaultLog = path.resolve(process.cwd(), '..', '..', 'Test-Track-All-out_1.log');
    const cliArg = process.argv.slice(2).find((a) => a && !a.startsWith('--'));
    const logPath = cliArg || process.env.REPLAY_LOG_PATH || defaultLog;
    const logAbs = path.isAbsolute(logPath) ? logPath : path.resolve(process.cwd(), logPath);
    const txt = fs.readFileSync(logAbs, 'utf-8');

    // Parse into market blocks
    const lines = txt.split(/\r?\n/);

    const windowSec = config.btcMarketWindowMinutes === 5 ? 300 : 900;
    const dayDate = 'unknown';

    let currentWindowStart: number | null = null;
    let firstTickBtcValue: number | null = null;
    let lastTickBtcValue: number | null = null;
    let lastYesBid: number | null = null;
    let lastNoBid: number | null = null;

    let state: WindowState | null = null;
    let roundsThisWindow = 0;
    let lastExecutedSide: 'YES' | 'NO' | null = null;
    let orders: Array<{
        side: 'YES' | 'NO';
        price: number;
        size: number;
        costUsd: number;
    }> = [];

    const allWindows: Array<{
        windowStart: number;
        orders: typeof orders;
        qtyYes: number;
        qtyNo: number;
        totalSpentUsd: number;
        winnerSide: WinnerSide;
    }> = [];

    function flushWindow() {
        if (currentWindowStart === null || state === null) return;
        // IMPORTANT:
        // In `Test-Track-All-out*.log`, the `UP(prob)` field frequently becomes `0` late-window
        // (likely due to upstream feed / market close), so using prob to resolve the winner is wrong.
        // This trace behaves like a per-window delta series: the final BTC value sign indicates UP/DOWN.
        const lastBtc = lastTickBtcValue ?? 0;
        const winnerSide: WinnerSide = lastBtc >= 0 ? 'YES' : 'NO';
        allWindows.push({
            windowStart: currentWindowStart,
            orders: orders.slice(),
            qtyYes: state.qtyYes,
            qtyNo: state.qtyNo,
            totalSpentUsd: state.totalSpentUsd,
            winnerSide,
        });
        currentWindowStart = null;
        state = null;
        roundsThisWindow = 0;
        lastExecutedSide = null;
        orders = [];
        firstTickBtcValue = null;
        lastTickBtcValue = null;
        lastYesBid = null;
        lastNoBid = null;
    }

    for (const line of lines) {
        const maybeStart = parseMarketStart(line);
        if (maybeStart !== null) {
            flushWindow();
            currentWindowStart = maybeStart;
            const windowEnd = (maybeStart + windowSec) * 1000;
            const windowEndIso = new Date(windowEnd).toISOString();
            // Create per-market tracked state
            state = createEmptyWindowState(`btc-updown-${config.btcMarketWindowMinutes}m-${maybeStart}`, '0xsim', windowEndIso);
            continue;
        }

        if (state === null || currentWindowStart === null) continue;

        const tick = parseTick(line);
        if (!tick) continue;

        if (firstTickBtcValue === null) firstTickBtcValue = tick.btcDelta;
        lastTickBtcValue = tick.btcDelta;

        if (tick.probSide && tick.prob !== undefined) {
            const upProb = tick.probSide === 'UP' ? tick.prob : 1 - tick.prob;
            // Guard: ignore invalid probs (0, 1, NaN) that appear in the log near window end.
            if (isFinite(upProb) && upProb > 0.001 && upProb < 0.999) {
                const { yesBid, noBid } = toBidPrices(upProb);
                lastYesBid = yesBid;
                lastNoBid = noBid;
            }
        }

        if (lastYesBid === null || lastNoBid === null) continue;

        const offsetSec = Math.min(windowSec - 1, Math.max(0, tick.offsetSec));
        const secondsLeft = Math.max(0, windowSec - offsetSec);

        const { bookYes, bookNo } = buildOrderbookSnapshot(lastYesBid, lastNoBid);
        const ctx: StrategyDecisionContext = { roundsThisWindow, lastExecutedSide, secondsLeft };
        const decision = decide(config, state, bookYes, bookNo, undefined, ctx);

        if (decision.action !== 'HOLD') {
            const side: 'YES' | 'NO' = decision.action === 'BUY_YES' ? 'YES' : 'NO';
            const price = decision.price;
            const size = decision.size;
            const costUsd = price * size;
            state = updateWindowStateFromFill(state, side, size, costUsd);
            roundsThisWindow++;
            lastExecutedSide = side;
            orders.push({ side, price, size, costUsd });
        }
    }
    flushWindow();

    // Summarize
    let totalNet = 0;
    let totalSpent = 0;
    let totalPayout = 0;
    let totalOrders = 0;
    const winBySide: Record<WinnerSide, number> = { YES: 0, NO: 0 };
    let realizedPnLFromOrders = 0;
    let winOrders = 0;
    let loseOrders = 0;
    let pnlWin = 0;
    let pnlLose = 0;
    let bestWindows: Array<{ windowStart: number; net: number }> = [];
    let worstWindows: Array<{ windowStart: number; net: number }> = [];

    for (const w of allWindows) {
        const { payout, feeEstimate, net } = realizedNetProfit({
            winnerSide: w.winnerSide,
            qtyYes: w.qtyYes,
            qtyNo: w.qtyNo,
            totalSpentUsd: w.totalSpentUsd,
            feeBips: config.feeBips,
        });

        totalNet += net;
        totalSpent += w.totalSpentUsd;
        totalPayout += payout;
        totalOrders += w.orders.length;
        winBySide[w.winnerSide] += 1;

        for (const o of w.orders) {
            const pnl = o.side === w.winnerSide ? o.size * (1 - o.price) : -o.size * o.price;
            realizedPnLFromOrders += pnl;
            if (o.side === w.winnerSide) {
                winOrders++;
                pnlWin += pnl;
            } else {
                loseOrders++;
                pnlLose += pnl;
            }
        }

        // Track extremes by realized net
        bestWindows.push({ windowStart: w.windowStart, net });
        worstWindows.push({ windowStart: w.windowStart, net });
    }

    bestWindows = bestWindows.sort((a, b) => b.net - a.net).slice(0, 10);
    worstWindows = worstWindows.sort((a, b) => a.net - b.net).slice(0, 10);

    console.log(`===== Replay Summary (from ${path.basename(logAbs)}) =====`);
    console.log(`Window size: ${config.btcMarketWindowMinutes}m (${windowSec}s)`);
    console.log(`Markets parsed: ${allWindows.length}`);
    console.log(`Total orders executed: ${totalOrders}`);
    console.log(`Total spent: $${totalSpent.toFixed(2)}`);
    console.log(`Total payout: $${totalPayout.toFixed(2)}`);
    console.log(`Total realized P/L (after fees): $${totalNet.toFixed(2)}`);
    console.log(`Orders P/L (ignoring fees, sum over orders): $${realizedPnLFromOrders.toFixed(2)}`);
    console.log(`Winning orders: ${winOrders} | P/L from winning orders (ignoring fees): $${pnlWin.toFixed(2)}`);
    console.log(`Losing orders:  ${loseOrders} | P/L from losing orders (ignoring fees):  $${pnlLose.toFixed(2)}`);
    console.log(`Winner counts: YES=${winBySide.YES}, NO=${winBySide.NO}`);
    console.log(`Best 10 windows (by net after fees):`);
    for (const bw of bestWindows) console.log(`  5m-${bw.windowStart} net=$${bw.net.toFixed(2)}`);
    console.log(`Worst 10 windows (by net after fees):`);
    for (const ww of worstWindows) console.log(`  5m-${ww.windowStart} net=$${ww.net.toFixed(2)}`);
    console.log('================================================================');
}

main().catch((e) => {
    console.error('Replay failed:', e);
    process.exit(1);
});

