/**
 * P/L Summary generator: reads log files and produces summary by day and by window.
 * Client requirement: "Net P/L by day and by market window" + "Fees/slippage assumptions vs realized"
 *
 * Usage: import and call generateSummary(), or run standalone: npx ts-node src/services/plSummary.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StrategyLogEntry } from '../interfaces/strategyInterfaces';

const LOG_DIR = process.env.STRATEGY_LOG_DIR || path.join(process.cwd(), 'logs');

interface WindowSummary {
    marketSlug: string;
    windowEndIso: string;
    finalPairCost: number;
    qtyYes: number;
    qtyNo: number;
    costYes: number;
    costNo: number;
    totalSpent: number;
    lockedProfit: number;
    feeBipsAssumption: number;
    estimatedFees: number;
    netProfitEstimate: number;
    orderCount: number;
    failedOrders: number;
}

interface DaySummary {
    date: string;
    windowCount: number;
    totalSpent: number;
    totalLockedProfit: number;
    totalEstFees: number;
    totalNetProfitEst: number;
    avgPairCost: number;
    totalOrders: number;
    totalFailures: number;
    windows: WindowSummary[];
}

/**
 * Read all JSON log entries for a given date.
 */
function readLogEntries(date: string): StrategyLogEntry[] {
    const jsonPath = path.join(LOG_DIR, `strategy_${date}.json`);
    if (!fs.existsSync(jsonPath)) return [];
    const lines = fs.readFileSync(jsonPath, 'utf-8').split('\n').filter(Boolean);
    const entries: StrategyLogEntry[] = [];
    for (const line of lines) {
        try {
            entries.push(JSON.parse(line) as StrategyLogEntry);
        } catch {
            // skip malformed
        }
    }
    return entries;
}

/**
 * Generate summary for a specific date (YYYY-MM-DD).
 */
export function generateDaySummary(date: string): DaySummary {
    const entries = readLogEntries(date);
    const windowMap = new Map<string, { entries: StrategyLogEntry[]; endEntry?: StrategyLogEntry }>();

    for (const e of entries) {
        const key = `${e.marketSlug}|${e.windowEndIso}`;
        if (!windowMap.has(key)) windowMap.set(key, { entries: [] });
        const w = windowMap.get(key)!;
        w.entries.push(e);
        if (e.event === 'window_end') w.endEntry = e;
    }

    const windows: WindowSummary[] = [];
    for (const [, w] of windowMap) {
        // Use the last entry (or window_end entry) for final state
        const final = w.endEntry || w.entries[w.entries.length - 1];
        const orderCount = w.entries.filter((e) => e.event === 'order_placed' || e.event === 'tick').length;
        const failedOrders = w.entries.filter((e) => e.event === 'order_failed').length;
        const feeBips = final.feeBipsAssumption ?? 0;
        const estFees = final.totalSpentUsd * (feeBips / 10000);

        windows.push({
            marketSlug: final.marketSlug,
            windowEndIso: final.windowEndIso,
            finalPairCost: final.pairCost,
            qtyYes: final.qtyYes,
            qtyNo: final.qtyNo,
            costYes: final.costYes,
            costNo: final.costNo,
            totalSpent: final.totalSpentUsd,
            lockedProfit: final.lockedProfit,
            feeBipsAssumption: feeBips,
            estimatedFees: estFees,
            netProfitEstimate: final.lockedProfit - estFees,
            orderCount,
            failedOrders,
        });
    }

    const totalSpent = windows.reduce((s, w) => s + w.totalSpent, 0);
    const totalLockedProfit = windows.reduce((s, w) => s + w.lockedProfit, 0);
    const totalEstFees = windows.reduce((s, w) => s + w.estimatedFees, 0);
    const totalNetProfitEst = windows.reduce((s, w) => s + w.netProfitEstimate, 0);
    const pairCosts = windows.filter((w) => w.finalPairCost > 0).map((w) => w.finalPairCost);
    const avgPairCost = pairCosts.length > 0 ? pairCosts.reduce((s, p) => s + p, 0) / pairCosts.length : 0;
    const totalOrders = windows.reduce((s, w) => s + w.orderCount, 0);
    const totalFailures = windows.reduce((s, w) => s + w.failedOrders, 0);

    return {
        date,
        windowCount: windows.length,
        totalSpent,
        totalLockedProfit,
        totalEstFees,
        totalNetProfitEst,
        avgPairCost,
        totalOrders,
        totalFailures,
        windows,
    };
}

/**
 * Generate summaries for all available dates.
 */
export function generateAllSummaries(): DaySummary[] {
    if (!fs.existsSync(LOG_DIR)) return [];
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith('strategy_') && f.endsWith('.json'));
    const dates = files.map((f) => f.replace('strategy_', '').replace('.json', '')).sort();
    return dates.map(generateDaySummary);
}

/**
 * Print a formatted summary to console.
 */
export function printSummary(summaries?: DaySummary[]): void {
    const all = summaries ?? generateAllSummaries();
    if (all.length === 0) {
        console.log('No log data found.');
        return;
    }

    console.log('\n' + '='.repeat(70));
    console.log('  POLYMARKET HEDGE BOT — P/L SUMMARY');
    console.log('='.repeat(70));

    let grandTotalSpent = 0;
    let grandTotalProfit = 0;
    let grandTotalFees = 0;
    let grandTotalNet = 0;
    let grandWindows = 0;

    for (const day of all) {
        console.log(`\n  Date: ${day.date}`);
        console.log(`  Windows: ${day.windowCount} | Orders: ${day.totalOrders} | Failures: ${day.totalFailures}`);
        console.log(`  Avg pair cost:     ${day.avgPairCost.toFixed(4)}`);
        console.log(`  Total spent:       $${day.totalSpent.toFixed(2)}`);
        console.log(`  Locked profit:     $${day.totalLockedProfit.toFixed(2)}`);
        console.log(`  Est. fees:         $${day.totalEstFees.toFixed(2)}`);
        console.log(`  Net P/L (est):     $${day.totalNetProfitEst.toFixed(2)}`);

        if (day.windows.length > 0 && day.windows.length <= 20) {
            console.log('  ---');
            for (const w of day.windows) {
                const flag = w.finalPairCost < 1.0 ? '✓' : '✗';
                console.log(`    ${flag} ${w.marketSlug} end=${new Date(w.windowEndIso).toLocaleTimeString()} ` +
                    `pairCost=${w.finalPairCost.toFixed(4)} net=$${w.netProfitEstimate.toFixed(2)}`);
            }
        }

        grandTotalSpent += day.totalSpent;
        grandTotalProfit += day.totalLockedProfit;
        grandTotalFees += day.totalEstFees;
        grandTotalNet += day.totalNetProfitEst;
        grandWindows += day.windowCount;
    }

    console.log('\n' + '-'.repeat(70));
    console.log(`  GRAND TOTAL (${all.length} day(s), ${grandWindows} windows)`);
    console.log(`  Total spent:       $${grandTotalSpent.toFixed(2)}`);
    console.log(`  Locked profit:     $${grandTotalProfit.toFixed(2)}`);
    console.log(`  Est. fees:         $${grandTotalFees.toFixed(2)}`);
    console.log(`  Net P/L (est):     $${grandTotalNet.toFixed(2)}`);
    console.log('='.repeat(70) + '\n');
}

// Allow running standalone: npx ts-node src/services/plSummary.ts
if (require.main === module) {
    printSummary();
}
