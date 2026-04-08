/**
 * Fetches live Polymarket implied probabilities for city temperature markets.
 * Uses the public Gamma API — no auth required.
 */

import { fetchJson } from '../http';
import { CityConfig } from './cities';
import { titleToBracket, parseTemperatureMarketTitle, BracketProbabilities, Bracket } from './brackets';

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
  bestBid?: number;
  bestAsk?: number;
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
  yesPrice: number;       // Gamma outcome price / implied probability
  yesBid: number;         // executable YES bid from Gamma CLOB summary
  yesAsk: number;         // executable YES ask from Gamma CLOB summary
  noAsk: number;          // equivalent NO ask, derived from YES bid
  tickSize: number;
  negRisk: boolean;
  negRiskMarketID: string;
  acceptingOrders: boolean;
};

export type MarketOdds = {
  eventSlug: string;
  date: string;
  minBracket: number;
  maxBracket: number;
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
  let minBracket: number | null = null;
  let maxBracket: number | null = null;

  for (const m of subMarkets) {
    const parsedTitle = parseTemperatureMarketTitle(m.groupItemTitle ?? '');
    if (parsedTitle?.kind === 'below') minBracket = parsedTitle.value;
    if (parsedTitle?.kind === 'above') maxBracket = parsedTitle.value;

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
      const yesBid = finitePrice(m.bestBid) ? m.bestBid as number : Math.max(0, yesPrice - 0.01);
      const yesAsk = finitePrice(m.bestAsk) ? m.bestAsk as number : yesPrice;
      bracketMarkets.push({
        bracket,
        conditionId:      m.conditionId,
        yesTokenId,
        yesPrice,
        yesBid,
        yesAsk,
        noAsk:            1 - yesBid,
        tickSize:         m.orderPriceMinTickSize ?? 0.001,
        negRisk:          m.negRisk ?? false,
        negRiskMarketID:  m.negRiskMarketID ?? event.negRiskMarketID ?? '',
        acceptingOrders:  m.acceptingOrders ?? false,
      });
    }
  }

  return {
    eventSlug: slug,
    date,
    minBracket: minBracket ?? city.minBracket,
    maxBracket: maxBracket ?? city.maxBracket,
    volume:    typeof event.volume    === 'number' ? event.volume    : 0,
    liquidity: typeof event.liquidity === 'number' ? event.liquidity : 0,
    probs,
    bracketMarkets,
  };
}

function finitePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Use the live market's date-specific bracket bounds with the city's station metadata. */
export function cityWithMarketBrackets(city: CityConfig, odds: Pick<MarketOdds, 'minBracket' | 'maxBracket'>): CityConfig {
  return {
    ...city,
    minBracket: odds.minBracket,
    maxBracket: odds.maxBracket,
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
