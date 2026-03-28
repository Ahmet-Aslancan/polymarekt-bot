/**
 * Risk controls: max position per window, max daily spend, kill switch, circuit breaker.
 */

import type { StrategyConfig } from '../interfaces/strategyInterfaces';
import type { WindowState } from '../interfaces/strategyInterfaces';

export interface RiskState {
    killSwitch: boolean;
    consecutiveOrderFailures: number;
}

export function createInitialRiskState(config: StrategyConfig): RiskState {
    return {
        killSwitch: config.killSwitch,
        consecutiveOrderFailures: 0,
    };
}

/** Check if we are allowed to place an order (risk checks) */
export function canPlaceOrder(
    config: StrategyConfig,
    riskState: RiskState,
    windowState: WindowState,
    additionalSpend: number
): { allowed: boolean; reason: string } {
    if (config.killSwitch || riskState.killSwitch) {
        return { allowed: false, reason: 'Kill switch is on' };
    }
    if (riskState.consecutiveOrderFailures >= config.circuitBreakerFailures) {
        return { allowed: false, reason: `Circuit breaker: ${riskState.consecutiveOrderFailures} consecutive failures` };
    }
    const totalWindowSpend = windowState.totalSpentUsd + additionalSpend;
    if (totalWindowSpend > config.maxPositionPerWindowUsd) {
        return { allowed: false, reason: `Max position per window exceeded (${totalWindowSpend.toFixed(2)} > ${config.maxPositionPerWindowUsd})` };
    }
    return { allowed: true, reason: 'OK' };
}

/** Record a successful order (reset circuit breaker) */
export function recordOrderSuccess(state: RiskState, spendUsd: number): RiskState {
    return {
        ...state,
        consecutiveOrderFailures: 0,
    };
}

/** Record an order failure (increment circuit breaker) */
export function recordOrderFailure(state: RiskState): RiskState {
    return {
        ...state,
        consecutiveOrderFailures: state.consecutiveOrderFailures + 1,
    };
}

/** Reset circuit breaker (called on new window transitions) */
export function resetCircuitBreaker(state: RiskState): RiskState {
    return {
        ...state,
        consecutiveOrderFailures: 0,
    };
}

/** Set kill switch on/off */
export function setKillSwitch(state: RiskState, on: boolean): RiskState {
    return { ...state, killSwitch: on };
}
