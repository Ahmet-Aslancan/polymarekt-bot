/**
 * Structured logging and P/L reporting (CSV/JSON) for the hedge strategy.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StrategyLogEntry, WindowState } from '../interfaces/strategyInterfaces';

const LOG_DIR = process.env.STRATEGY_LOG_DIR || path.join(process.cwd(), 'logs');
const CSV_HEADER = 'timestamp,marketSlug,windowEndIso,pairCost,qtyYes,qtyNo,costYes,costNo,lockedProfit,totalSpentUsd,event,message,feeBipsAssumption,realizedFeesUsd,positionValueUsd,positionCostUsd,unrealizedPnlUsd,portfolioValueUsd,sessionPnlUsd';

function ensureLogDir(): void {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

function csvRow(entry: StrategyLogEntry): string {
    const msg = (entry.message ?? '').replace(/"/g, '""');
    return [
        entry.timestamp,
        entry.marketSlug,
        entry.windowEndIso,
        entry.pairCost.toFixed(4),
        entry.qtyYes,
        entry.qtyNo,
        entry.costYes.toFixed(2),
        entry.costNo.toFixed(2),
        entry.lockedProfit.toFixed(2),
        entry.totalSpentUsd.toFixed(2),
        entry.event,
        `"${msg}"`,
        entry.feeBipsAssumption ?? '',
        entry.realizedFeesUsd != null ? entry.realizedFeesUsd.toFixed(4) : '',
        entry.positionValueUsd != null ? entry.positionValueUsd.toFixed(4) : '',
        entry.positionCostUsd != null ? entry.positionCostUsd.toFixed(4) : '',
        entry.unrealizedPnlUsd != null ? entry.unrealizedPnlUsd.toFixed(4) : '',
        entry.portfolioValueUsd != null ? entry.portfolioValueUsd.toFixed(4) : '',
        entry.sessionPnlUsd != null ? entry.sessionPnlUsd.toFixed(4) : '',
    ].join(',');
}

export function logEntry(entry: StrategyLogEntry, alsoConsole = true): void {
    ensureLogDir();
    const date = entry.timestamp.slice(0, 10);
    const csvPath = path.join(LOG_DIR, `strategy_${date}.csv`);
    const exists = fs.existsSync(csvPath);
    const line = csvRow(entry);
    fs.appendFileSync(csvPath, (exists ? '' : CSV_HEADER + '\n') + line + '\n');
    const jsonPath = path.join(LOG_DIR, `strategy_${date}.json`);
    const jsonLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(jsonPath, jsonLine);
    if (alsoConsole) {
        console.log(`[${entry.event}] ${entry.marketSlug} pairCost=${entry.pairCost.toFixed(4)} ${entry.event} ${entry.message ?? ''}`);
    }
}

export function logWindowState(
    state: WindowState,
    event: StrategyLogEntry['event'],
    message?: string,
    opts?: {
        feeBipsAssumption?: number;
        realizedFeesUsd?: number;
        quietConsole?: boolean;
        positionValueUsd?: number;
        positionCostUsd?: number;
        unrealizedPnlUsd?: number;
        portfolioValueUsd?: number;
        sessionPnlUsd?: number;
    }
): void {
    logEntry({
        timestamp: new Date().toISOString(),
        marketSlug: state.marketSlug,
        windowEndIso: state.windowEndIso,
        pairCost: state.pairCost,
        qtyYes: state.qtyYes,
        qtyNo: state.qtyNo,
        costYes: state.costYes,
        costNo: state.costNo,
        lockedProfit: state.lockedProfit,
        totalSpentUsd: state.totalSpentUsd,
        event,
        message,
        feeBipsAssumption: opts?.feeBipsAssumption,
        realizedFeesUsd: opts?.realizedFeesUsd,
        positionValueUsd: opts?.positionValueUsd,
        positionCostUsd: opts?.positionCostUsd,
        unrealizedPnlUsd: opts?.unrealizedPnlUsd,
        portfolioValueUsd: opts?.portfolioValueUsd,
        sessionPnlUsd: opts?.sessionPnlUsd,
    }, !opts?.quietConsole);
}

export function getLogDir(): string {
    return LOG_DIR;
}
