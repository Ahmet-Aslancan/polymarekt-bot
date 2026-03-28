/**
 * Heartbeat — sends bot operational status to a remote monitoring server.
 *
 * Sends ONLY non-sensitive operational data (P/L, market, uptime, etc.).
 * Does NOT send private keys, RPC URLs, or any credentials.
 *
 * Configure via .env:
 *   HEARTBEAT_URL   = https://your-server.com/api/heartbeat
 *   HEARTBEAT_TOKEN = a-secret-token
 *
 * If HEARTBEAT_URL is not set, the heartbeat is disabled (no-op).
 */

import axios from 'axios';
import { getDashboardState } from './dashboard';

const HEARTBEAT_INTERVAL_MS = 60_000; // every 60 seconds

let intervalId: ReturnType<typeof setInterval> | null = null;

interface HeartbeatPayload {
    botId: string;
    timestamp: string;
    running: boolean;
    liveTrading: boolean;
    killSwitch: boolean;
    uptimeSeconds: number;
    // Market
    marketSlug: string | null;
    windowEndIso: string | null;
    windowSecondsLeft: number;
    // Positions
    qtyYes: number;
    qtyNo: number;
    costYes: number;
    costNo: number;
    avgYes: number;
    avgNo: number;
    pairCost: number;
    totalSpentUsd: number;
    // P/L
    lockedProfit: number;
    cumulativeProfitUsd: number;
    completedWindows: number;
    // Balances (USDC only, no credentials)
    walletBalanceUsdc: number;
    polymarketBalanceUsdc: number;
    totalBalanceUsdc: number;
    // Live prices
    liveBestBidYes: number;
    liveBestBidNo: number;
    liveCombinedBid: number;
    // Risk
    consecutiveFailures: number;
    pendingOrders: number;
    // Status
    message: string;
}

function buildPayload(): HeartbeatPayload {
    const s = getDashboardState();
    const windowSecondsLeft = s.windowEndIso
        ? Math.max(0, Math.floor((new Date(s.windowEndIso).getTime() - Date.now()) / 1000))
        : 0;

    return {
        botId: s.walletAddress || 'unknown',
        timestamp: new Date().toISOString(),
        running: s.running,
        liveTrading: s.liveTrading,
        killSwitch: s.killSwitch,
        uptimeSeconds: s.uptimeSeconds,
        marketSlug: s.marketSlug,
        windowEndIso: s.windowEndIso,
        windowSecondsLeft,
        qtyYes: s.qtyYes,
        qtyNo: s.qtyNo,
        costYes: s.costYes,
        costNo: s.costNo,
        avgYes: s.avgYes,
        avgNo: s.avgNo,
        pairCost: s.pairCost,
        totalSpentUsd: s.totalSpentUsd,
        lockedProfit: s.lockedProfit,
        cumulativeProfitUsd: s.cumulativeProfitUsd,
        completedWindows: s.completedWindows,
        walletBalanceUsdc: s.walletBalanceUsdc,
        polymarketBalanceUsdc: s.polymarketBalanceUsdc,
        totalBalanceUsdc: s.totalBalanceUsdc,
        liveBestBidYes: s.liveBestBidYes,
        liveBestBidNo: s.liveBestBidNo,
        liveCombinedBid: s.liveCombinedBid,
        consecutiveFailures: s.consecutiveFailures,
        pendingOrders: s.pendingOrders,
        message: s.message,
    };
}

async function sendHeartbeat(url: string, token: string): Promise<void> {
    try {
        const payload = buildPayload();
        await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            timeout: 10_000,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Heartbeat] Send failed: ${msg}`);
    }
}

/**
 * Start the heartbeat sender. Reads HEARTBEAT_URL and HEARTBEAT_TOKEN from env.
 * If HEARTBEAT_URL is not set, does nothing (monitoring disabled).
 */
export function startHeartbeat(): void {
    const url = process.env.HEARTBEAT_URL;
    const token = process.env.HEARTBEAT_TOKEN || '';

    if (!url) {
        console.log('[Heartbeat] HEARTBEAT_URL not set — remote monitoring disabled.');
        return;
    }

    console.log(`[Heartbeat] Sending status to ${url} every ${HEARTBEAT_INTERVAL_MS / 1000}s`);

    // Send immediately, then on interval
    sendHeartbeat(url, token);
    intervalId = setInterval(() => sendHeartbeat(url, token), HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat sender.
 */
export function stopHeartbeat(): void {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}
