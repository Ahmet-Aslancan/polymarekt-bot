/**
 * HTTP dashboard to control and monitor the bot.
 * - Auto-refreshing UI with real-time metrics
 * - Kill switch toggle
 * - JSON API for programmatic access
 * - P/L summary endpoint
 * - Paper trading: Trading History page with per-window P&L and order list
 * Serves on port from env DASHBOARD_PORT or 3750.
 */

import * as http from 'http';
import {
    getSimulatedBalance,
    getCompletedWindowsDetail,
    getLast24hSummary,
    getOrdersForWindow,
} from './tradeHistory';

const DEFAULT_PORT = 3750;

export interface DashboardState {
    running: boolean;
    killSwitch: boolean;
    marketSlug: string | null;
    windowEndIso: string | null;
    pairCost: number;
    qtyYes: number;
    qtyNo: number;
    trackedQtyYes: number;
    trackedQtyNo: number;
    actualQtyYes: number;
    actualQtyNo: number;
    lockedProfit: number;
    totalSpentUsd: number;
    consecutiveFailures: number;
    pendingOrders: number;
    lastTick: string | null;
    message: string;
    walletBalanceUsdc: number;
    polymarketBalanceUsdc: number;
    totalBalanceUsdc: number;
    walletAddress: string;
    proxyWalletAddress: string;
    liveTrading: boolean;
    completedWindows: number;
    cumulativeProfitUsd: number;
    uptimeSeconds: number;
    // BTC 15m scan
    scanSlugsChecked: string[];
    scanMarketsReturned: number;
    scanTotalApiFetched: number;
    scanActiveMarket: {
        question: string;
        slug: string;
        endTime: string;
        secondsLeft: number;
        acceptingOrders: boolean;
    } | null;
    scanRejected: Array<{ slug: string; reason: string }>;
    scanError: string | null;
    scanTimestamp: string | null;
    // Config limits (for display)
    maxPositionPerWindowUsd: number;
    // Live orderbook prices
    liveBestAskYes: number;
    liveBestAskNo: number;
    liveCombinedAsk: number;
    liveBestBidYes: number;
    liveBestBidNo: number;
    liveCombinedBid: number;
    livePairCostCeiling: number;
    liveEffectiveMinShares: number;
    // Pending order tracking (entry prices)
    entryOrderYes: { price: number; size: number; placedAt: string } | null;
    entryOrderNo: { price: number; size: number; placedAt: string } | null;
    // Per-side fill details (for "Active Pair Position" display)
    costYes: number;
    costNo: number;
    avgYes: number;
    avgNo: number;
    // Balance freshness
    balanceLastCheckedIso: string;
    // Auto redemption monitoring
    redeemQueueSize: number;
    lastRedeemSweepIso: string | null;
    lastRedeemSweepResult: string;
    // Accounting
    feeBipsAssumption: number;
    positionValueUsd: number;
    positionCostUsd: number;
    unrealizedPnlUsd: number;
    portfolioValueUsd: number;
    sessionPnlUsd: number;
    sessionStartPortfolioUsd: number;
    /** Net P/L if Up (YES) wins: qtyYes×$1 − total spent (gross; fees not deducted). */
    afterPnlIfUpUsd: number;
    /** Net P/L if Down (NO) wins: qtyNo×$1 − total spent (gross; fees not deducted). */
    afterPnlIfDownUsd: number;
    /** Polymarket market question (e.g. Bitcoin Up or Down — … time range ET). */
    activeMarketTitle: string | null;
    /** Configured window length for ET fallback label (5 or 15). */
    tradingWindowMinutes: 5 | 15 | null;
}

let sharedState: DashboardState = {
    running: false,
    killSwitch: false,
    marketSlug: null,
    windowEndIso: null,
    pairCost: 0,
    qtyYes: 0,
    qtyNo: 0,
    trackedQtyYes: 0,
    trackedQtyNo: 0,
    actualQtyYes: 0,
    actualQtyNo: 0,
    lockedProfit: 0,
    totalSpentUsd: 0,
    consecutiveFailures: 0,
    pendingOrders: 0,
    lastTick: null,
    message: 'Bot not started',
    walletBalanceUsdc: 0,
    polymarketBalanceUsdc: 0,
    totalBalanceUsdc: 0,
    walletAddress: '',
    proxyWalletAddress: '',
    liveTrading: false,
    completedWindows: 0,
    cumulativeProfitUsd: 0,
    uptimeSeconds: 0,
    scanSlugsChecked: [],
    scanMarketsReturned: 0,
    scanTotalApiFetched: 0,
    scanActiveMarket: null,
    scanRejected: [],
    scanError: null,
    scanTimestamp: null,
    maxPositionPerWindowUsd: 0,
    liveBestAskYes: 0,
    liveBestAskNo: 0,
    liveCombinedAsk: 0,
    liveBestBidYes: 0,
    liveBestBidNo: 0,
    liveCombinedBid: 0,
    livePairCostCeiling: 0,
    liveEffectiveMinShares: 0,
    entryOrderYes: null,
    entryOrderNo: null,
    costYes: 0,
    costNo: 0,
    avgYes: 0,
    avgNo: 0,
    balanceLastCheckedIso: '',
    redeemQueueSize: 0,
    lastRedeemSweepIso: null,
    lastRedeemSweepResult: 'Not run yet',
    feeBipsAssumption: 10,
    positionValueUsd: 0,
    positionCostUsd: 0,
    unrealizedPnlUsd: 0,
    portfolioValueUsd: 0,
    sessionPnlUsd: 0,
    sessionStartPortfolioUsd: 0,
    afterPnlIfUpUsd: 0,
    afterPnlIfDownUsd: 0,
    activeMarketTitle: null,
    tradingWindowMinutes: null,
};

export function updateDashboardState(update: Partial<DashboardState>): void {
    sharedState = { ...sharedState, ...update };
}

export function getDashboardState(): DashboardState {
    const s = { ...sharedState };
    const spent = s.totalSpentUsd;
    return {
        ...s,
        afterPnlIfUpUsd: s.qtyYes - spent,
        afterPnlIfDownUsd: s.qtyNo - spent,
    };
}

function formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function shortAddr(addr: string): string {
    if (!addr || addr.length < 12) return addr || '—';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Prominent market line for top of dashboard (API question or ET window from window end). */
function marketHeadlineHtml(s: DashboardState): string {
    const raw = (s.activeMarketTitle || s.scanActiveMarket?.question || '').trim();
    if (raw) return escapeHtml(raw);
    if (s.windowEndIso) {
        const endMs = new Date(s.windowEndIso).getTime();
        const mins = s.tradingWindowMinutes === 5 ? 5 : s.tradingWindowMinutes === 15 ? 15 : 5;
        const startMs = endMs - mins * 60 * 1000;
        const opts: Intl.DateTimeFormatOptions = {
            timeZone: 'America/New_York',
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        };
        const startStr = new Date(startMs).toLocaleString('en-US', opts);
        const endStr = new Date(endMs).toLocaleString('en-US', {
            ...opts,
            timeZoneName: 'short',
        });
        return escapeHtml(`Bitcoin Up or Down — ${startStr} – ${endStr}`);
    }
    return '<span style="opacity:0.75;color:var(--text-muted)">Waiting for active BTC Up/Down market…</span>';
}

function serveHtml(): string {
    const s = getDashboardState();
    const statusColor = s.running ? '#10b981' : '#ef4444';
    const statusGlow = s.running ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';
    const modeColor = s.liveTrading ? '#f59e0b' : '#6366f1';
    const modeLabel = s.liveTrading ? 'LIVE' : 'PAPER';
    const killColor = s.killSwitch ? '#ef4444' : '#10b981';
    const pairColor = s.pairCost < 0.98 ? '#10b981' : s.pairCost < 1.0 ? '#f59e0b' : '#ef4444';
    const profitColor = s.lockedProfit >= 0 ? '#10b981' : '#ef4444';
    const cumulColor = s.cumulativeProfitUsd >= 0 ? '#10b981' : '#ef4444';
    const walletBalStr = s.walletBalanceUsdc.toFixed(2);
    const polyBalStr = s.polymarketBalanceUsdc.toFixed(2);
    const totalBalStr = s.totalBalanceUsdc.toFixed(2);
    const windowTimeLeft = s.windowEndIso ? Math.max(0, Math.floor((new Date(s.windowEndIso).getTime() - Date.now()) / 1000)) : 0;
    const windowProgress = s.windowEndIso ? Math.max(0, Math.min(100, ((900 - windowTimeLeft) / 900) * 100)) : 0;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Polymarket Hedge Bot</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');

    :root {
      --bg-primary: #0a0e1a;
      --bg-secondary: #111827;
      --bg-card: #1a1f35;
      --bg-card-hover: #1f2642;
      --border: #2a3050;
      --border-light: #354070;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent: #3b82f6;
      --accent-glow: rgba(59,130,246,0.15);
      --green: #10b981;
      --green-glow: rgba(16,185,129,0.15);
      --red: #ef4444;
      --yellow: #f59e0b;
      --purple: #8b5cf6;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Subtle animated gradient background */
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at 20% 0%, rgba(59,130,246,0.08) 0%, transparent 50%),
                  radial-gradient(ellipse at 80% 100%, rgba(139,92,246,0.06) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .app { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 24px 20px; }

    /* ─── Header ─── */
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 12px; }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; color: white; flex-shrink: 0; }
    .header h1 { font-size: 1.35rem; font-weight: 700; color: var(--text-primary); letter-spacing: -0.02em; }
    .header .tagline { font-size: 0.78rem; color: var(--text-muted); margin-top: 2px; }
    .header-badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

    /* ─── Badges ─── */
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 20px;
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
      border: 1px solid transparent;
    }
    .badge-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .badge-running { background: rgba(16,185,129,0.12); color: #10b981; border-color: rgba(16,185,129,0.25); }
    .badge-stopped { background: rgba(239,68,68,0.12); color: #ef4444; border-color: rgba(239,68,68,0.25); }
    .badge-live { background: rgba(245,158,11,0.12); color: #f59e0b; border-color: rgba(245,158,11,0.25); }
    .badge-paper { background: rgba(99,102,241,0.12); color: #6366f1; border-color: rgba(99,102,241,0.25); }
    .badge-kill-off { background: rgba(16,185,129,0.12); color: #10b981; border-color: rgba(16,185,129,0.25); }
    .badge-kill-on { background: rgba(239,68,68,0.12); color: #ef4444; border-color: rgba(239,68,68,0.25); }

    @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .badge-dot.animate { animation: pulse-dot 2s ease-in-out infinite; }

    /* ─── Wallet Banner ─── */
    .wallet-banner {
      background: linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.08));
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px 24px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
    }
    .wallet-info { display: flex; flex-direction: column; gap: 4px; }
    .wallet-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
    .wallet-addr { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--text-secondary); }
    .wallet-balance {
      text-align: right;
    }
    .wallet-balance .amount {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2rem;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.1;
    }
    .wallet-balance .currency { font-size: 0.85rem; color: var(--text-muted); font-weight: 500; margin-top: 2px; }

    /* ─── Section titles ─── */
    .section-title {
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--text-muted); margin-bottom: 12px; padding-left: 2px;
    }

    /* ─── Card grid ─── */
    .grid { display: grid; gap: 12px; margin-bottom: 24px; }
    .grid-4 { grid-template-columns: repeat(4, 1fr); }
    .grid-3 { grid-template-columns: repeat(3, 1fr); }

    @media (max-width: 768px) {
      .grid-4 { grid-template-columns: repeat(2, 1fr); }
      .grid-3 { grid-template-columns: repeat(2, 1fr); }
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
      transition: background 0.2s, border-color 0.2s;
    }
    .card:hover { background: var(--bg-card-hover); border-color: var(--border-light); }
    .card .label {
      font-size: 0.68rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--text-muted); margin-bottom: 8px;
    }
    .card .value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.35rem; font-weight: 700; color: var(--text-primary);
    }
    .card .sub {
      font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;
      font-family: 'JetBrains Mono', monospace;
    }

    /* Highlight card */
    .card-accent {
      border-color: rgba(59,130,246,0.3);
      background: linear-gradient(135deg, rgba(59,130,246,0.06), var(--bg-card));
    }

    /* ─── Window progress bar ─── */
    .progress-bar-container {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 18px;
      margin-bottom: 24px;
    }
    .progress-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .progress-header .label { font-size: 0.72rem; color: var(--text-muted); font-weight: 500; }
    .progress-header .time { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--text-secondary); font-weight: 600; }
    .progress-track { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 1s linear; }

    /* ─── Status message ─── */
    .status-msg {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 0 10px 10px 0;
      padding: 14px 18px;
      margin-bottom: 24px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    /* ─── Scan table ─── */
    .scan-panel {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 24px;
    }
    .scan-summary { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 14px; }
    .scan-stat { font-size: 0.78rem; color: var(--text-secondary); }
    .scan-stat strong { color: var(--text-primary); font-family: 'JetBrains Mono', monospace; }
    .scan-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .scan-table th {
      text-align: left; padding: 8px 10px;
      font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--text-muted); border-bottom: 1px solid var(--border);
    }
    .scan-table td {
      padding: 7px 10px; border-bottom: 1px solid rgba(42,48,80,0.5);
      color: var(--text-secondary); font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
      max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .scan-table tr:last-child td { border-bottom: none; }
    .tag-15m { background: rgba(16,185,129,0.15); color: #10b981; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
    .tag-crypto { background: rgba(99,102,241,0.15); color: #818cf8; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
    .tag-reject { background: rgba(239,68,68,0.15); color: #f87171; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
    .scan-empty { text-align: center; padding: 20px; color: var(--text-muted); font-size: 0.82rem; }

    /* ─── Top strip (emergency stop + market title) ─── */
    .top-strip {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 22px;
    }
    .top-market-title {
      font-size: 1.06rem;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.5;
      text-align: center;
      padding: 16px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
    }

    /* ─── Controls ─── */
    .controls {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 24px; flex-wrap: wrap;
    }
    .controls.controls-at-top {
      justify-content: center;
      margin-bottom: 0;
    }
    .btn {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 10px 22px; border: none; border-radius: 10px;
      font-size: 0.82rem; font-weight: 600; cursor: pointer;
      color: white; transition: all 0.2s; font-family: 'Inter', sans-serif;
    }
    .btn-danger { background: linear-gradient(135deg, #dc2626, #b91c1c); }
    .btn-danger:hover { background: linear-gradient(135deg, #ef4444, #dc2626); box-shadow: 0 4px 15px rgba(220,38,38,0.3); }
    .btn-success { background: linear-gradient(135deg, #059669, #047857); }
    .btn-success:hover { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 15px rgba(5,150,105,0.3); }
    .btn-hint { font-size: 0.72rem; color: var(--text-muted); }

    /* ─── Footer ─── */
    .footer {
      text-align: center; font-size: 0.72rem; color: var(--text-muted);
      padding-top: 20px; border-top: 1px solid var(--border);
      display: flex; justify-content: center; gap: 16px; flex-wrap: wrap;
    }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="app">

    <!-- Emergency stop + market window (top) -->
    <div class="top-strip">
      <div class="controls controls-at-top">
        <form method="post" action="/killSwitch" style="display:inline">
          <input type="hidden" name="on" value="${s.killSwitch ? '0' : '1'}" />
          <button type="submit" class="btn ${s.killSwitch ? 'btn-success' : 'btn-danger'}">
            ${s.killSwitch ? 'Resume Trading' : 'Emergency Stop'}
          </button>
        </form>
        <span class="btn-hint">Stops new orders without shutting down the bot. Ctrl+C to fully stop.</span>
      </div>
      <div class="top-market-title">${marketHeadlineHtml(s)}</div>
    </div>

    <!-- Header -->
    <div class="header">
      <div class="header-left">
        <div class="logo">H</div>
        <div>
          <h1>Polymarket Hedge Bot</h1>
          <div class="tagline">15-minute crypto arbitrage &mdash; pair cost &lt; $1.00</div>
        </div>
      </div>
      <div class="header-badges">
        <span class="badge ${s.running ? 'badge-running' : 'badge-stopped'}">
          <span class="badge-dot ${s.running ? 'animate' : ''}" style="background:${statusColor}"></span>
          ${s.running ? 'Running' : 'Stopped'}
        </span>
        <span class="badge ${s.liveTrading ? 'badge-live' : 'badge-paper'}">
          <span class="badge-dot" style="background:${modeColor}"></span>
          ${modeLabel}
        </span>
        <span class="badge ${s.killSwitch ? 'badge-kill-on' : 'badge-kill-off'}">
          Kill Switch: ${s.killSwitch ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>

    <!-- Wallet Banner -->
    <div class="wallet-banner" style="flex-direction:column;gap:18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%;flex-wrap:wrap;gap:12px;">
        <div style="display:flex;gap:28px;flex-wrap:wrap;">
          <div class="wallet-info">
            <span class="wallet-label">Public Wallet (MetaMask)</span>
            <span class="wallet-addr">${shortAddr(s.walletAddress)}</span>
          </div>
          <div class="wallet-info">
            <span class="wallet-label">Proxy Wallet (Polymarket)</span>
            <span class="wallet-addr">${shortAddr(s.proxyWalletAddress)}</span>
          </div>
          <div class="wallet-info">
            <span class="wallet-label">Uptime</span>
            <span class="wallet-addr">${formatUptime(s.uptimeSeconds)}</span>
          </div>
        </div>
        <div class="wallet-balance">
          <div class="amount">$${s.portfolioValueUsd.toFixed(2)}</div>
          <div class="currency">Total Value (USDC + positions)</div>
        </div>
      </div>
      ${(() => {
        const positionValue = s.positionValueUsd;
        const positionCost = s.positionCostUsd;
        const unrealizedPL = s.unrealizedPnlUsd;
        const sessionPnl = s.sessionPnlUsd;
        const unrealColor = unrealizedPL >= 0 ? '#10b981' : '#ef4444';
        const sessionColor = sessionPnl >= 0 ? '#10b981' : '#ef4444';
        const hasPositions = s.qtyYes > 0 || s.qtyNo > 0 || s.actualQtyYes > 0 || s.actualQtyNo > 0;
        return `
      <div style="display:flex;gap:12px;width:100%;flex-wrap:wrap;">
        <div style="flex:1;min-width:180px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:10px;padding:14px 18px;">
          <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:500;margin-bottom:6px;">Polymarket USDC</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#10b981;">$${polyBalStr}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Proxy wallet &mdash; for trading</div>
          ${(() => {
            if (!s.balanceLastCheckedIso) return '';
            const ageS = Math.floor((Date.now() - new Date(s.balanceLastCheckedIso).getTime()) / 1000);
            const ageColor = ageS <= 15 ? '#10b981' : ageS <= 30 ? '#f59e0b' : '#ef4444';
            return '<div style="font-size:0.65rem;color:' + ageColor + ';margin-top:3px;">checked ' + ageS + 's ago</div>';
          })()}
        </div>
        ${hasPositions ? `
        <div style="flex:1;min-width:180px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:10px;padding:14px 18px;">
          <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:500;margin-bottom:6px;">Open Positions Value</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#f59e0b;">$${positionValue.toFixed(2)}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">
            ${s.qtyYes.toFixed(0)} UP &times; $${s.liveBestBidYes.toFixed(2)} + ${s.qtyNo.toFixed(0)} DN &times; $${s.liveBestBidNo.toFixed(2)}
          </div>
          <div style="font-size:0.72rem;color:${unrealColor};font-weight:600;margin-top:4px;">
            Position P/L: ${unrealizedPL >= 0 ? '+' : ''}$${unrealizedPL.toFixed(2)} vs $${positionCost.toFixed(2)} cost
          </div>
          <div style="font-size:0.72rem;color:${sessionColor};font-weight:600;margin-top:2px;">
            Session P/L: ${sessionPnl >= 0 ? '+' : ''}$${sessionPnl.toFixed(2)} vs start $${s.sessionStartPortfolioUsd.toFixed(2)}
          </div>
        </div>` : ''}
        <div style="flex:1;min-width:180px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:10px;padding:14px 18px;">
          <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:500;margin-bottom:6px;">MetaMask Wallet</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#3b82f6;">$${walletBalStr}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Public wallet &mdash; available to deposit</div>
        </div>
      </div>`;
      })()}
    </div>

    <!-- Window Progress -->
    ${s.windowEndIso ? `
    <div class="progress-bar-container">
      <div class="progress-header">
        <span class="label">Window: ${s.marketSlug ?? '—'}</span>
        <span class="time">${windowTimeLeft > 0 ? windowTimeLeft + 's remaining' : 'Ended'} &mdash; ends ${new Date(s.windowEndIso).toLocaleTimeString()}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${windowProgress.toFixed(1)}%"></div>
      </div>
    </div>
    ` : `
    <div class="progress-bar-container">
      <div class="progress-header">
        <span class="label">No active window</span>
        <span class="time">Waiting for 15m market...</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:0%"></div>
      </div>
    </div>
    `}

    <!-- Current Window Metrics -->
    ${(() => {
      const matchedQty = Math.min(s.qtyYes, s.qtyNo);
      const matchedCost = matchedQty > 0 && s.qtyYes > 0 && s.qtyNo > 0
          ? matchedQty * s.avgYes + matchedQty * s.avgNo : 0;
      const matchedPayout = matchedQty;
      const matchedGross = matchedPayout - matchedCost;
      const matchedFee = matchedCost * ((s.feeBipsAssumption || 0) / 10000);
      const matchedNet = matchedGross - matchedFee;
      const matchedColor = matchedNet >= 0 ? '#10b981' : '#ef4444';

      const excessQty = Math.abs(s.qtyYes - s.qtyNo);
      const excessSide = s.qtyYes > s.qtyNo ? 'UP' : 'DOWN';
      const excessAvg = s.qtyYes > s.qtyNo ? s.avgYes : s.avgNo;
      const excessCost = excessQty * excessAvg;
      const excessColor = excessQty > 0 ? '#f59e0b' : '#10b981';
      const excessLabel = excessQty > 0
          ? excessQty.toFixed(1) + ' ' + excessSide
          : 'Balanced';

      return `
    <div class="section-title">Current Window</div>
    <div class="grid grid-4">
      <div class="card card-accent">
        <div class="label">Pair Cost</div>
        <div class="value" style="color:${pairColor}">${s.pairCost.toFixed(4)}</div>
        <div class="sub">target &lt; $1.00</div>
      </div>
      <div class="card">
        <div class="label">Matched Profit</div>
        <div class="value" style="color:${matchedColor}">$${matchedNet.toFixed(2)}</div>
        <div class="sub">${matchedQty.toFixed(0)} pairs @ $${s.pairCost > 0 ? s.pairCost.toFixed(4) : '—'}</div>
      </div>
      <div class="card">
        <div class="label">Unmatched Exposure</div>
        <div class="value" style="color:${excessColor}">${excessLabel}</div>
        <div class="sub">${excessQty > 0 ? '$' + excessCost.toFixed(2) + ' catching up' : 'all paired'}</div>
      </div>
      <div class="card">
        <div class="label">Tracked Qty Up / Down</div>
        <div class="value">${s.trackedQtyYes.toFixed(1)} / ${s.trackedQtyNo.toFixed(1)}</div>
        <div class="sub">Actual wallet: ${s.actualQtyYes.toFixed(1)} / ${s.actualQtyNo.toFixed(1)}</div>
        <div class="sub">spent $${s.totalSpentUsd.toFixed(2)} / $${s.maxPositionPerWindowUsd.toFixed(0)}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:14px;">
      <div class="card" style="border-color:rgba(59,130,246,0.35);">
        <div class="label">After PnL If Up</div>
        <div class="value" style="color:${s.afterPnlIfUpUsd >= 0 ? '#10b981' : '#ef4444'};">
          ${s.afterPnlIfUpUsd >= 0 ? '+' : ''}$${s.afterPnlIfUpUsd.toFixed(2)}
        </div>
        <div class="sub">If YES wins: $${s.qtyYes.toFixed(0)} payout &minus; $${s.totalSpentUsd.toFixed(2)} spent</div>
      </div>
      <div class="card" style="border-color:rgba(139,92,246,0.35);">
        <div class="label">After PnL If Down</div>
        <div class="value" style="color:${s.afterPnlIfDownUsd >= 0 ? '#10b981' : '#ef4444'};">
          ${s.afterPnlIfDownUsd >= 0 ? '+' : ''}$${s.afterPnlIfDownUsd.toFixed(2)}
        </div>
        <div class="sub">If NO wins: $${s.qtyNo.toFixed(0)} payout &minus; $${s.totalSpentUsd.toFixed(2)} spent</div>
      </div>
    </div>`;
    })()}

    <!-- Active Pair Position (shows when we have filled shares) -->
    ${(s.qtyYes > 0 || s.qtyNo > 0) ? (() => {
      const hasBoth = s.qtyYes > 0 && s.qtyNo > 0;
      const minQty = Math.min(s.qtyYes, s.qtyNo);
      const totalCost = s.costYes + s.costNo;

      // MATCHED pairs P/L (the REAL profit indicator)
      const matchedCostYes = minQty * s.avgYes;
      const matchedCostNo  = minQty * s.avgNo;
      const matchedCost    = matchedCostYes + matchedCostNo;
      const matchedPayout  = minQty;
      const matchedGross   = matchedPayout - matchedCost;
      const matchedFee     = matchedCost * ((s.feeBipsAssumption || 0) / 10000);
      const matchedNet     = matchedGross - matchedFee;
      const matchedNetColor = matchedNet >= 0 ? '#10b981' : '#ef4444';

      // UNMATCHED excess shares (temporary — catching up)
      const excessQty  = Math.abs(s.qtyYes - s.qtyNo);
      const excessSide = s.qtyYes > s.qtyNo ? 'UP (YES)' : 'DOWN (NO)';
      const excessAvg  = s.qtyYes > s.qtyNo ? s.avgYes : s.avgNo;
      const excessCost = excessQty * excessAvg;

      // Worst case = if unmatched shares are worth $0
      const worstCase  = matchedNet - excessCost;
      const worstColor = worstCase >= 0 ? '#10b981' : '#ef4444';

      const yesLive = s.liveBestBidYes;
      const noLive = s.liveBestBidNo;
      const yesDiff = s.avgYes > 0 ? (yesLive - s.avgYes) : 0;
      const noDiff = s.avgNo > 0 ? (noLive - s.avgNo) : 0;
      const yesDiffColor = yesDiff >= 0 ? '#10b981' : '#ef4444';
      const noDiffColor = noDiff >= 0 ? '#10b981' : '#ef4444';
      const yesArrow = yesDiff >= 0 ? '&#9650;' : '&#9660;';
      const noArrow = noDiff >= 0 ? '&#9650;' : '&#9660;';

      return `
    <div class="section-title">Active Pair Position</div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">

      <!-- YES and NO side-by-side cards -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">

        <!-- YES (Up) Card -->
        <div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.2);border-radius:10px;padding:16px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
            <span style="background:#3b82f6;color:white;font-size:0.68rem;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.05em;">UP (YES)</span>
            <span style="font-size:0.7rem;color:var(--text-muted);">${s.qtyYes > 0 ? 'FILLED' : 'EMPTY'}</span>
          </div>
          ${s.qtyYes > 0 ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Shares</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">${s.qtyYes}</div>
              <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Actual: ${s.actualQtyYes.toFixed(1)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Total Cost</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">$${s.costYes.toFixed(2)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Entry Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:var(--text-primary);">$${s.avgYes.toFixed(4)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Live Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:${yesDiffColor};">$${yesLive.toFixed(4)}</div>
              <div style="font-size:0.75rem;color:${yesDiffColor};font-family:'JetBrains Mono',monospace;margin-top:2px;">
                ${yesArrow} ${yesDiff >= 0 ? '+' : ''}${yesDiff.toFixed(4)}
              </div>
            </div>
          </div>
          ` : `
          <div style="text-align:center;padding:12px;color:var(--text-muted);font-size:0.82rem;">No YES shares yet</div>
          `}
        </div>

        <!-- NO (Down) Card -->
        <div style="background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.2);border-radius:10px;padding:16px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
            <span style="background:#8b5cf6;color:white;font-size:0.68rem;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.05em;">DOWN (NO)</span>
            <span style="font-size:0.7rem;color:var(--text-muted);">${s.qtyNo > 0 ? 'FILLED' : 'EMPTY'}</span>
          </div>
          ${s.qtyNo > 0 ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Shares</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">${s.qtyNo}</div>
              <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Actual: ${s.actualQtyNo.toFixed(1)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Total Cost</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.2rem;font-weight:700;">$${s.costNo.toFixed(2)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Entry Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:var(--text-primary);">$${s.avgNo.toFixed(4)}</div>
            </div>
            <div>
              <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Live Price</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:${noDiffColor};">$${noLive.toFixed(4)}</div>
              <div style="font-size:0.75rem;color:${noDiffColor};font-family:'JetBrains Mono',monospace;margin-top:2px;">
                ${noArrow} ${noDiff >= 0 ? '+' : ''}${noDiff.toFixed(4)}
              </div>
            </div>
          </div>
          ` : `
          <div style="text-align:center;padding:12px;color:var(--text-muted);font-size:0.82rem;">No NO shares yet</div>
          `}
        </div>
      </div>

      <!-- Summary bar at bottom -->
      <div style="background:rgba(0,0,0,0.25);border-radius:10px;padding:14px 18px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div style="display:flex;gap:20px;flex-wrap:wrap;">
            <div style="text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Matched Pairs</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:#10b981;">${minQty.toFixed(0)}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">cost $${matchedCost.toFixed(2)} &rarr; payout $${matchedPayout.toFixed(2)}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Pair Cost</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:${s.pairCost < 1.0 ? '#10b981' : '#ef4444'};">${s.pairCost.toFixed(4)}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">avg $${s.avgYes.toFixed(2)} + $${s.avgNo.toFixed(2)}</div>
            </div>
            ${excessQty > 0 ? `
            <div style="text-align:center;">
              <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Unmatched</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:700;color:#f59e0b;">${excessQty.toFixed(1)} ${excessSide}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">$${excessCost.toFixed(2)} catching up</div>
            </div>` : ''}
          </div>
          <div style="text-align:center;min-width:150px;">
            <div style="font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px;">Matched Net Profit</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:1.6rem;font-weight:700;color:${matchedNetColor};">${matchedNet >= 0 ? '+' : ''}$${matchedNet.toFixed(2)}</div>
            <div style="font-size:0.65rem;color:var(--text-muted);">gross $${matchedGross.toFixed(2)} &minus; fee ~$${matchedFee.toFixed(2)}</div>
            ${excessQty > 0 ? `<div style="font-size:0.62rem;color:${worstColor};margin-top:3px;">worst case: $${worstCase.toFixed(2)}</div>` : ''}
          </div>
        </div>
        ${!hasBoth ? '<div style="margin-top:10px;text-align:center;font-size:0.75rem;color:#f59e0b;font-weight:500;">&#9888; Only one side filled &mdash; bot is placing the other side to catch up</div>' : ''}
        ${hasBoth && excessQty > 0 ? '<div style="margin-top:10px;text-align:center;font-size:0.75rem;color:#f59e0b;font-weight:500;">&#9888; ' + excessQty.toFixed(0) + ' unmatched ' + excessSide + ' shares &mdash; bot is catching up on the other side</div>' : ''}
        ${hasBoth && excessQty === 0 ? '<div style="margin-top:10px;text-align:center;font-size:0.75rem;color:#10b981;font-weight:500;">&#9989; Perfectly hedged &mdash; all shares are paired</div>' : ''}
      </div>
    </div>`;
    })() : ''}

    ${(() => {
        if (!s.windowEndIso) return '';
        const windowOrders = getOrdersForWindow(s.windowEndIso)
            .slice()
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        if (windowOrders.length === 0) return '';
        let runY = 0;
        let runN = 0;
        let runSpent = 0;
        let rows = '';
        for (let i = 0; i < windowOrders.length; i++) {
            const o = windowOrders[i];
            runSpent += o.costUsd;
            if (o.side === 'YES') runY += o.size;
            else runN += o.size;
            const pUp = runY - runSpent;
            const pDown = runN - runSpent;
            const cUp = pUp >= 0 ? '#10b981' : '#ef4444';
            const cDown = pDown >= 0 ? '#10b981' : '#ef4444';
            rows += '<tr style="border-bottom:1px solid rgba(42,48,80,0.5);">' +
                '<td style="padding:8px 10px;">' + (i + 1) + '</td>' +
                '<td style="padding:8px 10px;">' + new Date(o.timestamp).toLocaleTimeString() + '</td>' +
                '<td style="padding:8px 10px;">' + o.sideLabel + '</td>' +
                '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;">' + o.size + '</td>' +
                '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;">$' + o.price.toFixed(4) + '</td>' +
                '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;">$' + o.costUsd.toFixed(2) + '</td>' +
                '<td style="padding:8px 10px;font-weight:600;color:' + cUp + ';font-family:\'JetBrains Mono\',monospace;">' +
                (pUp >= 0 ? '+' : '') + '$' + pUp.toFixed(2) + '</td>' +
                '<td style="padding:8px 10px;font-weight:600;color:' + cDown + ';font-family:\'JetBrains Mono\',monospace;">' +
                (pDown >= 0 ? '+' : '') + '$' + pDown.toFixed(2) + '</td>' +
                '</tr>';
        }
        return `
    <div class="section-title">After each purchase &mdash; settlement P/L</div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">
      <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;">
        Running totals after each recorded fill (paper session). <strong>After PnL If Up</strong> = cumulative Up shares &times; $1 &minus; cumulative spend;
        <strong>After PnL If Down</strong> = cumulative Down shares &times; $1 &minus; cumulative spend. Fees not included.
      </div>
      <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:0.78rem;min-width:640px;">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border);">
          <th style="padding:8px 10px;">#</th>
          <th style="padding:8px 10px;">Time</th>
          <th style="padding:8px 10px;">Side</th>
          <th style="padding:8px 10px;">Size</th>
          <th style="padding:8px 10px;">Price</th>
          <th style="padding:8px 10px;">Cost</th>
          <th style="padding:8px 10px;">After PnL If Up</th>
          <th style="padding:8px 10px;">After PnL If Down</th>
        </tr></thead>
        <tbody>` + rows + `</tbody>
      </table>
      </div>
    </div>`;
    })()}

    <!-- Session & Risk -->
    <div class="section-title">Session &amp; Risk</div>
    <div class="grid grid-4">
      <div class="card">
        <div class="label">Cumulative P/L</div>
        <div class="value" style="color:${cumulColor}">$${s.cumulativeProfitUsd.toFixed(2)}</div>
      </div>
      <div class="card">
        <div class="label">Windows Completed</div>
        <div class="value">${s.completedWindows}</div>
      </div>
      <div class="card">
        <div class="label">Pending / Failures</div>
        <div class="value" style="color:${s.pendingOrders > 0 ? '#f59e0b' : s.consecutiveFailures > 0 ? '#ef4444' : 'var(--text-secondary)'}">
          ${s.pendingOrders} / ${s.consecutiveFailures}
        </div>
        <div class="sub">redeem queue ${s.redeemQueueSize}</div>
        <div class="sub">last sweep: ${s.lastRedeemSweepIso ? new Date(s.lastRedeemSweepIso).toLocaleTimeString() : '—'} (${s.lastRedeemSweepResult})</div>
      </div>
    </div>

    ${!s.liveTrading ? (() => {
      const simBal = getSimulatedBalance();
      const h24 = getLast24hSummary();
      const wins = getCompletedWindowsDetail();
      const netColor24 = h24.netProfit >= 0 ? '#10b981' : '#ef4444';
      let historyHtml = '<div class="section-title">📋 Paper Trading — Trading History</div>';
      historyHtml += '<div style="background:linear-gradient(135deg,rgba(99,102,241,0.12),rgba(139,92,246,0.08));border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">';
      historyHtml += '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:16px;">';
      historyHtml += '<div><span style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;">Simulated balance</span><div style="font-family:\'JetBrains Mono\',monospace;font-size:1.6rem;font-weight:700;color:#6366f1;">$' + simBal.toFixed(2) + '</div></div>';
      historyHtml += '<div style="margin-left:20px;padding-left:20px;border-left:1px solid var(--border);"><span style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;">Last 24h</span>';
      historyHtml += '<div style="font-size:0.85rem;">Windows: <strong>' + h24.windowsCount + '</strong> &nbsp;|&nbsp; Orders: <strong>' + h24.ordersCount + '</strong> &nbsp;|&nbsp; Spent: $' + h24.totalSpent.toFixed(2) + ' &nbsp;|&nbsp; Payout: $' + h24.totalPayout.toFixed(2) + '</div>';
      historyHtml += '<div style="font-size:1rem;font-weight:700;color:' + netColor24 + ';">Net P/L: ' + (h24.netProfit >= 0 ? '+' : '') + '$' + h24.netProfit.toFixed(2) + '</div></div>';
      historyHtml += '</div>';
      historyHtml += '<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;">Each row is one market window. Expand to see orders (time, side, price, size, cost, win/lose, P/L).</div>';
      historyHtml += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
      historyHtml += '<thead><tr style="text-align:left;border-bottom:1px solid var(--border);">';
      historyHtml += '<th style="padding:8px 10px;">Window end</th><th style="padding:8px 10px;">Market</th><th style="padding:8px 10px;"># Orders</th>';
      historyHtml += '<th style="padding:8px 10px;">Winner</th><th style="padding:8px 10px;">Spent</th><th style="padding:8px 10px;">Payout</th><th style="padding:8px 10px;">Net P/L</th><th style="padding:8px 10px;">Balance</th><th style="padding:8px 10px;"></th></tr></thead><tbody>';
      wins.slice().reverse().forEach((w, idx) => {
        const netColor = w.netProfit >= 0 ? '#10b981' : '#ef4444';
        const rowId = 'wh-' + idx;
        historyHtml += '<tr style="border-bottom:1px solid rgba(42,48,80,0.5);">';
        historyHtml += '<td style="padding:8px 10px;">' + new Date(w.windowEndIso).toLocaleString() + '</td>';
        historyHtml += '<td style="padding:8px 10px;">' + (w.windowSlug || w.windowEndIso).slice(0, 28) + '</td>';
        historyHtml += '<td style="padding:8px 10px;">' + w.orderCount + '</td>';
        const winnerLabel = w.winnerSide === 'YES' ? 'Up' : w.winnerSide === 'NO' ? 'Down' : '—';
        historyHtml += '<td style="padding:8px 10px;">' + winnerLabel + '</td>';
        historyHtml += '<td style="padding:8px 10px;">$' + w.totalSpentUsd.toFixed(2) + '</td>';
        historyHtml += '<td style="padding:8px 10px;">$' + w.payoutReceived.toFixed(2) + '</td>';
        historyHtml += '<td style="padding:8px 10px;font-weight:600;color:' + netColor + '">' + (w.netProfit >= 0 ? '+' : '') + '$' + w.netProfit.toFixed(2) + '</td>';
        historyHtml += '<td style="padding:8px 10px;">$' + (w.balanceAfterUsd ?? 0).toFixed(2) + '</td>';
        historyHtml += '<td style="padding:8px 10px;"><button type="button" onclick="var r=document.getElementById(\'' + rowId + '\'); r.style.display=r.style.display===\'none\'?\'\':\'none\';" style="background:var(--border);border:none;color:var(--text-secondary);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:0.7rem;">Orders</button></td></tr>';
        historyHtml += '<tr id="' + rowId + '" style="display:none;"><td colspan="9" style="padding:0 10px 12px;background:rgba(0,0,0,0.2);">';
        historyHtml += '<table style="width:100%;font-size:0.72rem;margin-top:8px;"><tr style="color:var(--text-muted);"><th style="text-align:left;padding:4px 8px;">Time</th><th style="padding:4px 8px;">Side</th><th style="padding:4px 8px;">Price</th><th style="padding:4px 8px;">Size</th><th style="padding:4px 8px;">Cost</th><th style="padding:4px 8px;">Result</th><th style="padding:4px 8px;">P/L</th></tr>';
        w.orders.forEach(o => {
          const resolved = o.winnerSide ? true : false;
          const won = resolved && o.side === o.winnerSide;
          const resLabel = !resolved ? '—' : won ? 'WIN' : 'LOSE';
          const pnl = (o.realizedPnlUsd ?? 0);
          const pnlColor = !resolved ? 'var(--text-muted)' : pnl >= 0 ? '#10b981' : '#ef4444';
          historyHtml += '<tr><td style="padding:4px 8px;">' + new Date(o.timestamp).toLocaleTimeString() + '</td>' +
            '<td style="padding:4px 8px;">' + o.sideLabel + '</td>' +
            '<td style="padding:4px 8px;">$' + o.price.toFixed(4) + '</td>' +
            '<td style="padding:4px 8px;">' + o.size + '</td>' +
            '<td style="padding:4px 8px;">$' + o.costUsd.toFixed(2) + '</td>' +
            '<td style="padding:4px 8px;">' + resLabel + '</td>' +
            '<td style="padding:4px 8px;font-weight:600;color:' + pnlColor + ';">' + (!resolved ? '—' : (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)) + '</td></tr>';
        });
        historyHtml += '</table></td></tr>';
      });
      historyHtml += '</tbody></table></div>';
      return historyHtml;
    })() : ''}

    <!-- Status message -->
    <div class="status-msg">${s.message}</div>

    <!-- Your Orders vs Market -->
    ${(s.entryOrderYes || s.entryOrderNo) ? (() => {
      const rows: string[] = [];
      if (s.entryOrderYes) {
        const entry = s.entryOrderYes.price;
        const current = s.liveBestBidYes;
        const diff = current - entry;
        const diffColor = diff >= 0 ? '#10b981' : '#ef4444';
        const arrow = diff >= 0 ? '&#9650;' : '&#9660;';
        const age = Math.floor((Date.now() - new Date(s.entryOrderYes.placedAt).getTime()) / 1000);
        rows.push('<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' +
          'background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:8px;flex-wrap:wrap;gap:8px;">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<span style="font-size:0.72rem;font-weight:600;color:#3b82f6;min-width:60px;">UP (YES)</span>' +
            '<span style="font-size:0.65rem;color:var(--text-muted);">Entry:</span>' +
            '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:var(--text-primary);">$' + entry.toFixed(2) + '</span>' +
            '<span style="font-size:0.65rem;color:var(--text-muted);">&rarr; Now:</span>' +
            '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:' + diffColor + ';">$' + current.toFixed(2) + '</span>' +
            '<span style="font-size:0.82rem;color:' + diffColor + ';">' + arrow + ' ' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + '</span>' +
          '</div>' +
          '<div style="font-size:0.7rem;color:var(--text-muted);">' + s.entryOrderYes.size + ' shares &middot; ' + age + 's ago</div>' +
        '</div>');
      }
      if (s.entryOrderNo) {
        const entry = s.entryOrderNo.price;
        const current = s.liveBestBidNo;
        const diff = current - entry;
        const diffColor = diff >= 0 ? '#10b981' : '#ef4444';
        const arrow = diff >= 0 ? '&#9650;' : '&#9660;';
        const age = Math.floor((Date.now() - new Date(s.entryOrderNo.placedAt).getTime()) / 1000);
        rows.push('<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;' +
          'background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.15);border-radius:8px;flex-wrap:wrap;gap:8px;">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<span style="font-size:0.72rem;font-weight:600;color:#8b5cf6;min-width:60px;">DOWN (NO)</span>' +
            '<span style="font-size:0.65rem;color:var(--text-muted);">Entry:</span>' +
            '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:var(--text-primary);">$' + entry.toFixed(2) + '</span>' +
            '<span style="font-size:0.65rem;color:var(--text-muted);">&rarr; Now:</span>' +
            '<span style="font-family:JetBrains Mono,monospace;font-size:1rem;font-weight:700;color:' + diffColor + ';">$' + current.toFixed(2) + '</span>' +
            '<span style="font-size:0.82rem;color:' + diffColor + ';">' + arrow + ' ' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + '</span>' +
          '</div>' +
          '<div style="font-size:0.7rem;color:var(--text-muted);">' + s.entryOrderNo.size + ' shares &middot; ' + age + 's ago</div>' +
        '</div>');
      }
      return '<div class="section-title">Your Pending Orders vs Market</div>' +
        '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:24px;display:flex;flex-direction:column;gap:10px;">' +
        rows.join('') +
        '<div style="font-size:0.68rem;color:var(--text-muted);text-align:center;padding-top:4px;">' +
          'Entry = your limit buy price &nbsp;|&nbsp; Now = current best bid &nbsp;|&nbsp; ' +
          '<span style="color:#10b981;">&#9650; Green = market moved up (closer to fill)</span> &nbsp; ' +
          '<span style="color:#ef4444;">&#9660; Red = market moved down</span>' +
        '</div></div>';
    })() : ''}

    <!-- Live Market Prices -->
    <div class="section-title">Live Market Prices (Orderbook)</div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:24px;">
      ${(s.liveBestBidYes > 0 || s.liveBestBidNo > 0) ? (() => {
        const bidCombined = s.liveCombinedBid;
        const askCombined = s.liveCombinedAsk;
        const ceiling = s.livePairCostCeiling;
        const gap = ceiling - bidCombined;
        const isProfitable = bidCombined > 0 && bidCombined < ceiling && bidCombined < 1.0;
        const barColor = isProfitable ? '#10b981' : bidCombined >= 1.0 ? '#ef4444' : '#f59e0b';
        const statusText = isProfitable
          ? 'PROFITABLE — bot is placing maker orders!'
          : bidCombined >= 1.0
            ? 'LOSING — bids sum >= $1.00'
            : 'TOO TIGHT — bids sum > ceiling';
        const statusIcon = isProfitable ? '&#9989;' : '&#10060;';
        return `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">
          <div style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:10px;padding:14px;">
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;text-align:center;">UP (YES)</div>
            <div style="display:flex;justify-content:space-around;">
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">BID (our price)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#10b981;">$${s.liveBestBidYes.toFixed(2)}</div>
              </div>
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">ASK (taker)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#ef4444;">$${s.liveBestAskYes.toFixed(2)}</div>
              </div>
            </div>
          </div>
          <div style="background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.15);border-radius:10px;padding:14px;">
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;text-align:center;">DOWN (NO)</div>
            <div style="display:flex;justify-content:space-around;">
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">BID (our price)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#10b981;">$${s.liveBestBidNo.toFixed(2)}</div>
              </div>
              <div style="text-align:center;">
                <div style="font-size:0.62rem;color:var(--text-muted);margin-bottom:4px;">ASK (taker)</div>
                <div style="font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:700;color:#ef4444;">$${s.liveBestAskNo.toFixed(2)}</div>
              </div>
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
          <div style="text-align:center;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:8px;padding:10px;">
            <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">OUR COST (Maker Bids)</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:${barColor};">$${bidCombined.toFixed(4)}</div>
          </div>
          <div style="text-align:center;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.15);border-radius:8px;padding:10px;">
            <div style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">TAKER COST (Asks) — never profitable</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:#ef4444;">$${askCombined.toFixed(4)}</div>
          </div>
        </div>
        <div style="background:rgba(0,0,0,0.2);border-radius:8px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:1.1rem;">${statusIcon}</span>
            <span style="font-size:0.82rem;font-weight:600;color:${barColor};">${statusText}</span>
          </div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--text-secondary);">
            Ceiling: $${ceiling.toFixed(4)} &nbsp;|&nbsp; Gap: <span style="color:${gap >= 0 ? '#10b981' : '#ef4444'};">${gap >= 0 ? '+' : ''}$${gap.toFixed(4)}</span>
            &nbsp;|&nbsp; Profit/share: <span style="color:${(1.0 - bidCombined) > 0 ? '#10b981' : '#ef4444'};">$${(1.0 - bidCombined).toFixed(4)}</span>
            &nbsp;|&nbsp; Min shares: ${s.liveEffectiveMinShares}
          </div>
        </div>`;
      })() : `
        <div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.85rem;">
          Waiting for orderbook data...
        </div>
      `}
    </div>

    <!-- BTC 15m Market Status -->
    <div class="section-title">Bitcoin 15-Minute Market</div>
    <div class="scan-panel">
      <div class="scan-summary">
        <span class="scan-stat">Last check: <strong>${s.scanTimestamp ? new Date(s.scanTimestamp).toLocaleTimeString() : '—'}</strong></span>
        <span class="scan-stat">Windows checked: <strong>${s.scanSlugsChecked.length}</strong></span>
        <span class="scan-stat">Exist on API: <strong>${s.scanTotalApiFetched}</strong></span>
        <span class="scan-stat">Tradeable: <strong style="color:${s.scanMarketsReturned > 0 ? '#10b981' : '#f59e0b'}">${s.scanMarketsReturned}</strong></span>
        ${s.scanError ? '<span class="scan-stat" style="color:#ef4444">Error: <strong>' + s.scanError + '</strong></span>' : ''}
      </div>

      ${s.scanActiveMarket ? `
      <div style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:10px;padding:16px 20px;margin-top:12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse-dot 2s ease-in-out infinite;"></span>
          <span style="font-size:0.85rem;font-weight:600;color:#10b981;">ACTIVE MARKET FOUND</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Market</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--text-primary);">${s.scanActiveMarket.question.slice(0, 60)}</div>
          </div>
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Slug</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--text-secondary);">${s.scanActiveMarket.slug}</div>
          </div>
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Window Ends</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--text-primary);">${new Date(s.scanActiveMarket.endTime).toLocaleTimeString()}</div>
          </div>
          <div>
            <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Time Remaining</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:#f59e0b;font-weight:700;">${s.scanActiveMarket.secondsLeft}s</div>
          </div>
        </div>
      </div>
      ` : `
      <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:10px;padding:20px;margin-top:12px;text-align:center;">
        <div style="font-size:1.2rem;margin-bottom:8px;">&#9202;</div>
        <div style="font-size:0.88rem;font-weight:600;color:#f59e0b;margin-bottom:6px;">No Active BTC 15m Market</div>
        <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.6;">
          Polling every 5s. Checked slugs:<br>
          ${s.scanSlugsChecked.length > 0
            ? s.scanSlugsChecked.map(sl => '<code style="font-size:0.72rem;background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;">' + sl + '</code>').join(' ')
            : '<em>waiting for first scan...</em>'}
          <br><br>
          <a href="https://polymarket.com/crypto/15M" target="_blank" style="color:var(--accent);">polymarket.com/crypto/15M</a>
        </div>
      </div>
      `}

      ${s.scanRejected.length > 0 ? `
      <div style="margin-top:14px;">
        <div style="font-size:0.7rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">BTC 15m Markets Found But Rejected</div>
        <table class="scan-table">
          <tr><th>Slug</th><th>Reason</th></tr>
          ${s.scanRejected.map(r => `<tr>
            <td>${r.slug}</td>
            <td><span class="tag-reject">${r.reason}</span></td>
          </tr>`).join('')}
        </table>
      </div>
      ` : ''}
    </div>

    <!-- Footer -->
    <div class="footer">
      <span>Last tick: ${s.lastTick ? new Date(s.lastTick).toLocaleTimeString() : '—'}</span>
      <span>Auto-refresh: 5s</span>
      <a href="/status">JSON API</a>
    </div>

  </div>
  <script>setTimeout(() => location.reload(), 5000);</script>
</body>
</html>`;
}

export function startDashboard(port?: number): http.Server {
    const p = port ?? (parseInt(process.env.DASHBOARD_PORT || '', 10) || DEFAULT_PORT);
    const server = http.createServer((req, res) => {
        const reqUrl = req.url || '/';
        const host = req.headers.host || `localhost:${p}`;
        const parsed = new URL(reqUrl, `http://${host}`);
        const pathname = parsed.pathname || '/';
        const method = req.method || 'GET';

        if (pathname === '/' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(serveHtml());
            return;
        }
        if (pathname === '/status' && method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(getDashboardState(), null, 2));
            return;
        }
        if (pathname === '/killSwitch' && method === 'POST') {
            const body: string[] = [];
            req.on('data', (ch) => body.push(ch.toString()));
            req.on('end', () => {
                const form = new URLSearchParams(body.join(''));
                const on = form.get('on') === '1';
                sharedState.killSwitch = on;
                res.writeHead(302, { Location: '/' });
                res.end();
            });
            return;
        }
        if (pathname === '/history' && method === 'GET') {
            const summary24h = getLast24hSummary();
            const windows = getCompletedWindowsDetail();
            const payload = {
                simulatedBalanceUsd: getSimulatedBalance(),
                last24h: summary24h,
                completedWindows: windows,
            };
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(payload, null, 2));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    });
    server.listen(p, () => {
        console.log(`Dashboard: http://localhost:${p}`);
    });
    return server;
}
