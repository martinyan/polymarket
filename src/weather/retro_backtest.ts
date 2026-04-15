/**
 * Retrospective weather strategy comparison:
 * best single bracket vs. best two-bracket basket over resolved markets.
 *
 * This uses:
 * - Polymarket Gamma event metadata for resolved weather markets
 * - Polymarket CLOB price history sampled at the 8h trade-window open
 * - Historical Open-Meteo ensemble forecasts for the event date
 *
 * The result is a practical historical price-series backtest, not a perfect
 * executable order-book replay.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { computeBracketProbabilities, titleToBracket } from './brackets';
import { CITIES, FORWARD_TEST_CITY_IDS, CityConfig } from './cities';
import { cityDayEndUtcMs, tradeWindowOpenUtcMs } from './time';
import { fetchJson, postJson } from '../http';
import { computeBetSignals, applySingleMarketKellyRecommendation, expectedLogGrowthForSingle, findBestTwoBracketBasket } from './ev';

type GammaSubMarket = {
  groupItemTitle?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  umaResolutionStatus?: string;
};

type GammaEvent = {
  slug?: string;
  markets?: GammaSubMarket[];
  closed?: boolean;
};

type PriceHistoryPoint = { t: number; p: number };
type BatchPriceHistoryEntry = { market: string; history: PriceHistoryPoint[] };

type MarketBacktestRow = {
  city: string;
  marketDate: string;
  eventSlug: string;
  actualBracket: string;
  windowOpenUtc: string;
  single: {
    bracket: string;
    label: string;
    modelProb: number;
    marketPrice: number;
    stakeUsd: number;
    expectedLogGrowth: number;
    pnlUsd: number;
  } | null;
  basket: {
    brackets: [string, string];
    labels: [string, string];
    marketPrices: [number, number];
    stakeUsd: [number, number];
    profitProbability: number;
    expectedLogGrowth: number;
    pnlUsd: number;
  } | null;
  decision: 'single' | 'basket' | 'none';
  winner: 'single' | 'basket' | 'tie' | 'none';
};

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const BANKROLL_USD = 1000;
const LOOKBACK_DAYS = 60;
const TRADE_WINDOW_HOURS = 8;

async function fetchHistoricalDailySeries(city: CityConfig, date: string, model: string): Promise<Map<string, number[]>> {
  const url = [
    `https://historical-forecast-api.open-meteo.com/v1/forecast`,
    `?latitude=${city.lat}&longitude=${city.lon}`,
    `&start_date=${date}&end_date=${date}`,
    `&daily=temperature_2m_max`,
    `&models=${model}`,
    `&timezone=${encodeURIComponent(city.timezone)}`,
  ].join('');
  const data = await fetchJson<{ daily: Record<string, Array<number | string | null>> }>(url);
  const map = new Map<string, number[]>();
  for (const [key, values] of Object.entries(data.daily)) {
    if (!key.startsWith('temperature_2m_max_member')) continue;
    const num = values[0];
    if (typeof num !== 'number' || !Number.isFinite(num)) continue;
    const bucket = map.get(date) ?? [];
    bucket.push(num);
    map.set(date, bucket);
  }
  return map;
}

function buildEventSlug(city: CityConfig, date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
  return `${city.slugPrefix}-${month}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
}

function parseYesTokenId(market: GammaSubMarket): string | null {
  try {
    const tokenIds = JSON.parse(market.clobTokenIds ?? '[]') as string[];
    return tokenIds[0] ?? null;
  } catch {
    return null;
  }
}

function parseResolvedBracket(event: GammaEvent, city: CityConfig): string {
  for (const market of event.markets ?? []) {
    try {
      const prices = JSON.parse(market.outcomePrices ?? '[]') as string[];
      if (parseFloat(prices[0] ?? '0') === 1 && market.umaResolutionStatus === 'resolved') {
        return titleToBracket(market.groupItemTitle ?? '', city) ?? '';
      }
    } catch {}
  }
  return '';
}

function closestPriceAt(history: PriceHistoryPoint[], targetTs: number): number | null {
  if (!history.length) return null;
  let best: PriceHistoryPoint | null = null;
  for (const point of history) {
    if (point.t > targetTs) continue;
    if (!best || point.t > best.t) best = point;
  }
  best ??= history[0];
  return typeof best.p === 'number' && Number.isFinite(best.p) ? best.p : null;
}

function dateRangeUtcInclusive(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = new Date(`${start}T00:00:00Z`);
  const finish = new Date(`${end}T00:00:00Z`);
  while (current <= finish) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function payoutForSingle(stakeUsd: number, price: number, bracket: string, actualBracket: string): number {
  if (stakeUsd <= 0 || price <= 0) return 0;
  return bracket === actualBracket ? stakeUsd * (1 / price - 1) : -stakeUsd;
}

function payoutForBasket(
  stakeUsd: [number, number],
  prices: [number, number],
  brackets: [string, string],
  actualBracket: string,
): number {
  if (actualBracket === brackets[0]) return stakeUsd[0] * (1 / prices[0] - 1) - stakeUsd[1];
  if (actualBracket === brackets[1]) return stakeUsd[1] * (1 / prices[1] - 1) - stakeUsd[0];
  return -(stakeUsd[0] + stakeUsd[1]);
}

async function fetchEventBySlug(slug: string): Promise<GammaEvent | null> {
  const events = await fetchJson<GammaEvent[]>(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`);
  return events?.[0] ?? null;
}

async function fetchHistoricalPrices(tokenIds: string[], startTs: number, endTs: number): Promise<Map<string, number | null>> {
  const body = tokenIds.map(tokenId => ({
    market: tokenId,
    startTs,
    endTs,
    fidelity: 1,
  }));
  const response = await postJson<BatchPriceHistoryEntry[]>(`${CLOB_BASE}/prices-history`, body);
  const prices = new Map<string, number | null>();
  for (const entry of response ?? []) {
    prices.set(entry.market, closestPriceAt(entry.history ?? [], startTs));
  }
  for (const tokenId of tokenIds) {
    if (!prices.has(tokenId)) prices.set(tokenId, null);
  }
  return prices;
}

async function analyzeMarket(city: CityConfig, marketDate: string): Promise<MarketBacktestRow | null> {
  const eventSlug = buildEventSlug(city, marketDate);
  const event = await fetchEventBySlug(eventSlug).catch(() => null);
  if (!event?.markets?.length) return null;

  const actualBracket = parseResolvedBracket(event, city);
  if (!actualBracket) return null;

  const windowOpenMs = tradeWindowOpenUtcMs(marketDate, city.timezone, TRADE_WINDOW_HOURS);
  const endTs = Math.floor((windowOpenMs + 15 * 60_000) / 1000);
  const startTs = Math.floor((windowOpenMs - 15 * 60_000) / 1000);

  const tokenMap = new Map<string, string>();
  for (const market of event.markets) {
    const bracket = titleToBracket(market.groupItemTitle ?? '', city);
    const tokenId = parseYesTokenId(market);
    if (bracket && tokenId) tokenMap.set(bracket, tokenId);
  }
  if (!tokenMap.size) return null;

  const histSeries = await fetchHistoricalDailySeries(city, marketDate, 'ecmwf_ifs025').catch(() => new Map<string, number[]>());
  const temps = histSeries.get(marketDate) ?? [];
  if (!temps.length) return null;

  const priceMap = await fetchHistoricalPrices([...tokenMap.values()], startTs, endTs).catch(() => new Map<string, number | null>());
  const marketProbs = Object.fromEntries(
    [...tokenMap.entries()]
      .map(([bracket, tokenId]) => [bracket, priceMap.get(tokenId) ?? 0])
  );

  const dynamicCity = (() => {
    let minBracket = city.minBracket;
    let maxBracket = city.maxBracket;
    for (const market of event.markets ?? []) {
      const title = market.groupItemTitle ?? '';
      const below = title.match(/^(-?\d+)°C or below$/);
      const above = title.match(/^(-?\d+)°C or higher$/);
      if (below) minBracket = Number(below[1]);
      if (above) maxBracket = Number(above[1]);
    }
    return { ...city, minBracket, maxBracket };
  })();

  const modelProbs = computeBracketProbabilities(temps, dynamicCity, 0);
  const rawSignals = computeBetSignals(modelProbs, marketProbs, dynamicCity, BANKROLL_USD);
  const singleSignals = applySingleMarketKellyRecommendation(rawSignals);
  const bestSingle = singleSignals.find(signal => signal.action === 'BUY') ?? null;
  const bestBasket = bestSingle ? findBestTwoBracketBasket(rawSignals, BANKROLL_USD, bestSingle.suggestedUsd) : null;

  const single = bestSingle ? {
    bracket: bestSingle.bracket,
    label: bestSingle.label,
    modelProb: bestSingle.modelProb,
    marketPrice: bestSingle.marketPrice,
    stakeUsd: bestSingle.suggestedUsd,
    expectedLogGrowth: expectedLogGrowthForSingle(bestSingle, BANKROLL_USD),
    pnlUsd: payoutForSingle(bestSingle.suggestedUsd, bestSingle.marketPrice, bestSingle.bracket, actualBracket),
  } : null;

  const basket = bestBasket ? {
    brackets: bestBasket.brackets,
    labels: bestBasket.labels,
    marketPrices: bestBasket.marketPrices,
    stakeUsd: bestBasket.stakeUsd,
    profitProbability: bestBasket.profitProbability,
    expectedLogGrowth: bestBasket.expectedLogGrowth,
    pnlUsd: payoutForBasket(bestBasket.stakeUsd, bestBasket.marketPrices, bestBasket.brackets, actualBracket),
  } : null;

  let decision: MarketBacktestRow['decision'] = 'none';
  if (single && basket && basket.expectedLogGrowth > single.expectedLogGrowth) decision = 'basket';
  else if (single) decision = 'single';
  else if (basket) decision = 'basket';

  const winner: MarketBacktestRow['winner'] =
    single && basket
      ? (basket.pnlUsd > single.pnlUsd ? 'basket' : single.pnlUsd > basket.pnlUsd ? 'single' : 'tie')
      : single ? 'single'
      : basket ? 'basket'
      : 'none';

  return {
    city: city.name,
    marketDate,
    eventSlug,
    actualBracket,
    windowOpenUtc: new Date(windowOpenMs).toISOString(),
    single,
    basket,
    decision,
    winner,
  };
}

async function main(): Promise<void> {
  const endDate = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - LOOKBACK_DAYS + 1);
  const startDate = start.toISOString().slice(0, 10);

  const rows: MarketBacktestRow[] = [];
  for (const cityId of FORWARD_TEST_CITY_IDS) {
    const city = CITIES[cityId];
    if (!city) continue;
    for (const marketDate of dateRangeUtcInclusive(startDate, endDate)) {
      const dayEnd = cityDayEndUtcMs(marketDate, city.timezone);
      if (dayEnd >= Date.now()) continue;
      const row = await analyzeMarket(city, marketDate).catch(() => null);
      if (row) rows.push(row);
    }
  }

  const rowsWithSingle = rows.filter(row => row.single);
  const rowsWithBasket = rows.filter(row => row.basket);
  const both = rows.filter(row => row.single && row.basket);
  const basketBetterExAnte = both.filter(row => (row.basket?.expectedLogGrowth ?? Number.NEGATIVE_INFINITY) > (row.single?.expectedLogGrowth ?? Number.NEGATIVE_INFINITY));

  const summary = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    startDate,
    endDate,
    cities: FORWARD_TEST_CITY_IDS.length,
    resolvedMarketsAnalyzed: rows.length,
    marketsWithSingle: rowsWithSingle.length,
    marketsWithBasket: rowsWithBasket.length,
    marketsWithBoth: both.length,
    basketBetterExAnte: basketBetterExAnte.length,
    realized: {
      singlePnlUsd: rowsWithSingle.reduce((sum, row) => sum + (row.single?.pnlUsd ?? 0), 0),
      basketPnlUsd: rowsWithBasket.reduce((sum, row) => sum + (row.basket?.pnlUsd ?? 0), 0),
      basketBetterWins: basketBetterExAnte.filter(row => (row.basket?.pnlUsd ?? 0) > (row.single?.pnlUsd ?? 0)).length,
      basketBetterLosses: basketBetterExAnte.filter(row => (row.basket?.pnlUsd ?? 0) < (row.single?.pnlUsd ?? 0)).length,
      basketBetterTies: basketBetterExAnte.filter(row => (row.basket?.pnlUsd ?? 0) === (row.single?.pnlUsd ?? 0)).length,
    },
    examples: basketBetterExAnte.slice(0, 20),
  };

  mkdirSync('data', { recursive: true });
  writeFileSync('data/weather_two_bracket_backtest.json', JSON.stringify(summary, null, 2), 'utf8');

  console.log(`Analyzed ${rows.length} resolved city-date markets from ${startDate} to ${endDate}.`);
  console.log(`Single trades: ${rowsWithSingle.length} | Basket candidates: ${rowsWithBasket.length} | Basket better ex-ante: ${basketBetterExAnte.length}`);
  console.log(`Realized P&L — single: $${summary.realized.singlePnlUsd.toFixed(2)} | basket: $${summary.realized.basketPnlUsd.toFixed(2)}`);
  console.log('Report → data/weather_two_bracket_backtest.json');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
