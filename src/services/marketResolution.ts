/**
 * Market resolution helper (Gamma API).
 * Attempts to determine which outcome won for btc-updown-* markets.
 */
import axios from 'axios';

const GAMMA_API = 'https://gamma-api.polymarket.com';

type WinnerSide = 'YES' | 'NO';

type GammaMarketMaybeResolved = {
    slug?: string;
    closed?: boolean;
    acceptingOrders?: boolean;
    resolved?: boolean;
    resolution?: string;
    outcome?: string;
    winningOutcome?: string;
    winning_outcome?: string;
    finalOutcome?: string;
    final_outcome?: string;
    result?: string;
    answer?: string;
};

function mapOutcomeToSide(raw: unknown): WinnerSide | null {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) return null;
    // Common binary outcomes
    if (s === 'yes' || s === 'y' || s === 'true' || s === '1') return 'YES';
    if (s === 'no' || s === 'n' || s === 'false' || s === '0') return 'NO';

    // Up/down naming (btc-updown markets sometimes expose outcome text)
    if (s === 'up') return 'YES';
    if (s === 'down') return 'NO';
    if (s.includes(' up')) return 'YES';
    if (s.includes(' down')) return 'NO';

    // Higher/lower variants (common on Polymarket crypto resolution strings)
    if (s.includes('higher') || s.includes('increase') || s.includes('above') || s.includes('greater')) return 'YES';
    if (s.includes('lower') || s.includes('decrease') || s.includes('below') || s.includes('less')) return 'NO';
    return null;
}

function pickWinnerFromMarket(m: GammaMarketMaybeResolved): WinnerSide | null {
    return (
        mapOutcomeToSide(m.winningOutcome) ??
        mapOutcomeToSide(m.winning_outcome) ??
        mapOutcomeToSide(m.outcome) ??
        mapOutcomeToSide(m.finalOutcome) ??
        mapOutcomeToSide(m.final_outcome) ??
        mapOutcomeToSide(m.resolution) ??
        mapOutcomeToSide(m.result) ??
        mapOutcomeToSide(m.answer) ??
        null
    );
}

/**
 * Returns 'YES'/'NO' once winner is published; otherwise null.
 */
export async function fetchResolvedWinnerSideBySlug(slug: string): Promise<WinnerSide | null> {
    const r = await axios.get(`${GAMMA_API}/markets/slug/${slug}`, { timeout: 10_000 });
    const data = r.data;
    const market: GammaMarketMaybeResolved | null = Array.isArray(data) ? (data[0] || null) : (data || null);
    if (!market) return null;
    return pickWinnerFromMarket(market);
}

