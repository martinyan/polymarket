/**
 * Fetches live Polymarket implied probabilities for city temperature markets.
 * Uses the public Gamma API — no auth required.
 */

import { fetchJson } from '../http';
import { CityConfig } from './cities';
import { titleToBracket, BracketProbabilities, buildBrackets, Bracket } from './brackets';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

type GammaSubMarket = {
  groupItemTitle?: string;
  outcomePrices?: string;
  conditionId?: string;
  clobTokenIds?: string;   // JSON string: ["yesTokenId", "noTokenId"]
  orderPriceMinTickSize?: number;
  negRisk?: boolean;
  negRiskMarketID?: string;
  acceptingOrders?: boolean;
  closed?: boolean;
};

type GammaEvent = {
  markets?: GammaSubMarket[];
  volume?: number;
  liquidity?: number;
  negRiskMarketID?: string;
};

/** Per-bracket trading info needed to place an order */
export type BracketMarket = {
  bracket: Bracket;
  conditionId: string;
  yesTokenId: string;
  yesPrice: number;       // current implied probability / ask price
  tickSize: number;
  negRisk: boolean;
  negRiskMarketID: string;
  acceptingOrders: boolean;
};

export type MarketOdds = {
  eventSlug: string;
  date: string;
  volume: number;
  liquidity: number;
  probs: Partial<BracketProbabilities>;
  /** Full bracket detail including tokenIds — needed for placing bets */
  bracketMarkets: BracketMarket[];
};

/** Build Polymarket event slug from a city config and date string (YYYY-MM-DD) */
export function buildEventSlug(city: CityConfig, date: string): string {
  const d     = new Date(date + 'T12:00:00Z');
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
  const day   = d.getUTCDate();
  const year  = d.getUTCFullYear();
  return `${city.slugPrefix}-${month}-${day}-${year}`;
}

/** Fetch live implied probabilities for a city market on a given date */
export async function fetchMarketOdds(city: CityConfig, date: string): Promise<MarketOdds | null> {
  const slug = buildEventSlug(city, date);
  const url  = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;

  const events = await fetchJson<GammaEvent[]>(url);
  if (!events?.length) return null;

  const event      = events[0];
  const subMarkets = event.markets ?? [];
  const probs: Partial<BracketProbabilities> = {};
  const bracketMarkets: BracketMarket[] = [];

  for (const m of subMarkets) {
    const bracket = titleToBracket(m.groupItemTitle ?? '', city);
    if (bracket === null) continue;

    let yesPrice = 0;
    try {
      const prices = JSON.parse(m.outcomePrices ?? '["0","1"]') as string[];
      yesPrice = parseFloat(prices[0] ?? '0');
    } catch { continue; }

    let yesTokenId = '';
    try {
      const tokenIds = JSON.parse(m.clobTokenIds ?? '["",""]') as string[];
      yesTokenId = tokenIds[0] ?? '';
    } catch {}

    probs[bracket] = yesPrice;

    if (m.conditionId && yesTokenId) {
      bracketMarkets.push({
        bracket,
        conditionId:      m.conditionId,
        yesTokenId,
        yesPrice,
        tickSize:         m.orderPriceMinTickSize ?? 0.001,
        negRisk:          m.negRisk ?? false,
        negRiskMarketID:  m.negRiskMarketID ?? event.negRiskMarketID ?? '',
        acceptingOrders:  m.acceptingOrders ?? false,
      });
    }
  }

  // Normalise probabilities
  const total = (Object.values(probs) as number[]).reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const b of buildBrackets(city)) {
      if (probs[b] !== undefined) probs[b] = (probs[b] as number) / total;
    }
  }

  return {
    eventSlug: slug,
    date,
    volume:    typeof event.volume    === 'number' ? event.volume    : 0,
    liquidity: typeof event.liquidity === 'number' ? event.liquidity : 0,
    probs,
    bracketMarkets,
  };
}

/** Fetch odds for the next N days for a city */
export async function fetchUpcomingOdds(city: CityConfig, days = 7): Promise<MarketOdds[]> {
  const results: MarketOdds[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const odds = await fetchMarketOdds(city, dateStr);
    if (odds) results.push(odds);
  }
  return results;
}
