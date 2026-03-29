/**
 * Load strategy config from strategy.config.json (in project root) with env overrides.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StrategyConfig } from '../interfaces/strategyInterfaces';

const CONFIG_PATH = process.env.STRATEGY_CONFIG_PATH || path.join(process.cwd(), 'strategy.config.json');

const defaults: StrategyConfig = {
    btcMarketWindowMinutes: 15,
    targetPairCostMax: 0.99,
    safetyMargin: 0.98,
    maxPositionPerWindowUsd: 500,
    orderSizeShares: 10,
    orderMinSize: 1,
    tickSize: 0.01,
    pollIntervalMs: 5000,
    stopTradingSecondsBeforeEnd: 60,
    marketSlugs: ['btc', 'bitcoin', '15'],
    liveTrading: false,
    killSwitch: false,
    circuitBreakerFailures: 5,
    feeBips: 10,
    maxClipShares: 54,
    sizeLadderShares: [2, 8, 20, 35, 54],
    forcedSwitchEveryNOrders: 4,
    marketTiltEpsilon: 0.02,
    pairTiltImbalanceShares: 10,
    pairTiltMinElapsedSeconds: 45,
    finalOneSidedHedgeSeconds: 30,
    absoluteNoOrderSeconds: 2,
};

function fromEnv(key: string, parse: (s: string) => unknown): unknown {
    const v = process.env[key];
    if (v == null || v === '') return undefined;
    try {
        return parse(v);
    } catch {
        return undefined;
    }
}

function normalizeBtcWindowMinutes(raw: unknown): 5 | 15 {
    const n = raw === undefined || raw === null ? NaN : Number(raw);
    if (n === 5) return 5;
    return 15;
}

export function loadStrategyConfig(): StrategyConfig {
    let file: Partial<StrategyConfig> = {};
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            file = JSON.parse(raw) as Partial<StrategyConfig>;
        } catch (err) {
            console.warn('Could not load strategy.config.json:', err);
        }
    }
    const config: StrategyConfig = {
        btcMarketWindowMinutes: normalizeBtcWindowMinutes(
            (fromEnv('BTC_MARKET_WINDOW_MINUTES', parseFloat) as number) ?? file.btcMarketWindowMinutes
        ),
        targetPairCostMax: (fromEnv('TARGET_PAIR_COST_MAX', parseFloat) as number) ?? file.targetPairCostMax ?? defaults.targetPairCostMax,
        safetyMargin: (fromEnv('SAFETY_MARGIN', parseFloat) as number) ?? file.safetyMargin ?? defaults.safetyMargin,
        maxPositionPerWindowUsd: (fromEnv('MAX_POSITION_PER_WINDOW_USD', parseFloat) as number) ?? file.maxPositionPerWindowUsd ?? defaults.maxPositionPerWindowUsd,
        orderSizeShares: (fromEnv('ORDER_SIZE_SHARES', parseInt) as number) ?? file.orderSizeShares ?? defaults.orderSizeShares,
        orderMinSize: (fromEnv('ORDER_MIN_SIZE', parseInt) as number) ?? file.orderMinSize ?? defaults.orderMinSize,
        tickSize: (fromEnv('TICK_SIZE', parseFloat) as number) ?? file.tickSize ?? defaults.tickSize,
        pollIntervalMs: (fromEnv('POLL_INTERVAL_MS', parseInt) as number) ?? file.pollIntervalMs ?? defaults.pollIntervalMs,
        stopTradingSecondsBeforeEnd: (fromEnv('STOP_TRADING_SECONDS_BEFORE_END', parseInt) as number) ?? file.stopTradingSecondsBeforeEnd ?? defaults.stopTradingSecondsBeforeEnd,
        liveTrading: (fromEnv('LIVE_TRADING', (s) => s === '1' || s.toLowerCase() === 'true') as boolean) ?? file.liveTrading ?? defaults.liveTrading,
        killSwitch: (fromEnv('KILL_SWITCH', (s) => s === '1' || s.toLowerCase() === 'true') as boolean) ?? file.killSwitch ?? defaults.killSwitch,
        circuitBreakerFailures: (fromEnv('CIRCUIT_BREAKER_FAILURES', parseInt) as number) ?? file.circuitBreakerFailures ?? defaults.circuitBreakerFailures,
        feeBips: (fromEnv('FEE_BIPS', parseInt) as number) ?? file.feeBips ?? defaults.feeBips,
        marketSlugs: (file.marketSlugs && file.marketSlugs.length > 0 ? file.marketSlugs : defaults.marketSlugs),
        maxSingleOrderUsd: (fromEnv('MAX_SINGLE_ORDER_USD', parseFloat) as number) ?? file.maxSingleOrderUsd,
        quietConsole: (fromEnv('QUIET_CONSOLE', (s) => s === '1' || s.toLowerCase() === 'true') as boolean) ?? file.quietConsole ?? false,
        paperStartingBalanceUsd: (fromEnv('PAPER_STARTING_BALANCE_USD', parseFloat) as number) ?? file.paperStartingBalanceUsd ?? 5000,
        maxClipShares: (fromEnv('MAX_CLIP_SHARES', parseFloat) as number) ?? file.maxClipShares ?? defaults.maxClipShares,
        sizeLadderShares: file.sizeLadderShares ?? defaults.sizeLadderShares,
        forcedSwitchEveryNOrders: (fromEnv('FORCED_SWITCH_EVERY_N_ORDERS', parseInt) as number)
            ?? file.forcedSwitchEveryNOrders
            ?? defaults.forcedSwitchEveryNOrders,
        marketTiltEpsilon: (fromEnv('MARKET_TILT_EPSILON', parseFloat) as number)
            ?? file.marketTiltEpsilon
            ?? defaults.marketTiltEpsilon,
        pairTiltImbalanceShares: (fromEnv('PAIR_TILT_IMBALANCE_SHARES', parseFloat) as number)
            ?? file.pairTiltImbalanceShares
            ?? defaults.pairTiltImbalanceShares,
        pairTiltMinElapsedSeconds: (fromEnv('PAIR_TILT_MIN_ELAPSED_SECONDS', parseInt) as number)
            ?? file.pairTiltMinElapsedSeconds
            ?? defaults.pairTiltMinElapsedSeconds,
        finalOneSidedHedgeSeconds: (fromEnv('FINAL_ONE_SIDED_HEDGE_SECONDS', parseInt) as number)
            ?? file.finalOneSidedHedgeSeconds
            ?? defaults.finalOneSidedHedgeSeconds,
        absoluteNoOrderSeconds: (fromEnv('ABSOLUTE_NO_ORDER_SECONDS', parseInt) as number)
            ?? file.absoluteNoOrderSeconds
            ?? defaults.absoluteNoOrderSeconds,
        orderSpendBalanceFraction: (fromEnv('ORDER_SPEND_BALANCE_FRACTION', parseFloat) as number)
            ?? file.orderSpendBalanceFraction,
    };
    return config;
}
