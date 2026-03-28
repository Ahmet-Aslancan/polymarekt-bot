/**
 * Order placement, cancellation, and fill tracking via Polymarket CLOB client.
 * Uses limit orders (GTC) by default; respects config for tick size and neg risk.
 *
 * Partial fill handling:
 *   - After placing a GTC order, it is stored as "pending"
 *   - Each tick, reconcilePendingOrders() checks if pending orders have filled
 *   - Fills are returned so the bot can update its window state from ACTUAL fills
 *   - Unfilled/partial orders remain pending and are not double-counted
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import type { TickSize, OpenOrder } from '@polymarket/clob-client';
import type { ActiveMarket } from '../interfaces/strategyInterfaces';
import type { StrategyConfig } from '../interfaces/strategyInterfaces';
import { orderBookFromClob } from './hedgeStrategy';
import type { OrderBookSnapshot } from '../interfaces/strategyInterfaces';

export interface OrderResult {
    success: boolean;
    orderId?: string;
    error?: string;
}

/** A placed order we're tracking for fill status */
export interface PendingOrder {
    orderId: string;
    tokenId: string;
    side: 'YES' | 'NO';
    price: number;
    sizeRequested: number;
    sizeFilled: number;      // how many shares have been confirmed filled so far
    costFilled: number;      // total cost of confirmed fills
    placedAt: string;        // ISO timestamp
    status: 'open' | 'filled' | 'partial' | 'cancelled' | 'unknown';
}

/** Result of checking a pending order's fill status */
export interface FillUpdate {
    orderId: string;
    side: 'YES' | 'NO';
    newFillQty: number;     // NEW shares filled since last check (delta)
    newFillCost: number;    // NEW cost since last check (delta)
    orderDone: boolean;     // true if order is fully filled or cancelled (remove from pending)
}

/**
 * Resolve tick size string to the TickSize union type expected by the CLOB client.
 * Valid values: "0.1" | "0.01" | "0.001" | "0.0001"
 */
function resolveTickSize(config: StrategyConfig): TickSize {
    const ts = config.tickSize ?? 0.01;
    if (ts === 0.1) return '0.1';
    if (ts === 0.001) return '0.001';
    if (ts === 0.0001) return '0.0001';
    return '0.01'; // default
}

// ─── Orderbook ───────────────────────────────────────────────────────────

/**
 * Fetch orderbook for a token from CLOB.
 */
export async function getOrderBook(
    client: ClobClient,
    tokenId: string
): Promise<{ bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> }> {
    try {
        const book = await client.getOrderBook(tokenId);
        const bids = (book?.bids || []).map((b: { price: string; size: string }) => ({
            price: b.price,
            size: b.size,
        }));
        const asks = (book?.asks || []).map((a: { price: string; size: string }) => ({
            price: a.price,
            size: a.size,
        }));
        return { bids, asks };
    } catch (err) {
        console.error(`[orderManager] getOrderBook failed for ${tokenId.slice(0, 12)}...:`, err);
        return { bids: [], asks: [] };
    }
}

/**
 * Get orderbook snapshots for both YES and NO tokens (parallel).
 */
export async function getBothOrderBooks(
    client: ClobClient,
    market: ActiveMarket
): Promise<{ bookYes: OrderBookSnapshot; bookNo: OrderBookSnapshot }> {
    const [yesBook, noBook] = await Promise.all([
        getOrderBook(client, market.yesTokenId),
        getOrderBook(client, market.noTokenId),
    ]);
    const bookYes = orderBookFromClob(market.yesTokenId, 'YES', yesBook.bids, yesBook.asks);
    const bookNo = orderBookFromClob(market.noTokenId, 'NO', noBook.bids, noBook.asks);
    return { bookYes, bookNo };
}

// ─── Order Placement ─────────────────────────────────────────────────────

/**
 * Place a single limit buy order (GTC). Returns success + orderId or error.
 */
export async function placeLimitBuyOrder(
    client: ClobClient,
    tokenId: string,
    price: number,
    size: number,
    config: StrategyConfig,
    negRisk: boolean
): Promise<OrderResult> {
    // Polymarket CLOB requires minimum $1.00 per order
    const orderDollarAmount = price * size;
    if (orderDollarAmount < 1.0) {
        const msg = `Order too small: ${size} shares × $${price.toFixed(4)} = $${orderDollarAmount.toFixed(2)} < $1.00 CLOB minimum`;
        console.error(`[orderManager] ${msg}`);
        return { success: false, error: msg };
    }

    try {
        const tickSize = resolveTickSize(config);
        const resp = await client.createAndPostOrder(
            {
                tokenID: tokenId,
                price,
                side: Side.BUY,
                size,
            },
            { tickSize, negRisk },
            OrderType.GTC
        );

        // The CLOB client may NOT throw on HTTP 400 — it logs the error
        // internally and returns a response without a valid orderID.
        // We must check the response to detect rejection.
        const orderId = resp?.orderID ?? resp?.id;
        if (!orderId || orderId === 'unknown') {
            // Check if the response contains an error indicator
            const errorMsg = (resp as Record<string, unknown>)?.error
                ?? (resp as Record<string, unknown>)?.message
                ?? 'Order rejected by CLOB (no orderID returned)';
            console.error(`[orderManager] Order rejected:`, errorMsg);
            return { success: false, error: String(errorMsg) };
        }
        return { success: true, orderId: String(orderId) };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] placeLimitBuyOrder failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Place a market buy order with strict safeguards.
 * Uses the CLOB client's createAndPostMarketOrder with FOK (Fill Or Kill).
 *
 * Safeguards:
 *   - Requires bestAskPrice to verify slippage before placing
 *   - Rejects if best ask >= $0.99 (too expensive)
 *   - Caps slippage to maxSlippageBps above best ask
 *   - Size capped at config.orderSizeShares
 *   - FOK ensures the order fills entirely or not at all (no partial resting)
 */
export async function placeMarketBuyOrder(
    client: ClobClient,
    tokenId: string,
    bestAskPrice: number,
    amountUsd: number,
    config: StrategyConfig,
    negRisk: boolean,
    maxSlippageBps: number = 50 // default 50 bps = 0.5% max slippage
): Promise<OrderResult> {
    try {
        // Safeguard 1: reject if best ask is unreasonably high
        if (bestAskPrice >= 0.99) {
            return { success: false, error: 'Market order rejected: best ask >= $0.99 (too expensive)' };
        }

        // Safeguard 2: set limit price with slippage cap
        const slippageFactor = 1 + maxSlippageBps / 10000;
        const maxPrice = Math.min(bestAskPrice * slippageFactor, 0.99);
        const limitPrice = Math.round(maxPrice * 100) / 100;

        // Safeguard 3: cap amount
        const cappedAmount = Math.min(amountUsd, config.orderSizeShares * limitPrice);

        const tickSize = resolveTickSize(config);

        // Use createAndPostMarketOrder with FOK
        const resp = await client.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                price: limitPrice,
                amount: cappedAmount,
                side: Side.BUY,
            },
            { tickSize, negRisk },
            OrderType.FOK
        );

        // Check for rejection (same pattern as placeLimitBuyOrder)
        const orderId = resp?.orderID ?? resp?.id;
        if (!orderId || orderId === 'unknown') {
            const errorMsg = (resp as Record<string, unknown>)?.error
                ?? (resp as Record<string, unknown>)?.message
                ?? 'Market order rejected by CLOB (no orderID returned)';
            console.error(`[orderManager] Market order rejected:`, errorMsg);
            return { success: false, error: String(errorMsg) };
        }
        return { success: true, orderId: String(orderId) };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] placeMarketBuyOrder failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Replace an existing order: cancel the old one, then place a new one.
 * This is the standard approach for order replacement on CLOB systems.
 */
export async function replaceOrder(
    client: ClobClient,
    oldOrderId: string,
    tokenId: string,
    newPrice: number,
    newSize: number,
    config: StrategyConfig,
    negRisk: boolean
): Promise<OrderResult> {
    try {
        // Step 1: Cancel existing order
        await client.cancelOrder({ orderID: oldOrderId });

        // Step 2: Place new order
        return await placeLimitBuyOrder(client, tokenId, newPrice, newSize, config, negRisk);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] replaceOrder failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Create a PendingOrder record after successful order placement.
 */
export function createPendingOrder(
    orderId: string,
    tokenId: string,
    side: 'YES' | 'NO',
    price: number,
    size: number
): PendingOrder {
    return {
        orderId,
        tokenId,
        side,
        price,
        sizeRequested: size,
        sizeFilled: 0,
        costFilled: 0,
        placedAt: new Date().toISOString(),
        status: 'open',
    };
}

// ─── Fill Reconciliation ─────────────────────────────────────────────────

/**
 * Check the fill status of a single pending order.
 * Uses getOrder() to check size_matched from the OpenOrder response.
 * Falls back to checking getOpenOrders() if getOrder() fails.
 */
async function checkOrderFillStatus(
    client: ClobClient,
    pending: PendingOrder
): Promise<FillUpdate> {
    const noUpdate: FillUpdate = {
        orderId: pending.orderId,
        side: pending.side,
        newFillQty: 0,
        newFillCost: 0,
        orderDone: false,
    };

    try {
        // Try getOrder() to get detailed fill info
        const order: OpenOrder = await client.getOrder(pending.orderId);
        if (order) {
            const sizeMatched = parseFloat(order.size_matched || '0');
            const originalSize = parseFloat(order.original_size || String(pending.sizeRequested));
            const status = (order.status || '').toUpperCase();

            // Calculate new fills since last check
            const totalFilled = Math.min(sizeMatched, originalSize);
            const newFillQty = Math.max(0, totalFilled - pending.sizeFilled);
            const newFillCost = newFillQty * pending.price; // approximate cost at limit price

            const isDone = status === 'MATCHED' || status === 'FILLED' || status === 'CANCELLED' ||
                status === 'EXPIRED' || totalFilled >= originalSize;

            return {
                orderId: pending.orderId,
                side: pending.side,
                newFillQty,
                newFillCost,
                orderDone: isDone,
            };
        }

        return noUpdate;
    } catch {
        // getOrder() failed — fall back to checking open orders list
        try {
            const openOrders = await client.getOpenOrders();
            const stillOpen = openOrders.some((o: OpenOrder) => o.id === pending.orderId);

            if (!stillOpen) {
                // Conservative handling: if we cannot fetch authoritative order status
                // and the order is no longer open, do NOT assume it fully filled.
                // It might have been cancelled/expired/rejected.
                return { ...noUpdate, orderDone: true };
            }
            return noUpdate;
        } catch (innerErr) {
            console.error(`[orderManager] checkOrderFillStatus error for ${pending.orderId}:`, innerErr);
            return noUpdate;
        }
    }
}

/**
 * Reconcile all pending orders: check fills and return updates.
 * Called each tick by the bot to get actual fill data.
 *
 * SAFETY: Skips orders with orderId "unknown" — those were never placed on CLOB.
 */
export async function reconcilePendingOrders(
    client: ClobClient,
    pendingOrders: PendingOrder[]
): Promise<{ fills: FillUpdate[]; updatedPending: PendingOrder[] }> {
    if (pendingOrders.length === 0) return { fills: [], updatedPending: [] };

    const fills: FillUpdate[] = [];
    const updatedPending: PendingOrder[] = [];

    for (const pending of pendingOrders) {
        // Never reconcile phantom orders that were rejected by CLOB
        if (!pending.orderId || pending.orderId === 'unknown') {
            console.warn(`[orderManager] Dropping phantom order (no real orderId) for ${pending.side} ${pending.sizeRequested} @ ${pending.price}`);
            continue; // drop it — it was never placed
        }

        const update = await checkOrderFillStatus(client, pending);

        if (update.newFillQty > 0) {
            fills.push(update);
        }

        if (!update.orderDone) {
            updatedPending.push({
                ...pending,
                sizeFilled: pending.sizeFilled + update.newFillQty,
                costFilled: pending.costFilled + update.newFillCost,
                status: update.newFillQty > 0 ? 'partial' : pending.status,
            });
        }
        // If orderDone, don't add to updatedPending (order is complete)
    }

    return { fills, updatedPending };
}

// ─── Instant Execution (FOK) ─────────────────────────────────────────────

/**
 * Buy instantly using FOK (Fill or Kill) market order at the ask price.
 * The order fills entirely or is killed — never rests on the book.
 *
 * This is the core of the "continuous DCA" strategy:
 *   - Buy at the ask → instant fill (taker)
 *   - No pending orders, no waiting
 *   - Both sides always get filled in the same tick
 *
 * @param askPrice  The best ask price (our limit/slippage cap)
 * @param shares    Number of shares to buy
 */
export async function buyInstant(
    client: ClobClient,
    tokenId: string,
    askPrice: number,
    shares: number,
    config: StrategyConfig,
    negRisk: boolean
): Promise<OrderResult> {
    const amountUsd = shares * askPrice;

    if (amountUsd < 1.0) {
        return { success: false, error: `Order $${amountUsd.toFixed(2)} < $1.00 CLOB min` };
    }

    try {
        const tickSize = resolveTickSize(config);
        const ts = config.tickSize || 0.01;
        // Add 1 tick buffer above ask for slippage protection
        const priceWithBuffer = Math.round((askPrice + ts) * 100) / 100;
        // Amount in USD for BUY orders
        const buyAmountUsd = shares * priceWithBuffer;

        const resp = await client.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                price: priceWithBuffer,
                amount: buyAmountUsd,
                side: Side.BUY,
            },
            { tickSize, negRisk },
            OrderType.FOK
        );

        const orderId = resp?.orderID ?? resp?.id;
        if (!orderId || orderId === 'unknown') {
            const errorMsg = (resp as Record<string, unknown>)?.error
                ?? (resp as Record<string, unknown>)?.message
                ?? 'FOK buy rejected by CLOB';
            return { success: false, error: String(errorMsg) };
        }
        return { success: true, orderId: String(orderId) };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] buyInstant failed: ${message}`);
        return { success: false, error: message };
    }
}

/**
 * Sell instantly using FOK (Fill or Kill) market order at the bid price.
 * Used to exit positions when the other side fails to fill (sell-back safety).
 *
 * Max loss = spread × shares (typically 2-3%).
 *
 * @param bidPrice  The best bid price (our minimum acceptable sell price)
 * @param shares    Number of shares to sell
 */
export async function sellInstant(
    client: ClobClient,
    tokenId: string,
    bidPrice: number,
    shares: number,
    config: StrategyConfig,
    negRisk: boolean
): Promise<OrderResult> {
    try {
        const tickSize = resolveTickSize(config);
        const ts = config.tickSize || 0.01;
        // Subtract 1 tick from bid for slippage tolerance
        const priceWithBuffer = Math.max(ts, Math.round((bidPrice - ts) * 100) / 100);

        const resp = await client.createAndPostMarketOrder(
            {
                tokenID: tokenId,
                price: priceWithBuffer,
                amount: shares,  // For SELL orders, amount = number of shares
                side: Side.SELL,
            },
            { tickSize, negRisk },
            OrderType.FOK
        );

        const orderId = resp?.orderID ?? resp?.id;
        if (!orderId || orderId === 'unknown') {
            const errorMsg = (resp as Record<string, unknown>)?.error
                ?? (resp as Record<string, unknown>)?.message
                ?? 'FOK sell rejected by CLOB';
            return { success: false, error: String(errorMsg) };
        }
        return { success: true, orderId: String(orderId) };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orderManager] sellInstant failed: ${message}`);
        return { success: false, error: message };
    }
}

// ─── Cancellation ────────────────────────────────────────────────────────

/**
 * Cancel all open orders for a given token.
 * Uses cancelMarketOrders for targeted cancellation, falls back to cancelAll.
 */
export async function cancelOpenOrders(
    client: ClobClient,
    tokenId: string
): Promise<{ cancelled: number; error?: string }> {
    try {
        // Try targeted cancel by asset_id first
        try {
            await client.cancelMarketOrders({ asset_id: tokenId });
            return { cancelled: -1 }; // -1 = bulk cancel (count unknown)
        } catch {
            // cancelMarketOrders not available or failed, try manual approach
        }

        // Get open orders and cancel matching ones
        const openOrders = await client.getOpenOrders({ asset_id: tokenId });
        let cancelled = 0;
        for (const order of openOrders) {
            if (order.asset_id === tokenId && order.id) {
                try {
                    await client.cancelOrder({ orderID: order.id });
                    cancelled++;
                } catch (cancelErr) {
                    console.error(`[orderManager] Failed to cancel order ${order.id}:`, cancelErr);
                }
            }
        }
        return { cancelled };
    } catch (err) {
        // Last resort: cancel ALL orders
        try {
            await client.cancelAll();
            return { cancelled: -1 };
        } catch {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[orderManager] cancelOpenOrders error:`, message);
            return { cancelled: 0, error: message };
        }
    }
}
